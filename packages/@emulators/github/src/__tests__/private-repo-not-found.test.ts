import { describe, expect, it } from "vitest";
import {
  Hono,
  Store,
  WebhookDispatcher,
  authMiddleware,
  createApiErrorHandler,
  createErrorHandler,
} from "@emulators/core";
import type { AuthInstallation, TokenMap } from "@emulators/core";
import { githubPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";

const installation: AuthInstallation = {
  installationId: 77,
  appId: 7,
  accountId: 11,
  accountType: "User",
  permissions: { contents: "read", metadata: "read" },
  repositoryIds: [],
  repositorySelection: "all",
};

function createTestApp() {
  const store = new Store();
  const tokenMap: TokenMap = new Map([
    ["owner-token", { login: "owner", id: 1, scopes: ["repo"] }],
    ["outsider-token", { login: "outsider", id: 2, scopes: ["repo"] }],
    ["reader-token", { login: "reader", id: 3, scopes: ["repo"] }],
    ["installation-token", { login: "app[bot]", id: 9, scopes: [], installation }],
  ]);
  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app as any, store, new WebhookDispatcher(), base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "owner" }, { login: "outsider" }, { login: "reader" }],
    repos: [{ owner: "owner", name: "secret", private: true, auto_init: true }],
  });
  return app;
}

function request(app: Hono<any>, path: string, token?: string, init: RequestInit = {}) {
  const headers: Record<string, string> = token
    ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    : {};
  return app.request(`${base}${path}`, { ...init, headers });
}

describe("GitHub private repository visibility", () => {
  it("answers 404 to callers who cannot see the repository", async () => {
    const app = createTestApp();
    expect((await request(app, "/repos/owner/secret", "owner-token")).status).toBe(200);
    expect((await request(app, "/repos/owner/secret", "outsider-token")).status).toBe(404);
    expect((await request(app, "/repos/owner/secret")).status).toBe(404);
    expect((await request(app, "/repos/owner/secret/contents/README.md", "outsider-token")).status).toBe(404);
  });

  it("answers 404 to reads and writes from a user who cannot see the repository", async () => {
    const app = createTestApp();
    const writes: Array<[string, string, unknown]> = [
      ["POST", "/repos/owner/secret/issues", { title: "hidden" }],
      ["POST", "/repos/owner/secret/releases", { tag_name: "v1" }],
      ["PUT", "/repos/owner/secret/contents/a.txt", { message: "m", content: "YQ==" }],
      ["POST", "/repos/owner/secret/hooks", { config: { url: "http://localhost:3000/hook" } }],
    ];
    for (const [method, path, body] of writes) {
      const res = await request(app, path, "outsider-token", { method, body: JSON.stringify(body) });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });

  it("keeps 403 for a collaborator who can see the repository but cannot write to it", async () => {
    const app = createTestApp();
    const invited = await request(app, "/repos/owner/secret/collaborators/reader", "owner-token", {
      method: "PUT",
      body: JSON.stringify({ permission: "pull" }),
    });
    expect(invited.status).toBeLessThan(300);
    expect((await request(app, "/repos/owner/secret", "reader-token")).status).toBe(200);
    expect(
      (
        await request(app, "/repos/owner/secret/contents/a.txt", "reader-token", {
          method: "PUT",
          body: JSON.stringify({ message: "m", content: "YQ==" }),
        })
      ).status,
    ).toBe(403);
  });

  it("keeps the installation error for a repository outside the installation", async () => {
    const app = createTestApp();
    expect((await request(app, "/repos/owner/secret", "installation-token")).status).toBe(403);
  });
});
