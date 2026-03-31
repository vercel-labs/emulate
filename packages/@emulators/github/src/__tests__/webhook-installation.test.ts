import { createHmac } from "crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { Store, WebhookDispatcher } from "@emulators/core";
import { authMiddleware, createApiErrorHandler, createErrorHandler, type TokenMap } from "@emulators/core";
import { githubPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";

function createTestApp(seedConfig?: Parameters<typeof seedFromConfig>[2]) {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("test-token", { login: "octocat", id: 1, scopes: ["repo", "user", "admin:org", "admin:repo_hook"] });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app as any, store, webhooks, base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, seedConfig ?? {
    users: [{ login: "octocat" }],
    repos: [{ owner: "octocat", name: "hello-world" }],
  });

  return { app, store, webhooks, tokenMap };
}

function authHeaders(): HeadersInit {
  return { Authorization: "Bearer test-token" };
}

describe("webhook installation enrichment", () => {
  const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

  beforeEach(() => {
    mockFetch.mockClear();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("includes installation in webhook payload when an app is installed on the repo", async () => {
    const { app, webhooks } = createTestApp({
      users: [{ login: "octocat" }],
      repos: [{ owner: "octocat", name: "hello-world" }],
      apps: [{
        app_id: 100,
        slug: "test-app",
        name: "Test App",
        private_key: "fake-key",
        events: ["issues"],
        installations: [{
          installation_id: 42,
          account: "octocat",
          repository_selection: "all",
        }],
      }],
    });

    webhooks.register({
      url: "https://hooks.example/receiver",
      events: ["issues"],
      active: true,
      owner: "octocat",
      repo: "hello-world",
    });

    await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Test issue" }),
    });

    expect(mockFetch).toHaveBeenCalled();
    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.installation).toBeDefined();
    expect(body.installation.id).toBe(42);
    expect(body.installation.node_id).toBeTruthy();
  });

  it("does not include installation when no app is installed", async () => {
    const { app, webhooks } = createTestApp({
      users: [{ login: "octocat" }],
      repos: [{ owner: "octocat", name: "hello-world" }],
    });

    webhooks.register({
      url: "https://hooks.example/receiver",
      events: ["issues"],
      active: true,
      owner: "octocat",
      repo: "hello-world",
    });

    await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "No app issue" }),
    });

    expect(mockFetch).toHaveBeenCalled();
    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.installation).toBeUndefined();
  });

  it("skips installation when the app does not subscribe to the event", async () => {
    const { app, webhooks } = createTestApp({
      users: [{ login: "octocat" }],
      repos: [{ owner: "octocat", name: "hello-world" }],
      apps: [{
        app_id: 200,
        slug: "push-only-app",
        name: "Push Only",
        private_key: "fake-key",
        events: ["push"],
        installations: [{
          installation_id: 77,
          account: "octocat",
          repository_selection: "all",
        }],
      }],
    });

    webhooks.register({
      url: "https://hooks.example/receiver",
      events: ["issues"],
      active: true,
      owner: "octocat",
      repo: "hello-world",
    });

    await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Not subscribed" }),
    });

    expect(mockFetch).toHaveBeenCalled();
    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.installation).toBeUndefined();
  });

  it("includes installation in pull_request webhook on merge", async () => {
    const { app, webhooks } = createTestApp({
      users: [{ login: "octocat" }],
      repos: [{ owner: "octocat", name: "hello-world" }],
      apps: [{
        app_id: 300,
        slug: "pr-app",
        name: "PR App",
        private_key: "fake-key",
        events: ["pull_request"],
        installations: [{
          installation_id: 1,
          account: "octocat",
          repository_selection: "all",
        }],
      }],
    });

    webhooks.register({
      url: "https://hooks.example/receiver",
      events: ["pull_request"],
      active: true,
      owner: "octocat",
      repo: "hello-world",
    });

    const createRes = await app.request(`${base}/repos/octocat/hello-world/pulls`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "feat: test", head: "feature", base: "main" }),
    });
    expect(createRes.status).toBe(201);

    mockFetch.mockClear();

    const prData = (await createRes.json()) as { number: number };
    const mergeRes = await app.request(
      `${base}/repos/octocat/hello-world/pulls/${prData.number}/merge`,
      {
        method: "PUT",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(mergeRes.status).toBe(200);

    expect(mockFetch).toHaveBeenCalled();
    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.action).toBe("closed");
    expect(body.pull_request.merged).toBe(true);
    expect(body.installation).toBeDefined();
    expect(body.installation.id).toBe(1);
  });

  it("respects selected repository_selection", async () => {
    const { app, store, webhooks } = createTestApp({
      users: [{ login: "octocat" }],
      repos: [
        { owner: "octocat", name: "included-repo" },
        { owner: "octocat", name: "excluded-repo" },
      ],
      apps: [{
        app_id: 400,
        slug: "selective-app",
        name: "Selective App",
        private_key: "fake-key",
        events: ["issues"],
        installations: [{
          installation_id: 88,
          account: "octocat",
          repository_selection: "selected",
          repositories: ["included-repo"],
        }],
      }],
    });

    webhooks.register({
      url: "https://hooks.example/included",
      events: ["issues"],
      active: true,
      owner: "octocat",
      repo: "included-repo",
    });
    webhooks.register({
      url: "https://hooks.example/excluded",
      events: ["issues"],
      active: true,
      owner: "octocat",
      repo: "excluded-repo",
    });

    await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "noop" }),
    });
    mockFetch.mockClear();

    await app.request(`${base}/repos/octocat/included-repo/issues`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Included" }),
    });

    const includedCall = mockFetch.mock.calls.find(
      (c) => c[0] === "https://hooks.example/included",
    );
    expect(includedCall).toBeDefined();
    const includedBody = JSON.parse((includedCall![1] as RequestInit).body as string);
    expect(includedBody.installation).toBeDefined();
    expect(includedBody.installation.id).toBe(88);

    mockFetch.mockClear();

    await app.request(`${base}/repos/octocat/excluded-repo/issues`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Excluded" }),
    });

    const excludedCall = mockFetch.mock.calls.find(
      (c) => c[0] === "https://hooks.example/excluded",
    );
    expect(excludedCall).toBeDefined();
    const excludedBody = JSON.parse((excludedCall![1] as RequestInit).body as string);
    expect(excludedBody.installation).toBeUndefined();
  });
});

