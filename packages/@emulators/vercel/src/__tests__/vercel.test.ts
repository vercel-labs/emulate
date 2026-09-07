import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "@emulators/core";
import { Store, WebhookDispatcher, authMiddleware, type TokenMap } from "@emulators/core";
import { vercelPlugin, seedFromConfig, getVercelStore } from "../index.js";

const base = "http://localhost:4000";

type CreatedDeployment = { uid: string };

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("test-token", { login: "testuser", id: 1, scopes: ["user"] });

  const app = new Hono();
  app.use("*", authMiddleware(tokenMap));
  vercelPlugin.register(app as any, store, webhooks, base, tokenMap);
  vercelPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ username: "testuser", email: "testuser@example.com" }],
  });

  return { app, store, webhooks, tokenMap };
}

function authHeaders(): Record<string, string> {
  return { Authorization: "Bearer test-token" };
}

describe("Vercel plugin integration", () => {
  let app: Hono;
  let store: Store;

  beforeEach(() => {
    ({ app, store } = createTestApp());
  });

  async function createDeployment(
    body: {
      name: string;
      meta?: Record<string, string>;
      gitSource?: { type: string; ref: string; sha: string };
    },
    teamId?: string,
  ): Promise<CreatedDeployment> {
    const query = teamId ? `?teamId=${teamId}` : "";
    const response = await app.request(`${base}/v13/deployments${query}`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as CreatedDeployment;
  }

  it("GET /v2/user returns the current user", async () => {
    const res = await app.request(`${base}/v2/user`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { username: string; email: string } };
    expect(body.user).toBeDefined();
    expect(body.user.username).toBe("testuser");
    expect(body.user.email).toBe("testuser@example.com");
  });

  it("GET /v10/projects lists projects for the authenticated account", async () => {
    const res = await app.request(`${base}/v10/projects`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: unknown[]; pagination: unknown };
    expect(Array.isArray(body.projects)).toBe(true);
    expect(body.pagination).toBeDefined();
  });

  it("POST /v11/projects creates a project", async () => {
    const name = `it-project-${Date.now()}`;
    const res = await app.request(`${base}/v11/projects`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    expect([200, 201]).toContain(res.status);
    const body = (await res.json()) as { name: string; id: string };
    expect(body.name).toBe(name);
    expect(body.id).toBeDefined();
  });

  it("GET /v6/deployments returns deployments for the account", async () => {
    const res = await app.request(`${base}/v6/deployments`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deployments: unknown[]; pagination: unknown };
    expect(Array.isArray(body.deployments)).toBe(true);
    expect(body.pagination).toBeDefined();
  });

  it("GET /v7/deployments requires authentication", async () => {
    seedFromConfig(store, base, { teams: [{ slug: "first-team" }] });
    const team = getVercelStore(store).teams.findOneBy("slug", "first-team")!;
    for (const query of ["", `?teamId=${team.uid}`, `?slug=${team.slug}`]) {
      const response = await app.request(`${base}/v7/deployments${query}`);
      expect(response.status).toBe(401);
    }
  });

  it("GET /v7/deployments finds a team's commit previews across projects", async () => {
    seedFromConfig(store, base, { teams: [{ slug: "first-team" }, { slug: "other-team" }] });
    const vs = getVercelStore(store);
    const team = vs.teams.findOneBy("slug", "first-team")!;
    const otherTeam = vs.teams.findOneBy("slug", "other-team")!;
    const first = await createDeployment({ name: "website", meta: { githubCommitSha: "commit-sha" } }, team.uid);
    const second = await createDeployment(
      { name: "api", gitSource: { type: "github", ref: "main", sha: "commit-sha" } },
      team.uid,
    );
    await createDeployment({ name: "website", meta: { githubCommitSha: "other-sha" } }, team.uid);
    await createDeployment({ name: "without-git-metadata" }, team.uid);
    await createDeployment({ name: "other-team", meta: { githubCommitSha: "commit-sha" } }, otherTeam.uid);
    await createDeployment({ name: "personal", meta: { githubCommitSha: "commit-sha" } });

    const response = await app.request(`${base}/v7/deployments?sha=commit-sha&teamId=${team.uid}`, {
      headers: authHeaders(),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { deployments: { uid: string }[] };
    expect(body.deployments.map((deployment) => deployment.uid).sort()).toEqual([first.uid, second.uid].sort());
  });

  it("GET /v7/deployments filters SHA before sorting and pagination", async () => {
    const older = await createDeployment({ name: "older", meta: { githubCommitSha: "commit-sha" } });
    const newer = await createDeployment({ name: "newer", meta: { githubCommitSha: "commit-sha" } });
    const unrelated = await createDeployment({ name: "unrelated", meta: { githubCommitSha: "other-sha" } });
    const vs = getVercelStore(store);
    for (const [index, deployment] of [older, newer, unrelated].entries()) {
      const row = vs.deployments.findOneBy("uid", deployment.uid)!;
      vs.deployments.update(row.id, { created_at: new Date((index + 1) * 1_000).toISOString() });
    }

    const response = await app.request(`${base}/v7/deployments?sha=commit-sha&limit=1`, {
      headers: authHeaders(),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      deployments: [{ uid: newer.uid }],
      pagination: { count: 1, next: 2_000, prev: 2_000 },
    });

    const earlier = await app.request(`${base}/v7/deployments?sha=commit-sha&since=0&until=1999&limit=1`, {
      headers: authHeaders(),
    });
    expect(earlier.status).toBe(200);
    expect(await earlier.json()).toMatchObject({
      deployments: [{ uid: older.uid }],
      pagination: { count: 1, next: null, prev: 1_000 },
    });
  });
});
