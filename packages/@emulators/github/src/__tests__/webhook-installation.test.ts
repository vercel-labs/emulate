import { createHmac, generateKeyPairSync, sign } from "crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "@emulators/core";
import { Store, WebhookDispatcher } from "@emulators/core";
import { authMiddleware, createApiErrorHandler, createErrorHandler, type TokenMap } from "@emulators/core";
import { githubPlugin, seedFromConfig, getGitHubStore, materializeGitHubSeedConfig, prepareSeed } from "../index.js";

const base = "http://localhost:4000";

function createTestApp(seedConfig?: Parameters<typeof seedFromConfig>[2]) {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("test-token", { login: "octocat", id: 1, scopes: ["repo", "user", "admin:org", "admin:repo_hook"] });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use(
    "*",
    authMiddleware(tokenMap, (appId) => {
      const gh = getGitHubStore(store);
      const ghApp = gh.apps.all().find((a) => a.app_id === appId);
      if (!ghApp) return null;
      return { privateKey: ghApp.private_key, slug: ghApp.slug, name: ghApp.name };
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

  return { app, store, webhooks, tokenMap };
}

function createAppJwt(appId: string, privateKey: string): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: appId };
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function authHeaders(): Record<string, string> {
  return { Authorization: "Bearer test-token" };
}

describe("GitHub App seed materialization", () => {
  it("keeps restored keys and reports newly generated App keys", async () => {
    const restored = await materializeGitHubSeedConfig({ apps: [{ app_id: 9, slug: "restored", name: "Restored" }] });
    const restoredSecret = {
      kind: "github.app_private_key" as const,
      id: "9",
      label: "Restored",
      value: restored.config.apps![0]!.private_key!,
    };

    const prepared = await prepareSeed(
      {
        apps: [
          { app_id: 9, slug: "restored", name: "Restored" },
          { app_id: 10, slug: "new", name: "New" },
        ],
      },
      [restoredSecret],
    );

    expect(prepared.generatedSecrets).toEqual([
      restoredSecret,
      expect.objectContaining({ kind: "github.app_private_key", id: "10", label: "New" }),
    ]);
  });

  it("generates omitted keys without changing explicit keys", async () => {
    const explicitKey = "explicit-key-bytes";
    const seed = {
      apps: [
        { app_id: 10, slug: "generated", name: "Generated" },
        { app_id: 11, slug: "explicit", name: "Explicit", private_key: explicitKey },
        { app_id: 12, slug: "generated-second", name: "Generated Second" },
      ],
    };

    const materialized = await materializeGitHubSeedConfig(seed);

    expect(seed.apps[0]).not.toHaveProperty("private_key");
    expect(materialized.config.apps?.[0]?.private_key).toMatch(/^-----BEGIN RSA PRIVATE KEY-----/);
    expect(materialized.config.apps?.[1]?.private_key).toBe(explicitKey);
    expect(materialized.config.apps?.[2]?.private_key).toMatch(/^-----BEGIN RSA PRIVATE KEY-----/);
    expect(materialized.config.apps?.map((app) => app.slug)).toEqual(["generated", "explicit", "generated-second"]);
    expect(materialized.generatedPrivateKeys).toEqual([
      expect.objectContaining({
        app_id: 10,
        slug: "generated",
        private_key: materialized.config.apps?.[0]?.private_key,
      }),
      expect.objectContaining({
        app_id: 12,
        slug: "generated-second",
        private_key: materialized.config.apps?.[2]?.private_key,
      }),
    ]);
  });

  it.each([
    {
      name: "app ID",
      apps: [
        { app_id: 20, slug: "generated", name: "Generated" },
        { app_id: 21, slug: "explicit", name: "Explicit", private_key: "explicit-key" },
        { app_id: 20, slug: "duplicate-last", name: "Duplicate Last" },
      ],
      message: "Duplicate GitHub App app_id: 20",
    },
    {
      name: "slug",
      apps: [
        { app_id: 22, slug: "duplicate", name: "Generated" },
        { app_id: 23, slug: "explicit", name: "Explicit", private_key: "explicit-key" },
        { app_id: 24, slug: "duplicate", name: "Duplicate Last" },
      ],
      message: 'Duplicate GitHub App slug: "duplicate"',
    },
  ])("rejects a duplicate $name before generating keys", async ({ apps, message }) => {
    const timer = vi.fn();
    setTimeout(timer, 0);

    await expect(materializeGitHubSeedConfig({ apps })).rejects.toThrow(message);
    expect(timer).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(timer).toHaveBeenCalled();
  });

  it("yields the event loop while generating multiple keys", async () => {
    let timerRan = false;
    setTimeout(() => {
      timerRan = true;
    }, 0);

    const materialized = await materializeGitHubSeedConfig({
      apps: Array.from({ length: 4 }, (_, index) => ({
        app_id: 30 + index,
        slug: `async-${index}`,
        name: `Async ${index}`,
      })),
    });

    expect(timerRan).toBe(true);
    expect(materialized.generatedPrivateKeys).toHaveLength(4);
  });

  it("requires direct seed callers to provide a private key", () => {
    const store = new Store();
    githubPlugin.seed?.(store, base);

    expect(() =>
      seedFromConfig(store, base, {
        users: [{ login: "should-not-exist" }],
        apps: [{ app_id: 12, slug: "missing", name: "Missing" }],
      }),
    ).toThrow("requires private_key when seedFromConfig is called directly");
    expect(getGitHubStore(store).users.findOneBy("login", "should-not-exist")).toBeUndefined();
  });
});

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
      apps: [
        {
          app_id: 100,
          slug: "test-app",
          name: "Test App",
          private_key: "fake-key",
          events: ["issues"],
          installations: [
            {
              installation_id: 42,
              account: "octocat",
              repository_selection: "all",
            },
          ],
        },
      ],
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
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(body.installation).toBeDefined();
    expect(body.installation.id).toBe(42);
    expect(body.installation.node_id).toBeTruthy();
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-GitHub-Event"]).toBe("issues");
    expect(headers["X-GitHub-Delivery"]).toBe("1");
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
      apps: [
        {
          app_id: 200,
          slug: "push-only-app",
          name: "Push Only",
          private_key: "fake-key",
          events: ["push"],
          installations: [
            {
              installation_id: 77,
              account: "octocat",
              repository_selection: "all",
            },
          ],
        },
      ],
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
      apps: [
        {
          app_id: 300,
          slug: "pr-app",
          name: "PR App",
          private_key: "fake-key",
          events: ["pull_request"],
          installations: [
            {
              installation_id: 1,
              account: "octocat",
              repository_selection: "all",
            },
          ],
        },
      ],
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
    const mergeRes = await app.request(`${base}/repos/octocat/hello-world/pulls/${prData.number}/merge`, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
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
      apps: [
        {
          app_id: 400,
          slug: "selective-app",
          name: "Selective App",
          private_key: "fake-key",
          events: ["issues"],
          installations: [
            {
              installation_id: 88,
              account: "octocat",
              repository_selection: "selected",
              repositories: ["included-repo"],
            },
          ],
        },
      ],
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

    const includedCall = mockFetch.mock.calls.find((c) => c[0] === "https://hooks.example/included");
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

    const excludedCall = mockFetch.mock.calls.find((c) => c[0] === "https://hooks.example/excluded");
    expect(excludedCall).toBeDefined();
    const excludedBody = JSON.parse((excludedCall![1] as RequestInit).body as string);
    expect(excludedBody.installation).toBeUndefined();
  });
});