describe("app webhook_url delivery", () => {
  const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

  beforeEach(() => {
    mockFetch.mockClear();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("delivers to app webhook_url with installation in payload", async () => {
    const { app } = createTestApp({
      users: [{ login: "octocat" }],
      repos: [{ owner: "octocat", name: "hello-world" }],
      apps: [{
        app_id: 500,
        slug: "webhook-app",
        name: "Webhook App",
        private_key: "fake-key",
        events: ["issues"],
        webhook_url: "https://app.example/webhook",
        installations: [{
          installation_id: 55,
          account: "octocat",
          repository_selection: "all",
        }],
      }],
    });

    await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "App webhook test" }),
    });

    const appCall = mockFetch.mock.calls.find(
      (c) => c[0] === "https://app.example/webhook",
    );
    expect(appCall).toBeDefined();

    const headers = (appCall![1] as RequestInit).headers as Record<string, string>;
    expect(headers["X-GitHub-Event"]).toBe("issues");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse((appCall![1] as RequestInit).body as string);
    expect(body.installation).toBeDefined();
    expect(body.installation.id).toBe(55);
  });

  it("signs app webhook delivery with webhook_secret", async () => {
    const secret = "app-webhook-secret";
    const { app } = createTestApp({
      users: [{ login: "octocat" }],
      repos: [{ owner: "octocat", name: "hello-world" }],
      apps: [{
        app_id: 600,
        slug: "signed-app",
        name: "Signed App",
        private_key: "fake-key",
        events: ["issues"],
        webhook_url: "https://signed.example/webhook",
        webhook_secret: secret,
        installations: [{
          installation_id: 66,
          account: "octocat",
          repository_selection: "all",
        }],
      }],
    });

    await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Signed webhook test" }),
    });

    const appCall = mockFetch.mock.calls.find(
      (c) => c[0] === "https://signed.example/webhook",
    );
    expect(appCall).toBeDefined();

    const headers = (appCall![1] as RequestInit).headers as Record<string, string>;
    const rawBody = (appCall![1] as RequestInit).body as string;
    const expectedHmac = createHmac("sha256", secret).update(rawBody).digest("hex");
    expect(headers["X-Hub-Signature-256"]).toBe(`sha256=${expectedHmac}`);
  });

  it("does not deliver to app when webhook_url is null", async () => {
    const { app } = createTestApp({
      users: [{ login: "octocat" }],
      repos: [{ owner: "octocat", name: "hello-world" }],
      apps: [{
        app_id: 700,
        slug: "no-url-app",
        name: "No URL App",
        private_key: "fake-key",
        events: ["issues"],
        installations: [{
          installation_id: 77,
          account: "octocat",
          repository_selection: "all",
        }],
      }],
    });

    await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "No URL test" }),
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });
});
