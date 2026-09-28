import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  app.use("*", async (c, next) => {
    if (c.req.header("Authorization") === "Bearer test-app-jwt") {
      c.set("authApp", { appId: 9, slug: "status-app", name: "Status App" });
    }
    await next();
  });
  githubPlugin.register(app as any, store, webhooks, base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "octocat" }],
    repos: [{ owner: "octocat", name: "hello-world" }],
    apps: [
      {
        app_id: 9,
        slug: "status-app",
        name: "Status App",
        private_key: "test-key",
        permissions: { statuses: "write", contents: "read" },
        installations: [
          { installation_id: 51, account: "octocat", permissions: { statuses: "read", contents: "read" } },
          { installation_id: 52, account: "octocat", permissions: { statuses: "write", contents: "read" } },
        ],
      },
    ],
  });

  return { app, webhooks };
}

function authHeaders(token = "test-token"): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function jsonHeaders(token = "test-token"): Record<string, string> {
  return { ...authHeaders(token), "Content-Type": "application/json" };
}

async function headSha(app: Hono): Promise<string> {
  const response = await app.request(`${base}/repos/octocat/hello-world/commits/main`, { headers: authHeaders() });
  return ((await response.json()) as { sha: string }).sha;
}

async function createStatus(app: Hono, sha: string, body: Record<string, unknown>, token = "test-token") {
  return app.request(`${base}/repos/octocat/hello-world/statuses/${sha}`, {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify(body),
  });
}

