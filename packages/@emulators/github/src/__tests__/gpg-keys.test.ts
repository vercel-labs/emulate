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
import { generateKey, readKey } from "openpgp";
import { githubPlugin, getGitHubStore, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";

async function generatePublicKey() {
  return (
    await generateKey({
      type: "ecc",
      curve: "ed25519Legacy",
      userIDs: [{ name: "Octocat", email: "octocat@example.com" }],
      format: "armored",
    })
  ).publicKey;
}

describe("GPG keys", () => {
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
      tokenMap.set(`${user.login}-token`, { login: user.login, id: user.id, scopes: ["admin:gpg_key"] });
    }
  });

  it("publishes parsed public keys, paginates both lists, and deletes only the owner's key", async () => {
    const armored = await generatePublicKey();
    const parsed = await readKey({ armoredKey: armored });
    const response = await request("/user/gpg_keys", "POST", { name: "Laptop", armored_public_key: armored });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: number };
    expect(created).toMatchObject({
      name: "Laptop",
      key_id: parsed.getKeyID().toHex().toUpperCase(),
      raw_key: armored,
      emails: [{ email: "octocat@example.com", verified: true }],
      can_sign: true,
      revoked: false,
      subkeys: [{ can_encrypt_comms: true }],
    });
    expect(created).not.toHaveProperty("user_id");
    expect(created).not.toHaveProperty("fingerprint");
    expect((await request(`/user/gpg_keys/${created.id}`)).status).toBe(200);
    expect((await request(`/user/gpg_keys/${created.id}`, "GET", undefined, "bob-token")).status).toBe(404);
    expect((await request(`/user/gpg_keys/${created.id}`, "DELETE", undefined, "bob-token")).status).toBe(404);
    await request("/user/gpg_keys", "POST", { armored_public_key: await generatePublicKey() });
    for (const path of ["/user/gpg_keys", "/users/octocat/gpg_keys"]) {
      const first = await request(`${path}?per_page=1`);
      expect(await first.json()).toHaveLength(1);
      expect(first.headers.get("Link")).toContain('page=2>; rel="next"');
      expect(await (await request(`${path}?per_page=1&page=2`)).json()).toHaveLength(1);
    }
    expect(await (await app.request(`${base}/users/octocat/gpg_keys`)).json()).toHaveLength(2);
    expect((await request(`/user/gpg_keys/${created.id}`, "DELETE")).status).toBe(204);
    expect((await request(`/user/gpg_keys/${created.id}`)).status).toBe(404);
    expect(await (await request("/users/octocat/gpg_keys")).json()).toHaveLength(1);
    expect(await (await request("/user/gpg_keys", "GET", undefined, "bob-token")).json()).toEqual([]);
  });

  it("rejects invalid and private material, duplicate fingerprints, and unauthenticated writes", async () => {
    expect((await app.request(`${base}/user/gpg_keys`)).status).toBe(401);
    expect((await request("/users/missing/gpg_keys")).status).toBe(404);
    expect((await request("/user/gpg_keys", "POST", { armored_public_key: "not a key" })).status).toBe(422);
    const generated = await generateKey({
      type: "ecc",
      curve: "ed25519Legacy",
      userIDs: [{ email: "octocat@example.com" }],
    });
    expect((await request("/user/gpg_keys", "POST", { armored_public_key: generated.privateKey })).status).toBe(422);
    expect((await request("/user/gpg_keys", "POST", { armored_public_key: generated.publicKey })).status).toBe(201);
    expect((await request("/user/gpg_keys", "POST", { armored_public_key: generated.publicKey })).status).toBe(422);
    expect(
      (await request("/user/gpg_keys", "POST", { armored_public_key: generated.publicKey }, "bob-token")).status,
    ).toBe(422);
  });
});
