import { beforeEach, describe, expect, it } from "vitest";
import {
  Hono,
  Store,
  WebhookDispatcher,
  authMiddleware,
  createApiErrorHandler,
  createErrorHandler,
  type AppEnv,
  type TokenMap,
} from "@emulators/core";
import { SSH } from "@peculiar/ssh";
import { githubPlugin, getGitHubStore, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";

describe("SSH signing keys", () => {
  let app: Hono<AppEnv>;
  let store: Store;
  const request = (path: string, method = "GET", body?: unknown, token = "octocat-token") =>
    app.request(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  beforeEach(() => {
    store = new Store();
    const tokenMap: TokenMap = new Map();
    app = new Hono<AppEnv>();
    app.onError(createApiErrorHandler());
    app.use("*", createErrorHandler());
    app.use("*", authMiddleware(tokenMap));
    githubPlugin.register(app, store, new WebhookDispatcher(), base, tokenMap);
    seedFromConfig(store, base, { users: [{ login: "octocat", email: "octocat@example.com" }, { login: "bob" }] });
    for (const user of getGitHubStore(store).users.all()) {
      tokenMap.set(`${user.login}-token`, { login: user.login, id: user.id, scopes: ["admin:ssh_signing_key"] });
    }
  });

  it("creates, paginates and deletes SSH signing keys with owner-only mutations", async () => {
    const key = await (await SSH.createKeyPair({ name: "ed25519" })).publicKey.toSSH();
    const response = await request("/user/ssh_signing_keys", "POST", { key, title: "Laptop" });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: number };
    expect(created).toMatchObject({ key, title: "Laptop" });
    expect(created).not.toHaveProperty("fingerprint");
    expect(created).not.toHaveProperty("user_id");
    expect((await request(`/user/ssh_signing_keys/${created.id}`)).status).toBe(200);
    expect((await request(`/user/ssh_signing_keys/${created.id}`, "GET", undefined, "bob-token")).status).toBe(404);
    expect((await request(`/user/ssh_signing_keys/${created.id}`, "DELETE", undefined, "bob-token")).status).toBe(404);
    expect((await request("/user/ssh_signing_keys", "POST", { key })).status).toBe(422);
    expect((await request("/user/ssh_signing_keys", "POST", { key: "not a key" })).status).toBe(422);
    expect((await app.request(`${base}/user/ssh_signing_keys`)).status).toBe(401);
    expect((await request("/users/missing/ssh_signing_keys")).status).toBe(404);
    const second = await (await SSH.createKeyPair({ name: "ed25519" })).publicKey.toSSH();
    expect((await request("/user/ssh_signing_keys", "POST", { key: second })).status).toBe(201);
    for (const path of ["/user/ssh_signing_keys", "/users/octocat/ssh_signing_keys"]) {
      const firstPage = await request(`${path}?per_page=1`);
      expect(await firstPage.json()).toHaveLength(1);
      expect(firstPage.headers.get("Link")).toContain('page=2>; rel="next"');
      expect(await (await request(`${path}?per_page=1&page=2`)).json()).toHaveLength(1);
    }
    expect(await (await app.request(`${base}/users/octocat/ssh_signing_keys`)).json()).toHaveLength(2);
    expect((await request(`/user/ssh_signing_keys/${created.id}`, "DELETE")).status).toBe(204);
    expect((await request(`/user/ssh_signing_keys/${created.id}`)).status).toBe(404);
    expect(await (await request("/users/octocat/ssh_signing_keys")).json()).toHaveLength(1);
  });

  it("rejects private keys, duplicate key comments and invalid input", async () => {
    const pair = await SSH.createKeyPair({ name: "ed25519" });
    const key = await pair.publicKey.toSSH();
    const privateKey = await pair.privateKey.toSSH();
    expect((await request("/user/ssh_signing_keys", "POST", { key: privateKey })).status).toBe(422);
    expect((await request("/user/ssh_signing_keys", "POST", { key, title: 42 })).status).toBe(422);
    expect((await request("/user/ssh_signing_keys", "POST", { key: key + "\n" + key })).status).toBe(422);
    expect((await request("/user/ssh_signing_keys", "POST", { key: key + " Laptop" })).status).toBe(201);
    expect((await request("/user/ssh_signing_keys", "POST", { key: key + " Other title" })).status).toBe(422);
    expect((await request("/user/ssh_signing_keys", "POST", { key }, "bob-token")).status).toBe(422);
  });
});