describe("GitHub App installation token flow", () => {
  it("accepts a valid App JWT and mints an installation token", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const { app } = createTestApp({
      users: [{ login: "octocat" }],
      repos: [{ owner: "octocat", name: "hello-world" }],
      apps: [
        {
          app_id: 800,
          slug: "token-app",
          name: "Token App",
          private_key: privateKeyPem,
          permissions: { contents: "read", issues: "write" },
          installations: [
            {
              installation_id: 99,
              account: "octocat",
              repository_selection: "selected",
              repositories: ["octocat/hello-world"],
            },
          ],
        },
      ],
    });

    const response = await app.request(`${base}/app/installations/99/access_tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${createAppJwt("800", privateKeyPem)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ permissions: { contents: "read" } }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      token: string;
      permissions: Record<string, string>;
      repositories?: Array<{ full_name: string }>;
    };
    expect(body.token).toMatch(/^ghs_/);
    expect(body.permissions).toEqual({ contents: "read" });
    expect(body.repositories).toEqual([expect.objectContaining({ full_name: "octocat/hello-world" })]);
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
      apps: [
        {
          app_id: 500,
          slug: "webhook-app",
          name: "Webhook App",
          private_key: "fake-key",
          events: ["issues"],
          webhook_url: "https://app.example/webhook",
          installations: [
            {
              installation_id: 55,
              account: "octocat",
              repository_selection: "all",
            },
          ],
        },
      ],
    });

    await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "App webhook test" }),
    });

    const appCall = mockFetch.mock.calls.find((c) => c[0] === "https://app.example/webhook");
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
      apps: [
        {
          app_id: 600,
          slug: "signed-app",
          name: "Signed App",
          private_key: "fake-key",
          events: ["issues"],
          webhook_url: "https://signed.example/webhook",
          webhook_secret: secret,
          installations: [
            {
              installation_id: 66,
              account: "octocat",
              repository_selection: "all",
            },
          ],
        },
      ],
    });

    await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Signed webhook test" }),
    });

    const appCall = mockFetch.mock.calls.find((c) => c[0] === "https://signed.example/webhook");
    expect(appCall).toBeDefined();

    const headers = (appCall![1] as RequestInit).headers as Record<string, string>;
    const rawBody = (appCall![1] as RequestInit).body as string;
    const expectedHmac = createHmac("sha256", secret).update(rawBody).digest("hex");
    expect(headers["X-Hub-Signature-256"]).toBe(`sha256=${expectedHmac}`);
  });

  it("distinguishes user and organization installations with the same account ID", async () => {
    const { app, webhooks } = createTestApp({
      users: [{ login: "octocat" }],
      orgs: [{ login: "first-org" }, { login: "second-org" }, { login: "acme" }],
      repos: [{ owner: "acme", name: "project" }],
      apps: [
        {
          app_id: 701,
          slug: "user-app",
          name: "User App",
          private_key: "fake-key",
          events: ["push"],
          webhook_url: "https://user.example/webhook",
          installations: [{ installation_id: 81, account: "octocat", repository_selection: "all" }],
        },
        {
          app_id: 702,
          slug: "org-app",
          name: "Organization App",
          private_key: "fake-key",
          events: ["push"],
          webhook_url: "https://org.example/webhook",
          installations: [{ installation_id: 82, account: "acme", repository_selection: "all" }],
        },
      ],
    });

    const installation = await app.request(`${base}/repos/acme/project/installation`, { headers: authHeaders() });
    expect(installation.status).toBe(200);
    expect(await installation.json()).toEqual(expect.objectContaining({ id: 82, target_type: "Organization" }));

    mockFetch.mockClear();
    await webhooks.dispatch("push", undefined, { ref: "refs/heads/main" }, "acme", "project");

    expect(mockFetch.mock.calls.some((call) => call[0] === "https://org.example/webhook")).toBe(true);
    expect(mockFetch.mock.calls.some((call) => call[0] === "https://user.example/webhook")).toBe(false);
  });

  it("does not deliver to app when webhook_url is null", async () => {
    const { app } = createTestApp({
      users: [{ login: "octocat" }],
      repos: [{ owner: "octocat", name: "hello-world" }],
      apps: [
        {
          app_id: 700,
          slug: "no-url-app",
          name: "No URL App",
          private_key: "fake-key",
          events: ["issues"],
          installations: [
            {
              installation_id: 77,
              account: "octocat",
              repository_selection: "all",
            },
          ],
        },
      ],
    });

    await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "No URL test" }),
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });
});
