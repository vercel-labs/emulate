import { generateKeyPairSync, sign } from "crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "@emulators/core";
import { Store } from "@emulators/core";
import { WebhookDispatcher } from "@emulators/core";
import { authMiddleware, createApiErrorHandler, createErrorHandler, type TokenMap } from "@emulators/core";
import { getGitHubStore, githubPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" })
  .toString();
const apps = [
  { app_id: 15368, slug: "github-actions", name: "GitHub Actions", installationId: 101 },
  { app_id: 3325211, slug: "policy-bot", name: "Policy Bot", installationId: 102 },
];

type CheckRun = { id: number; app: { id: number; slug: string; name: string } | null; check_suite: { id: number } };

async function installationHeaders(app: Hono, index: number): Promise<Record<string, string>> {
  const config = apps[index];
  const now = Math.floor(Date.now() / 1000);
  const unsigned = [
    { alg: "RS256", typ: "JWT" },
    { iat: now - 60, exp: now + 9 * 60, iss: String(config.app_id) },
  ]
    .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
    .join(".");
  const jwt = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
  const response = await app.request(`${base}/app/installations/${config.installationId}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ permissions: { checks: "write" } }),
  });
  expect(response.status).toBe(201);
  const { token } = (await response.json()) as { token: string };
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("test-token", { login: "octocat", id: 1, scopes: ["repo", "user", "admin:org"] });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use(
    "*",
    authMiddleware(tokenMap, (appId) => {
      const config = getGitHubStore(store).apps.findOneBy("app_id", appId);
      return config ? { privateKey: config.private_key, slug: config.slug, name: config.name } : null;
    }),
  );
  githubPlugin.register(app as any, store, webhooks, base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "octocat" }],
    repos: [{ owner: "octocat", name: "hello-world" }],
    apps: apps.map((config) => ({
      app_id: config.app_id,
      slug: config.slug,
      name: config.name,
      private_key: privateKey,
      permissions: { checks: "write" },
      installations: [{ installation_id: config.installationId, account: "octocat", repository_selection: "all" }],
    })),
  });

  return app;
}

function authHeaders(): Record<string, string> {
  return { Authorization: "Bearer test-token" };
}

function jsonHeaders(): Record<string, string> {
  return { ...authHeaders(), "Content-Type": "application/json" };
}

describe("GitHub checks routes", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp();
  });

  it("attributes installation checks to their App and separates suites on the same SHA", async () => {
    const commits = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
    const [head] = (await commits.json()) as Array<{ sha: string }>;
    const headers = await Promise.all(apps.map((_, index) => installationHeaders(app, index)));
    const runs: CheckRun[] = [];
    for (const [index, name] of ["Actions CI", "Policy", "Actions lint", "User check"].entries()) {
      const created = await app.request(`${base}/repos/octocat/hello-world/check-runs`, {
        method: "POST",
        headers: index === 3 ? jsonHeaders() : headers[index === 1 ? 1 : 0],
        body: JSON.stringify({ name, head_sha: head.sha, app_id: apps[1].app_id }),
      });
      expect(created.status).toBe(201);
      runs.push((await created.json()) as CheckRun);
    }
    for (const [index, run] of runs.entries()) {
      const config = apps[index === 1 ? 1 : 0];
      expect(run.app).toEqual(
        index === 3 ? null : expect.objectContaining({ id: config.app_id, slug: config.slug, name: config.name }),
      );
      if (run.app) expect(run.app).not.toHaveProperty("private_key");
      const read = await app.request(`${base}/repos/octocat/hello-world/check-runs/${run.id}`, {
        headers: authHeaders(),
      });
      expect(((await read.json()) as CheckRun).app).toEqual(run.app);
      const suite = await app.request(`${base}/repos/octocat/hello-world/check-suites/${run.check_suite.id}`, {
        headers: authHeaders(),
      });
      expect(((await suite.json()) as { app: CheckRun["app"] }).app).toEqual(run.app);
    }
    expect(runs[0].check_suite.id).toBe(runs[2].check_suite.id);
    expect(new Set(runs.map((run) => run.check_suite.id)).size).toBe(3);

    const listed = await app.request(`${base}/repos/octocat/hello-world/commits/main/check-runs?filter=all`, {
      headers: authHeaders(),
    });
    expect(((await listed.json()) as { check_runs: CheckRun[] }).check_runs.map((run) => run.app)).toEqual(
      runs.map((run) => run.app).reverse(),
    );
    const suites = await app.request(`${base}/repos/octocat/hello-world/commits/main/check-suites`, {
      headers: authHeaders(),
    });
    expect(
      ((await suites.json()) as { check_suites: Array<{ app: CheckRun["app"] }> }).check_suites.map(
        (suite) => suite.app,
      ),
    ).toEqual([null, runs[1].app, runs[0].app]);
    const suiteRuns = await app.request(
      `${base}/repos/octocat/hello-world/check-suites/${runs[0].check_suite.id}/check-runs`,
      { headers: authHeaders() },
    );
    expect(((await suiteRuns.json()) as { check_runs: CheckRun[] }).check_runs.map((run) => run.id)).toEqual([
      runs[2].id,
      runs[0].id,
    ]);
  });

  it("attributes directly created suites and reuses them only for the same App", async () => {
    const commits = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
    const [head] = (await commits.json()) as Array<{ sha: string }>;
    const headers = await Promise.all(apps.map((_, index) => installationHeaders(app, index)));
    const suites: Array<{ id: number; app: CheckRun["app"] }> = [];
    for (const header of [...headers, headers[0], jsonHeaders()]) {
      const created = await app.request(`${base}/repos/octocat/hello-world/check-suites`, {
        method: "POST",
        headers: header,
        body: JSON.stringify({ head_sha: head.sha, app_id: apps[1].app_id }),
      });
      expect(created.status).toBe(201);
      suites.push((await created.json()) as { id: number; app: CheckRun["app"] });
    }
    expect(suites[0].app).toEqual(expect.objectContaining({ id: apps[0].app_id }));
    expect(suites[1].app).toEqual(expect.objectContaining({ id: apps[1].app_id }));
    expect(suites[3].app).toBeNull();
    expect(suites[0].id).toBe(suites[2].id);
    expect(new Set(suites.map((suite) => suite.id)).size).toBe(3);
    const created = await app.request(`${base}/repos/octocat/hello-world/check-runs`, {
      method: "POST",
      headers: headers[0],
      body: JSON.stringify({ name: "CI", head_sha: head.sha }),
    });
    expect(((await created.json()) as CheckRun).check_suite.id).toBe(suites[0].id);
  });

  it("preserves the creating App when updating a run or moving it to another SHA", async () => {
    const headers = await installationHeaders(app, 0);
    const create = async (head_sha: string, requestHeaders: Record<string, string>) => {
      const response = await app.request(`${base}/repos/octocat/hello-world/check-runs`, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({ name: "CI", head_sha }),
      });
      expect(response.status).toBe(201);
      return (await response.json()) as CheckRun;
    };
    const otherAppRun = await create("new-sha", await installationHeaders(app, 1));
    const sameAppRun = await create("new-sha", headers);
    const original = await create("old-sha", headers);
    const updated = await app.request(`${base}/repos/octocat/hello-world/check-runs/${original.id}`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ head_sha: "new-sha", app_id: apps[1].app_id, status: "completed", conclusion: "success" }),
    });
    expect(updated.status).toBe(200);
    const moved = (await updated.json()) as CheckRun;
    expect(moved.app).toEqual(original.app);
    expect(moved.check_suite.id).toBe(sameAppRun.check_suite.id);
    expect(moved.check_suite.id).not.toBe(otherAppRun.check_suite.id);
    const oldSuite = await app.request(`${base}/repos/octocat/hello-world/check-suites/${original.check_suite.id}`, {
      headers: authHeaders(),
    });
    expect(await oldSuite.json()).toEqual(
      expect.objectContaining({ status: "completed", conclusion: null, app: original.app }),
    );
    const userRun = await create("new-sha", jsonHeaders());
    const userUpdated = await app.request(`${base}/repos/octocat/hello-world/check-runs/${userRun.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ app_id: apps[0].app_id, name: "Renamed" }),
    });
    expect(userUpdated.status).toBe(200);
    expect(((await userUpdated.json()) as CheckRun).app).toBeNull();
  });

  it("lists check runs and suites for refs containing slashes", async () => {
    const commits = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
    const [head] = (await commits.json()) as Array<{ sha: string }>;

    const nestedRef = await app.request(`${base}/repos/octocat/hello-world/git/refs`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ ref: "refs/heads/feature/nested", sha: head.sha }),
    });
    expect(nestedRef.status).toBe(201);

    const created = await app.request(`${base}/repos/octocat/hello-world/check-runs`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ name: "CI", head_sha: head.sha, status: "completed", conclusion: "success" }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { id: number; head_sha: string };

    const runsByNestedRef = await app.request(`${base}/repos/octocat/hello-world/commits/feature/nested/check-runs`, {
      headers: authHeaders(),
    });
    expect(runsByNestedRef.status).toBe(200);
    expect(await runsByNestedRef.json()).toEqual(
      expect.objectContaining({
        total_count: 1,
        check_runs: [expect.objectContaining({ id: createdBody.id, head_sha: head.sha })],
      }),
    );

    const suitesByNestedRef = await app.request(
      `${base}/repos/octocat/hello-world/commits/feature/nested/check-suites`,
      { headers: authHeaders() },
    );
    expect(suitesByNestedRef.status).toBe(200);
    expect(await suitesByNestedRef.json()).toEqual(
      expect.objectContaining({
        total_count: 1,
        check_suites: [expect.objectContaining({ head_sha: head.sha })],
      }),
    );

    const runsBySha = await app.request(`${base}/repos/octocat/hello-world/commits/${head.sha}/check-runs`, {
      headers: authHeaders(),
    });
    expect(runsBySha.status).toBe(200);
    expect(((await runsBySha.json()) as { check_runs: Array<{ id: number }> }).check_runs[0].id).toBe(createdBody.id);
  });

  it("preserves check run filters and returns not found for unknown refs", async () => {
    const commits = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
    const [head] = (await commits.json()) as Array<{ sha: string }>;

    for (const body of [
      { name: "CI", head_sha: head.sha, status: "completed", conclusion: "success" },
      { name: "Lint", head_sha: head.sha, status: "in_progress" },
      { name: "CI", head_sha: head.sha, status: "queued" },
    ]) {
      const created = await app.request(`${base}/repos/octocat/hello-world/check-runs`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(body),
      });
      expect(created.status).toBe(201);
    }

    const filtered = await app.request(
      `${base}/repos/octocat/hello-world/commits/main/check-runs?check_name=CI&status=completed`,
      { headers: authHeaders() },
    );
    expect(filtered.status).toBe(200);
    expect(await filtered.json()).toEqual(
      expect.objectContaining({
        total_count: 1,
        check_runs: [expect.objectContaining({ name: "CI", status: "completed" })],
      }),
    );

    const allRuns = await app.request(
      `${base}/repos/octocat/hello-world/commits/main/check-runs?check_name=CI&filter=all`,
      { headers: authHeaders() },
    );
    expect(allRuns.status).toBe(200);
    expect(await allRuns.json()).toEqual(
      expect.objectContaining({
        total_count: 2,
        check_runs: [
          expect.objectContaining({ name: "CI", status: "queued" }),
          expect.objectContaining({ name: "CI", status: "completed" }),
        ],
      }),
    );

    const missingRuns = await app.request(`${base}/repos/octocat/hello-world/commits/missing/ref/check-runs`, {
      headers: authHeaders(),
    });
    expect(missingRuns.status).toBe(404);

    const missingSuites = await app.request(`${base}/repos/octocat/hello-world/commits/missing/ref/check-suites`, {
      headers: authHeaders(),
    });
    expect(missingSuites.status).toBe(404);
  });
});
