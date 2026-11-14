import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "@emulators/core";
import { Store } from "@emulators/core";
import { WebhookDispatcher } from "@emulators/core";
import { authMiddleware, createApiErrorHandler, createErrorHandler, type TokenMap } from "@emulators/core";
import { githubPlugin, seedFromConfig, getGitHubStore, type GitHubSeedConfig } from "../index.js";

const base = "http://localhost:4000";

function createTestApp(seedConfig?: GitHubSeedConfig) {
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
      const ghApp = getGitHubStore(store).apps.findOneBy("app_id", appId);
      return ghApp ? { privateKey: ghApp.private_key, slug: ghApp.slug, name: ghApp.name } : null;
    }),
  );
  githubPlugin.register(app as any, store, webhooks, base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(
    store,
    base,
    seedConfig ?? {
      users: [{ login: "octocat" }],
      repos: [{ owner: "octocat", name: "hello-world" }],
    },
  );

  return { app, store, webhooks };
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
    app = createTestApp().app;
  });

  it("retains paginated commit-status history and enforces repository access", async () => {
    const branch = await app.request(`${base}/repos/octocat/hello-world/branches/main`, {
      headers: authHeaders(),
    });
    const { commit } = (await branch.json()) as { commit: { sha: string } };
    const path = `${base}/repos/octocat/hello-world`;
    const ref = await app.request(`${path}/git/refs`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ ref: "refs/heads/status/nested", sha: commit.sha }),
    });
    expect(ref.status).toBe(201);
    for (const state of ["pending", "failure", "success"]) {
      const response = await app.request(`${path}/statuses/${commit.sha}`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ state, context: "ci", target_url: "https://ci.example.com" }),
      });
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        state,
        context: "ci",
        target_url: "https://ci.example.com",
        creator: { login: "octocat" },
      });
    }
    const first = await app.request(`${path}/commits/status/nested/statuses?per_page=2`, {
      headers: authHeaders(),
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("link")).toContain('rel="next"');
    expect(await first.json()).toMatchObject([{ state: "success" }, { state: "failure" }]);
    const last = await app.request(`${path}/commits/${commit.sha}/statuses?per_page=2&page=2`, {
      headers: authHeaders(),
    });
    expect(await last.json()).toMatchObject([{ state: "pending" }]);
    const invalid = await app.request(`${path}/statuses/${commit.sha}`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ state: "completed" }),
    });
    expect(invalid.status).toBe(422);
    const anonymous = await app.request(`${path}/statuses/${commit.sha}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "success" }),
    });
    expect(anonymous.status).toBe(401);
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

  it("paginates all check runs in descending order with navigable links", async () => {
    const repoUrl = `${base}/repos/octocat/hello-world`;
    const commits = await app.request(`${repoUrl}/commits`, { headers: authHeaders() });
    const [head] = (await commits.json()) as Array<{ sha: string }>;
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const created = await app.request(`${repoUrl}/check-runs`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ name: "CI", head_sha: head.sha }),
      });
      expect(created.status).toBe(201);
      ids.unshift(((await created.json()) as { id: number }).id);
    }

    const listUrl = `${repoUrl}/commits/${head.sha}/check-runs?filter=all&per_page=1`;
    for (const [index, id] of ids.entries()) {
      const page = index + 1;
      const response = await app.request(`${listUrl}&page=${page}`, { headers: authHeaders() });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ total_count: 3, check_runs: [{ id }] });
      const link = response.headers.get("Link");
      if (page < 3) {
        expect(link).toContain(`<${listUrl}&page=${page + 1}>; rel="next"`);
        expect(link).toContain(`<${listUrl}&page=3>; rel="last"`);
      } else {
        expect(link).not.toContain('rel="next"');
      }
      if (page > 1) {
        expect(link).toContain(`<${listUrl}&page=1>; rel="first"`);
        expect(link).toContain(`<${listUrl}&page=${page - 1}>; rel="prev"`);
      } else {
        expect(link).not.toContain('rel="prev"');
      }
    }
    const beyondLast = await app.request(`${listUrl}&page=4`, { headers: authHeaders() });
    expect(await beyondLast.json()).toEqual({ total_count: 3, check_runs: [] });
  });

  it("applies name and status filters before counting and paginating", async () => {
    const repoUrl = `${base}/repos/octocat/hello-world`;
    const commits = await app.request(`${repoUrl}/commits`, { headers: authHeaders() });
    const [head] = (await commits.json()) as Array<{ sha: string }>;
    const ids: number[] = [];
    for (const body of [
      { name: "Build CI", status: "completed", conclusion: "success" },
      { name: "Build CI", status: "completed", conclusion: "failure" },
      { name: "Build CI", status: "queued" },
      { name: "Lint", status: "completed", conclusion: "success" },
    ]) {
      const created = await app.request(`${repoUrl}/check-runs`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ head_sha: head.sha, ...body }),
      });
      expect(created.status).toBe(201);
      ids.push(((await created.json()) as { id: number }).id);
    }

    const first = await app.request(
      `${repoUrl}/commits/main/check-runs?check_name=Build%20CI&status=completed&filter=all&per_page=1`,
      { headers: authHeaders() },
    );
    expect(await first.json()).toMatchObject({ total_count: 2, check_runs: [{ id: ids[1] }] });
    const nextUrl = first.headers.get("Link")?.match(/<([^>]+)>; rel="next"/)?.[1];
    expect(nextUrl).toBeDefined();
    expect(Object.fromEntries(new URL(nextUrl!).searchParams)).toEqual({
      check_name: "Build CI",
      status: "completed",
      filter: "all",
      per_page: "1",
      page: "2",
    });
    const second = await app.request(nextUrl!, { headers: authHeaders() });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ total_count: 2, check_runs: [{ id: ids[0] }] });
    expect(second.headers.get("Link")).not.toContain('rel="next"');

    const empty = await app.request(`${repoUrl}/commits/main/check-runs?check_name=missing&filter=all&per_page=1`, {
      headers: authHeaders(),
    });
    expect(await empty.json()).toEqual({ total_count: 0, check_runs: [] });
    expect(empty.headers.get("Link")).toBeNull();
  });

  it("uses the shared default page size and caps per_page at 100", async () => {
    const repoUrl = `${base}/repos/octocat/hello-world`;
    const commits = await app.request(`${repoUrl}/commits`, { headers: authHeaders() });
    const [head] = (await commits.json()) as Array<{ sha: string }>;
    for (let i = 0; i < 101; i++) {
      const created = await app.request(`${repoUrl}/check-runs`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ name: "CI", head_sha: head.sha }),
      });
      expect(created.status).toBe(201);
    }

    for (const [query, size] of [
      ["", 30],
      ["&per_page=200", 100],
    ] as const) {
      const response = await app.request(`${repoUrl}/commits/main/check-runs?filter=all${query}`, {
        headers: authHeaders(),
      });
      const body = (await response.json()) as { total_count: number; check_runs: unknown[] };
      expect(body.total_count).toBe(101);
      expect(body.check_runs).toHaveLength(size);
      const nextUrl = response.headers.get("Link")?.match(/<([^>]+)>; rel="next"/)?.[1];
      expect(nextUrl).toBeDefined();
      expect(new URL(nextUrl!).searchParams.get("per_page")).toBe(String(size));
    }
  });
});

type CheckApp = { id: number; slug: string; name: string } | null;
type CheckRun = { id: number; head_sha: string; app: CheckApp; check_suite: { id: number } };
type CheckSuite = { id: number; app: CheckApp; status: string; conclusion: string | null };

describe("GitHub checks App attribution", () => {
  let privateKey: string;
  let app: Hono;
  let webhooks: WebhookDispatcher;
  let headSha: string;
  let tokenA: string;
  let tokenB: string;
  const repoUrl = `${base}/repos/octocat/hello-world`;
  const appA = { id: 101, slug: "first-app", name: "First App" };
  const appB = { id: 202, slug: "second-app", name: "Second App" };

  beforeAll(() => {
    privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs1", format: "pem" })
      .toString();
  });

  async function mintToken(appId: number, permissions?: Record<string, string>) {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = [
      { alg: "RS256", typ: "JWT" },
      { iss: String(appId), iat: now - 60, exp: now + 540 },
    ]
      .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
      .join(".");
    const jwt = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
    const response = await app.request(`${base}/app/installations/${appId + 1000}/access_tokens`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify(permissions ? { permissions } : {}),
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { token: string }).token;
  }

  function headers(token: string) {
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  }

  async function createRun(token: string, body: Record<string, unknown> = {}) {
    const response = await app.request(`${repoUrl}/check-runs`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ name: "CI", head_sha: headSha, ...body }),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as CheckRun;
  }

  async function createSuite(token: string) {
    const response = await app.request(`${repoUrl}/check-suites`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ head_sha: headSha }),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as CheckSuite;
  }

  async function get(path: string) {
    const response = await app.request(`${repoUrl}${path}`, { headers: authHeaders() });
    expect(response.status).toBe(200);
    return response;
  }

  beforeEach(async () => {
    ({ app, webhooks } = createTestApp({
      users: [{ login: "octocat" }],
      repos: [{ owner: "octocat", name: "hello-world", private: true }],
      apps: [appA, appB].map((entry) => ({
        app_id: entry.id,
        slug: entry.slug,
        name: entry.name,
        private_key: privateKey,
        webhook_secret: "example-app-secret",
        permissions: { checks: "write" },
        installations: [{ installation_id: entry.id + 1000, account: "octocat" }],
      })),
    }));
    vi.spyOn(webhooks, "dispatch").mockResolvedValue();
    tokenA = await mintToken(appA.id);
    tokenB = await mintToken(appB.id);
    const commits = (await (await get("/commits")).json()) as Array<{ sha: string }>;
    headSha = commits[0].sha;
  });

  afterEach(() => vi.restoreAllMocks());

  it("attributes created runs and suites to the authenticated App on all read endpoints", async () => {
    const run = await createRun(tokenA);
    expect(run.app).toMatchObject(appA);
    const read = await get(`/check-runs/${run.id}`);
    expect(await read.json()).toMatchObject({ app: appA });
    const suite = await get(`/check-suites/${run.check_suite.id}`);
    expect(await suite.json()).toMatchObject({ app: appA });
    for (const path of ["/commits/main/check-runs", `/check-suites/${run.check_suite.id}/check-runs`]) {
      expect(await (await get(path)).json()).toMatchObject({ check_runs: [{ app: appA }] });
    }
    expect(await (await get("/commits/main/check-suites")).json()).toMatchObject({ check_suites: [{ app: appA }] });
    for (const response of [run, await (await get(`/check-suites/${run.check_suite.id}`)).json()]) {
      expect(JSON.stringify(response)).not.toContain("PRIVATE KEY");
      expect(JSON.stringify(response)).not.toContain("example-app-secret");
      expect(response).toHaveProperty("app.permissions.checks", "write");
    }
  });

  it("keeps suites and status rollups separate per App while reusing a suite for the same App", async () => {
    const suiteA = await createSuite(tokenA);
    const suiteB = await createSuite(tokenB);
    expect(suiteA.app).toMatchObject(appA);
    expect(suiteB.app).toMatchObject(appB);
    expect(suiteA.id).not.toBe(suiteB.id);
    const first = await createRun(tokenA, { status: "completed", conclusion: "success" });
    const second = await createRun(tokenB, { status: "completed", conclusion: "failure" });
    const third = await createRun(tokenA, { name: "Lint", status: "completed", conclusion: "success" });
    expect(first.check_suite.id).toBe(suiteA.id);
    expect(second.check_suite.id).toBe(suiteB.id);
    expect(third.check_suite.id).toBe(suiteA.id);
    expect(await (await get(`/check-suites/${suiteA.id}`)).json()).toMatchObject({ conclusion: "success", app: appA });
    expect(await (await get(`/check-suites/${suiteB.id}`)).json()).toMatchObject({ conclusion: "failure", app: appB });
    expect(await (await get("/commits/main/check-suites")).json()).toMatchObject({ total_count: 2 });
  });

  it("lists the latest same-named check for each App", async () => {
    await createRun(tokenA);
    const latestA = await createRun(tokenA);
    const latestB = await createRun(tokenB);
    const response = await get("/commits/main/check-runs");
    expect(await response.json()).toMatchObject({
      total_count: 2,
      check_runs: [
        { id: latestB.id, app: appB },
        { id: latestA.id, app: appA },
      ],
    });
  });

  it.each(["", "&filter=latest"])("groups latest runs per App before paginating (%s)", async (filter) => {
    await createRun(tokenA);
    const latestA = await createRun(tokenA);
    const latestB = await createRun(tokenB);
    for (const [index, run] of [latestB, latestA].entries()) {
      const response = await get(`/commits/main/check-runs?per_page=1&page=${index + 1}${filter}`);
      expect(await response.json()).toMatchObject({
        total_count: 2,
        check_runs: [{ id: run.id, app: run.app }],
      });
    }
    const beyondLast = await get(`/commits/main/check-runs?per_page=1&page=3${filter}`);
    expect(await beyondLast.json()).toEqual({ total_count: 2, check_runs: [] });
  });

  it("keeps App identity through updates, commit changes, and rerequests", async () => {
    const run = await createRun(tokenA, { app_id: appB.id });
    expect(run.app).toMatchObject(appA);
    const updated = await app.request(`${repoUrl}/check-runs/${run.id}`, {
      method: "PATCH",
      headers: headers("test-token"),
      body: JSON.stringify({ head_sha: "b".repeat(40), app_id: appB.id, status: "completed", conclusion: "success" }),
    });
    expect(updated.status).toBe(200);
    const body = (await updated.json()) as CheckRun;
    expect(body.app).toMatchObject(appA);
    expect(body.check_suite.id).not.toBe(run.check_suite.id);
    expect(await (await get(`/check-suites/${body.check_suite.id}`)).json()).toMatchObject({ app: appA });
    const rerequested = await app.request(`${repoUrl}/check-runs/${run.id}/rerequest`, {
      method: "POST",
      headers: headers(tokenA),
    });
    expect(rerequested.status).toBe(201);
    expect(await (await get(`/check-runs/${run.id}`)).json()).toMatchObject({ app: appA, status: "queued" });
  });

  it("leaves user-token checks unattributed and separate from App checks", async () => {
    const appRun = await createRun(tokenA);
    const userRun = await createRun("test-token", { app_id: appA.id });
    expect(userRun.app).toBeNull();
    expect(userRun.check_suite.id).not.toBe(appRun.check_suite.id);
    expect(await (await get(`/check-suites/${userRun.check_suite.id}`)).json()).toMatchObject({ app: null });
    const suite = await createSuite("test-token");
    expect(suite.id).toBe(userRun.check_suite.id);
    expect(suite.app).toBeNull();
  });

  it("includes public App metadata in check webhooks", async () => {
    const run = await createRun(tokenA);
    await createSuite(tokenA);
    expect(webhooks.dispatch).toHaveBeenCalledWith(
      "check_run",
      "created",
      expect.objectContaining({ check_run: expect.objectContaining({ app: expect.objectContaining(appA) }) }),
      "octocat",
      "hello-world",
    );
    expect(webhooks.dispatch).toHaveBeenCalledWith(
      "check_suite",
      "requested",
      expect.objectContaining({
        check_suite: expect.objectContaining({ id: run.check_suite.id, app: expect.objectContaining(appA) }),
      }),
      "octocat",
      "hello-world",
    );
  });

  it("still requires checks write permission", async () => {
    const readToken = await mintToken(appA.id, { checks: "read" });
    const response = await app.request(`${repoUrl}/check-runs`, {
      method: "POST",
      headers: headers(readToken),
      body: JSON.stringify({ name: "CI", head_sha: headSha }),
    });
    expect(response.status).toBe(403);
  });
});
