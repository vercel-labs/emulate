import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "@emulators/core";
import { Store } from "@emulators/core";
import { WebhookDispatcher } from "@emulators/core";
import { authMiddleware, createApiErrorHandler, createErrorHandler, type TokenMap } from "@emulators/core";
import { githubPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("test-token", { login: "octocat", id: 1, scopes: ["repo", "user", "admin:org"] });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app as any, store, webhooks, base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "octocat" }],
    repos: [{ owner: "octocat", name: "hello-world" }],
  });

  return app;
}

function authHeaders(): Record<string, string> {
  return { Authorization: "Bearer test-token" };
}

function jsonHeaders(): Record<string, string> {
  return { ...authHeaders(), "Content-Type": "application/json" };
}

async function createCheckRuns(app: Hono, runs: Array<{ name: string; status: string }>) {
  const commits = await app.request(`${base}/repos/octocat/hello-world/commits`, { headers: authHeaders() });
  const [head] = (await commits.json()) as Array<{ sha: string }>;
  const ids: number[] = [];
  for (const run of runs) {
    const response = await app.request(`${base}/repos/octocat/hello-world/check-runs`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        ...run,
        head_sha: head.sha,
        ...(run.status === "completed" ? { conclusion: "success" } : {}),
      }),
    });
    expect(response.status).toBe(201);
    ids.push(((await response.json()) as { id: number }).id);
  }
  return ids;
}

describe("GitHub checks routes", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp();
  });

  it("paginates filtered check runs and preserves filters in pagination links", async () => {
    const ids = await createCheckRuns(app, [
      { name: "CI", status: "completed" },
      { name: "CI", status: "queued" },
      { name: "CI", status: "completed" },
      { name: "Lint", status: "completed" },
      { name: "CI", status: "completed" },
    ]);
    const url = `${base}/repos/octocat/hello-world/commits/main/check-runs?check_name=CI&status=completed&filter=all&per_page=2`;
    const first = await app.request(url, { headers: authHeaders() });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(
      expect.objectContaining({
        total_count: 3,
        check_runs: [expect.objectContaining({ id: ids[4] }), expect.objectContaining({ id: ids[2] })],
      }),
    );
    const next = first.headers.get("Link")?.match(/<([^>]+)>; rel="next"/)?.[1];
    expect(next).toBeDefined();
    const nextUrl = new URL(next!);
    expect(nextUrl.pathname).toBe("/repos/octocat/hello-world/commits/main/check-runs");
    expect(Object.fromEntries(nextUrl.searchParams)).toEqual({
      check_name: "CI",
      status: "completed",
      filter: "all",
      per_page: "2",
      page: "2",
    });
    expect(first.headers.get("Link")).toContain('rel="last"');

    const last = await app.request(next!, { headers: authHeaders() });
    expect(last.status).toBe(200);
    expect(await last.json()).toEqual(
      expect.objectContaining({ total_count: 3, check_runs: [expect.objectContaining({ id: ids[0] })] }),
    );
    expect(last.headers.get("Link")).not.toContain('rel="next"');
    expect(last.headers.get("Link")).toContain('rel="prev"');
    expect(last.headers.get("Link")).toContain('rel="first"');

    nextUrl.searchParams.set("page", "3");
    const beyondLast = await app.request(nextUrl.toString(), { headers: authHeaders() });
    expect(beyondLast.status).toBe(200);
    expect(await beyondLast.json()).toEqual({ total_count: 3, check_runs: [] });
    expect(beyondLast.headers.get("Link")).not.toContain('rel="next"');

    nextUrl.searchParams.set("page", "1");
    nextUrl.searchParams.set("check_name", "missing");
    const empty = await app.request(nextUrl.toString(), { headers: authHeaders() });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ total_count: 0, check_runs: [] });
    expect(empty.headers.get("Link")).toBeNull();
  });

  it("applies the default latest filter before counting and paginating check runs", async () => {
    const ids = await createCheckRuns(app, [
      { name: "CI", status: "completed" },
      { name: "Lint", status: "completed" },
      { name: "CI", status: "completed" },
      { name: "Build", status: "completed" },
      { name: "CI", status: "queued" },
    ]);
    const first = await app.request(`${base}/repos/octocat/hello-world/commits/main/check-runs?per_page=2`, {
      headers: authHeaders(),
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(
      expect.objectContaining({
        total_count: 3,
        check_runs: [expect.objectContaining({ id: ids[4] }), expect.objectContaining({ id: ids[3] })],
      }),
    );
    const next = first.headers.get("Link")?.match(/<([^>]+)>; rel="next"/)?.[1];
    expect(next).toBeDefined();
    const last = await app.request(next!, { headers: authHeaders() });
    expect(last.status).toBe(200);
    expect(await last.json()).toEqual(
      expect.objectContaining({ total_count: 3, check_runs: [expect.objectContaining({ id: ids[1] })] }),
    );
    expect(last.headers.get("Link")).not.toContain('rel="next"');
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
