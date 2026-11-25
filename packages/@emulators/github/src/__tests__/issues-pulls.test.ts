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
  tokenMap.set("test-token", { login: "octocat", id: 1, scopes: ["repo", "user"] });

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

  return { app };
}

function jsonHeaders(): Record<string, string> {
  return { Authorization: "Bearer test-token", "Content-Type": "application/json" };
}

async function createPull(app: Hono, title: string): Promise<number> {
  const res = await app.request(`${base}/repos/octocat/hello-world/pulls`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ title, head: `feature-${title}`, base: "main" }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { number: number }).number;
}

async function createIssue(app: Hono, title: string): Promise<number> {
  const res = await app.request(`${base}/repos/octocat/hello-world/issues`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ title }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { number: number }).number;
}

async function listIssues(app: Hono, query = ""): Promise<Array<Record<string, unknown>>> {
  const res = await app.request(`${base}/repos/octocat/hello-world/issues${query}`, {
    headers: { Authorization: "Bearer test-token" },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Array<Record<string, unknown>>;
}

describe("GET /repos/:owner/:repo/issues includes pull requests", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp().app;
  });

  it("lists pull requests next to issues with a pull_request field", async () => {
    const pullNumber = await createPull(app, "A pull request");
    const issueNumber = await createIssue(app, "A plain issue");

    const body = await listIssues(app);
    expect(body.map((item) => item.number)).toEqual([issueNumber, pullNumber]);

    const pull = body.find((item) => item.number === pullNumber)!;
    expect(pull.pull_request).toMatchObject({
      url: `http://localhost:4000/repos/octocat/hello-world/pulls/${pullNumber}`,
      html_url: `http://localhost:4000/octocat/hello-world/pull/${pullNumber}`,
    });

    const issue = body.find((item) => item.number === issueNumber)!;
    expect(issue.pull_request).toBeUndefined();
  });

  it("applies state and other filters to pull requests", async () => {
    const pullNumber = await createPull(app, "Closing pull");
    await createIssue(app, "Open issue");

    await app.request(`${base}/repos/octocat/hello-world/pulls/${pullNumber}`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ state: "closed" }),
    });

    const open = await listIssues(app);
    expect(open.map((item) => item.number)).toEqual([2]);

    const closed = await listIssues(app, "?state=closed");
    expect(closed.map((item) => item.number)).toEqual([pullNumber]);
    expect(closed[0]!.pull_request).toBeDefined();
  });

  it("returns a pull request from the single-issue endpoint", async () => {
    const pullNumber = await createPull(app, "Readable pull");

    const res = await app.request(`${base}/repos/octocat/hello-world/issues/${pullNumber}`, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { number: number; pull_request?: { url: string } };
    expect(body.number).toBe(pullNumber);
    expect(body.pull_request?.url).toContain(`/pulls/${pullNumber}`);
  });
});
