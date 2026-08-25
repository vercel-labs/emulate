import { describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { authMiddleware, createApiErrorHandler, createErrorHandler, type TokenMap } from "@emulators/core";
import { githubPlugin, seedFromConfig, getGitHubStore } from "../index.js";

const base = "http://localhost:4000";

function createInstallationApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app as any, store, webhooks, base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "octocat" }],
    orgs: [{ login: "acme" }],
    repos: [
      { owner: "octocat", name: "hello-world" },
      { owner: "acme", name: "included" },
      { owner: "acme", name: "excluded" },
    ],
  });

  const gh = getGitHubStore(store);
  const user = gh.users.findOneBy("login", "octocat")!;
  const org = gh.orgs.findOneBy("login", "acme")!;
  const included = gh.repos.findOneBy("full_name", "acme/included")!;
  tokenMap.set("user-install-write", {
    login: user.login,
    id: user.id,
    scopes: ["issues:write"],
    installation: {
      installationId: 42,
      appId: 42,
      accountId: user.id,
      accountType: "User",
      permissions: { issues: "write" },
      repositoryIds: [],
      repositorySelection: "all",
    },
  });
  tokenMap.set("org-install-read", {
    login: org.login,
    id: org.id,
    scopes: ["issues:read"],
    installation: {
      installationId: 43,
      appId: 43,
      accountId: org.id,
      accountType: "Organization",
      permissions: { issues: "read" },
      repositoryIds: [included.id],
      repositorySelection: "selected",
    },
  });
  tokenMap.set("org-install-write", {
    login: org.login,
    id: org.id,
    scopes: ["issues:write"],
    installation: {
      installationId: 44,
      appId: 44,
      accountId: org.id,
      accountType: "Organization",
      permissions: { issues: "write" },
      repositoryIds: [included.id],
      repositorySelection: "selected",
    },
  });

  return { app, store };
}

function headers(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

describe("GitHub installation mutation permissions", () => {
  it("uses a user installation bot for issue, comment, and label writes", async () => {
    const { app } = createInstallationApp();
    const issueResponse = await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers: headers("user-install-write"),
      body: JSON.stringify({ title: "Installation issue" }),
    });
    expect(issueResponse.status).toBe(201);
    const issue = (await issueResponse.json()) as { user: { login: string }; number: number };
    expect(issue.user.login).toBe("app-42[bot]");

    const commentResponse = await app.request(`${base}/repos/octocat/hello-world/issues/${issue.number}/comments`, {
      method: "POST",
      headers: headers("user-install-write"),
      body: JSON.stringify({ body: "Installation comment" }),
    });
    expect(commentResponse.status).toBe(201);
    expect(((await commentResponse.json()) as { user: { login: string } }).user.login).toBe("app-42[bot]");

    const labelResponse = await app.request(`${base}/repos/octocat/hello-world/labels`, {
      method: "POST",
      headers: headers("user-install-write"),
      body: JSON.stringify({ name: "installation" }),
    });
    expect(labelResponse.status).toBe(201);
  });

  it("enforces installation write permission and selected repositories", async () => {
    const { app } = createInstallationApp();
    const readOnlyResponse = await app.request(`${base}/repos/acme/included/issues`, {
      method: "POST",
      headers: headers("org-install-read"),
      body: JSON.stringify({ title: "Read only" }),
    });
    expect(readOnlyResponse.status).toBe(403);

    const allowedResponse = await app.request(`${base}/repos/acme/included/issues`, {
      method: "POST",
      headers: headers("org-install-write"),
      body: JSON.stringify({ title: "Allowed" }),
    });
    expect(allowedResponse.status).toBe(201);
    expect(((await allowedResponse.json()) as { user: { login: string } }).user.login).toBe("app-44[bot]");

    const excludedResponse = await app.request(`${base}/repos/acme/excluded/issues`, {
      method: "POST",
      headers: headers("org-install-write"),
      body: JSON.stringify({ title: "Excluded" }),
    });
    expect(excludedResponse.status).toBe(403);
  });
});