async function combinedStatus(app: Hono, ref: string) {
  const response = await app.request(`${base}/repos/octocat/hello-world/commits/${ref}/status`, {
    headers: authHeaders(),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    state: string;
    sha: string;
    total_count: number;
    statuses: Array<{ context: string; state: string }>;
    repository: { full_name: string };
    commit_url: string;
    url: string;
  };
}

async function issueInstallationToken(app: Hono, installationId: number): Promise<string> {
  const response = await app.request(`${base}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: jsonHeaders("test-app-jwt"),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { token: string }).token;
}

describe("GitHub commit statuses", () => {
  let app: Hono;
  let webhooks: WebhookDispatcher;

  beforeEach(() => {
    ({ app, webhooks } = createTestApp());
  });

  it("creates a status and returns GitHub's status object", async () => {
    const sha = await headSha(app);
    const response = await createStatus(app, sha, {
      state: "success",
      target_url: "https://ci.example/builds/1",
      description: "Build passed",
      context: "ci/build",
    });
    expect(response.status).toBe(201);
    const status = (await response.json()) as Record<string, unknown>;
    expect(status).toEqual(
      expect.objectContaining({
        id: expect.any(Number),
        node_id: expect.any(String),
        url: `${base}/repos/octocat/hello-world/statuses/${sha}`,
        avatar_url: `${base}/avatars/u/octocat`,
        state: "success",
        target_url: "https://ci.example/builds/1",
        description: "Build passed",
        context: "ci/build",
        created_at: expect.any(String),
        updated_at: expect.any(String),
        creator: expect.objectContaining({ login: "octocat" }),
      }),
    );
    expect(status.node_id).not.toBe("");

    const minimal = await createStatus(app, sha.slice(0, 10), { state: "pending" });
    expect(minimal.status).toBe(201);
    expect(await minimal.json()).toEqual(
      expect.objectContaining({ context: "default", target_url: null, description: null, state: "pending" }),
    );
  });

  it("validates state, sha, target_url, and description", async () => {
    const sha = await headSha(app);
    const message = async (response: Response) => ((await response.json()) as { message: string }).message;

    const invalidState = await createStatus(app, sha, { state: "great" });
    expect(invalidState.status).toBe(422);
    expect(await message(invalidState)).toBe("state is not included in the list");
    expect((await createStatus(app, sha, {})).status).toBe(422);

    const unknownSha = await createStatus(app, "deadbeef", { state: "success" });
    expect(unknownSha.status).toBe(422);
    expect(await message(unknownSha)).toBe("No commit found for SHA: deadbeef");
    expect((await createStatus(app, "main", { state: "success" })).status).toBe(422);

    const badUrl = await createStatus(app, sha, { state: "success", target_url: "not a url" });
    expect(badUrl.status).toBe(422);
    expect(await message(badUrl)).toBe("target_url must be a valid URL");

    const longDescription = await createStatus(app, sha, { state: "success", description: "x".repeat(141) });
    expect(longDescription.status).toBe(422);
    expect(await message(longDescription)).toBe("description is too long (maximum is 140 characters)");
    expect((await createStatus(app, sha, { state: "success", description: "x".repeat(140) })).status).toBe(201);

    const emptyContext = await createStatus(app, sha, { state: "success", context: "" });
    expect(emptyContext.status).toBe(422);

    const list = await app.request(`${base}/repos/octocat/hello-world/commits/${sha}/statuses`, {
      headers: authHeaders(),
    });
    expect(((await list.json()) as unknown[]).length).toBe(1);
  });

  it("lists statuses newest first for branch, sha, and nested refs with pagination", async () => {
    const sha = await headSha(app);
    const nested = await app.request(`${base}/repos/octocat/hello-world/git/refs`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ ref: "refs/heads/feature/nested", sha }),
    });
    expect(nested.status).toBe(201);

    const ids: number[] = [];
    for (const [context, state] of [
      ["ci/build", "pending"],
      ["ci/lint", "success"],
      ["ci/build", "success"],
    ]) {
      const response = await createStatus(app, sha, { state, context });
      expect(response.status).toBe(201);
      ids.push(((await response.json()) as { id: number }).id);
    }

    const listed = await app.request(`${base}/repos/octocat/hello-world/commits/main/statuses`, {
      headers: authHeaders(),
    });
    expect(listed.status).toBe(200);
    const statuses = (await listed.json()) as Array<{ id: number; context: string; state: string }>;
    expect(statuses.map((status) => status.id)).toEqual([...ids].reverse());
    expect(statuses[0]).toEqual(expect.objectContaining({ context: "ci/build", state: "success" }));

    const bySha = await app.request(`${base}/repos/octocat/hello-world/commits/${sha}/statuses`, {
      headers: authHeaders(),
    });
    expect(((await bySha.json()) as Array<{ id: number }>).map((status) => status.id)).toEqual([...ids].reverse());
    const byNestedRef = await app.request(`${base}/repos/octocat/hello-world/commits/feature/nested/statuses`, {
      headers: authHeaders(),
    });
    expect(byNestedRef.status).toBe(200);
    expect(((await byNestedRef.json()) as unknown[]).length).toBe(3);

    const paged = await app.request(`${base}/repos/octocat/hello-world/commits/main/statuses?per_page=2`, {
      headers: authHeaders(),
    });
    expect(((await paged.json()) as unknown[]).length).toBe(2);
    expect(paged.headers.get("Link")).toContain('rel="next"');
    const lastPage = await app.request(`${base}/repos/octocat/hello-world/commits/main/statuses?per_page=2&page=2`, {
      headers: authHeaders(),
    });
    expect(((await lastPage.json()) as Array<{ id: number }>).map((status) => status.id)).toEqual([ids[0]]);

    const missing = await app.request(`${base}/repos/octocat/hello-world/commits/nope/statuses`, {
      headers: authHeaders(),
    });
    expect(missing.status).toBe(404);
  });

  it("computes the combined status from the latest status per context", async () => {
    const sha = await headSha(app);
    const empty = await combinedStatus(app, "main");
    expect(empty).toEqual(
      expect.objectContaining({
        state: "pending",
        sha,
        total_count: 0,
        statuses: [],
        repository: expect.objectContaining({ full_name: "octocat/hello-world" }),
        commit_url: `${base}/repos/octocat/hello-world/commits/${sha}`,
        url: `${base}/repos/octocat/hello-world/commits/${sha}/status`,
      }),
    );

    await createStatus(app, sha, { state: "pending", context: "ci/build" });
    expect((await combinedStatus(app, "main")).state).toBe("pending");

    await createStatus(app, sha, { state: "success", context: "ci/build" });
    const single = await combinedStatus(app, sha);
    expect(single.state).toBe("success");
    expect(single.total_count).toBe(1);
    expect(single.statuses).toEqual([expect.objectContaining({ context: "ci/build", state: "success" })]);

    await createStatus(app, sha, { state: "failure", context: "ci/lint" });
    expect((await combinedStatus(app, "main")).state).toBe("failure");

    await createStatus(app, sha, { state: "success", context: "ci/lint" });
    expect((await combinedStatus(app, "main")).state).toBe("success");

    await createStatus(app, sha, { state: "error", context: "deploy" });
    await createStatus(app, sha, { state: "pending", context: "ci/build" });
    const mixed = await combinedStatus(app, "main");
    expect(mixed.state).toBe("failure");
    expect(mixed.total_count).toBe(3);
    expect(mixed.statuses.map((status) => [status.context, status.state])).toEqual([
      ["ci/build", "pending"],
      ["deploy", "error"],
      ["ci/lint", "success"],
    ]);
  });

  describe("webhooks", () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    beforeEach(() => {
      mockFetch.mockClear();
      vi.stubGlobal("fetch", mockFetch);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("dispatches a status event when a status is created", async () => {
      const sha = await headSha(app);
      webhooks.register({
        url: "https://hooks.example/status",
        events: ["status"],
        active: true,
        owner: "octocat",
        repo: "hello-world",
      });

      const response = await createStatus(app, sha, {
        state: "failure",
        context: "ci/build",
        description: "Tests failed",
        target_url: "https://ci.example/builds/2",
      });
      expect(response.status).toBe(201);
      const status = (await response.json()) as { id: number };

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe("https://hooks.example/status");
      expect((init as RequestInit).headers).toEqual(expect.objectContaining({ "X-GitHub-Event": "status" }));
      const payload = JSON.parse((init as RequestInit).body as string);
      expect(payload).toEqual(
        expect.objectContaining({
          id: status.id,
          sha,
          name: "octocat/hello-world",
          state: "failure",
          context: "ci/build",
          description: "Tests failed",
          target_url: "https://ci.example/builds/2",
          commit: expect.objectContaining({ sha }),
          branches: [expect.objectContaining({ name: "main", commit: expect.objectContaining({ sha }) })],
          repository: expect.objectContaining({ full_name: "octocat/hello-world" }),
          sender: expect.objectContaining({ login: "octocat" }),
        }),
      );
    });
  });

  it("enforces installation statuses permissions", async () => {
    const sha = await headSha(app);
    const readerToken = await issueInstallationToken(app, 51);
    const writerToken = await issueInstallationToken(app, 52);

    expect((await createStatus(app, sha, { state: "success" }, readerToken)).status).toBe(403);
    const written = await createStatus(app, sha, { state: "success", context: "app" }, writerToken);
    expect(written.status).toBe(201);
    expect(await written.json()).toEqual(
      expect.objectContaining({ creator: expect.objectContaining({ login: "status-app[bot]", type: "Bot" }) }),
    );

    const listed = await app.request(`${base}/repos/octocat/hello-world/commits/main/statuses`, {
      headers: authHeaders(readerToken),
    });
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as unknown[]).length).toBe(1);
  });
});
