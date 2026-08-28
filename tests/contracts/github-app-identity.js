import { sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
function jwt(privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${Buffer.from('{"alg":"RS256","typ":"JWT"}').toString("base64url")}.${Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: "123" }),
  ).toString("base64url")}`;
  return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
}
function memory(initial = null) {
  let value = initial;
  return {
    async load() {
      return value;
    },
    async save(data) {
      value = data;
    },
    async initialize(data) {
      if (value === null) value = data;
      return value;
    },
    read: () => value,
    write(data) {
      value = data;
    },
  };
}
export function githubAppIdentityContract(h) {
  const create = (persistence, privateKey) => h.createEmulateHandler(h.config(persistence, privateKey));
  const key = async (handler) => (await handler.generatedSecrets())[0].value;
  const auth = (handler, privateKey, method) => h.requestApp(handler, `Bearer ${jwt(privateKey)}`, method);
  describe("embedded GitHub App identity", () => {
    it("generates, persists, restores, and authenticates the same identity", async () => {
      const persistence = memory();
      const first = create(persistence);
      const generated = (await first.generatedSecrets())[0];
      expect(generated).toMatchObject({
        service: "github",
        kind: "github.app_private_key",
        id: "123",
        label: "Embedded",
      });
      expect(generated.value).toMatch(/^-----BEGIN RSA PRIVATE KEY-----/);
      expect((await auth(first, generated.value)).status).toBe(200);
      await vi.waitFor(() => expect(persistence.read()).not.toBeNull());
      expect(persistence.read()).toContain('"generatedSecrets"');
      const second = create(persistence);
      expect(await key(second)).toBe(generated.value);
      expect((await auth(second, generated.value)).status).toBe(200);
    });
    it("authenticates explicit keys without reporting them as generated", async () => {
      const privateKey = await h.createExplicitPrivateKey();
      const handler = create(undefined, privateKey);
      expect(await handler.generatedSecrets()).toEqual([]);
      expect((await auth(handler, privateKey)).status).toBe(200);
    });
    it("loads snapshots without generated-secret metadata", async () => {
      const source = memory();
      const first = create(source);
      const privateKey = await key(first);
      expect((await auth(first, privateKey)).status).toBe(200);
      await vi.waitFor(() => expect(source.read()).not.toBeNull());
      const snapshot = JSON.parse(source.read());
      delete snapshot.generatedSecrets;
      const restored = create(memory(JSON.stringify(snapshot)));
      expect(await restored.generatedSecrets()).toEqual([]);
      expect((await auth(restored, privateKey)).status).toBe(200);
    });
    it("refuses corrupt persistence instead of rotating a generated identity", async () => {
      await expect(create(memory("not json")).generatedSecrets()).rejects.toThrow(
        "Cannot restore persisted emulator state without replacing generated identities",
      );
    });
    it("fails initialization when a generated identity cannot be persisted", async () => {
      const persistence = memory();
      let attempts = 0;
      const handler = create({
        ...persistence,
        async save(data) {
          if (++attempts === 1) throw new Error("storage unavailable");
          await persistence.save(data);
        },
      });
      const privateKey = await key(handler);
      await expect(h.requestApp(handler)).rejects.toThrow("storage unavailable");
      expect((await auth(handler, privateKey)).status).toBe(200);
      expect(await key(handler)).toBe(privateKey);
      expect(attempts).toBe(2);
    });
    it("retries generated identity preparation after initialize fails", async () => {
      const persistence = memory();
      let attempts = 0;
      const handler = create({
        ...persistence,
        async initialize(data) {
          if (++attempts === 1) throw new Error("storage unavailable");
          return persistence.initialize(data);
        },
      });
      await expect(handler.generatedSecrets()).rejects.toThrow("storage unavailable");
      expect((await auth(handler, await key(handler))).status).toBe(200);
      expect(attempts).toBe(2);
    });
    it("recovers when initialize publishes identity before losing its response", async () => {
      const persistence = memory();
      let attempts = 0;
      const handler = create({
        ...persistence,
        async initialize(data) {
          const canonical = await persistence.initialize(data);
          if (++attempts === 1) throw new Error("response lost");
          return canonical;
        },
      });
      await expect(handler.generatedSecrets()).rejects.toThrow("response lost");
      const publishedKey = JSON.parse(persistence.read()).generatedSecrets[0].value;
      expect(await key(handler)).toBe(publishedKey);
      expect((await auth(handler, publishedKey)).status).toBe(200);
    });
    it("recovers when save publishes seeded state before losing its response", async () => {
      const persistence = memory();
      let attempts = 0;
      const handler = create({
        ...persistence,
        async save(data) {
          await persistence.save(data);
          if (++attempts === 1) throw new Error("response lost");
        },
      });
      const privateKey = await key(handler);
      await expect(h.requestApp(handler)).rejects.toThrow("response lost");
      expect((await auth(handler, privateKey)).status).toBe(200);
      expect(await key(handler)).toBe(privateKey);
    });
    it("recovers the save queue after a later mutating save fails", async () => {
      const persistence = memory();
      let attempts = 0;
      const handler = create({
        ...persistence,
        async save(data) {
          if (++attempts === 2) throw new Error("storage unavailable");
          await persistence.save(data);
        },
      });
      const privateKey = await key(handler);
      expect((await auth(handler, privateKey)).status).toBe(200);
      await auth(handler, privateKey, "POST");
      await vi.waitFor(() => expect(attempts).toBe(2));
      await auth(handler, privateKey, "POST");
      await vi.waitFor(() => expect(attempts).toBe(3));
      expect(await key(handler)).toBe(privateKey);
    });
    it("retries after a transient persistence load failure", async () => {
      const persistence = memory();
      let attempts = 0;
      const handler = create({
        ...persistence,
        async load() {
          if (++attempts === 1) throw new Error("storage unavailable");
          return persistence.load();
        },
      });
      await expect(handler.generatedSecrets()).rejects.toThrow("storage unavailable");
      expect((await auth(handler, await key(handler))).status).toBe(200);
    });
    it("rejects a malformed canonical identity snapshot", async () => {
      const persistence = memory();
      persistence.initialize = async () => '{"store":{"collections":[],"data":{}},"tokens":{}}';
      await expect(create(persistence).generatedSecrets()).rejects.toThrow();
    });
    it("refuses a persisted canonical snapshot that omits the configured identity", async () => {
      const persistence = memory();
      const initialize = persistence.initialize;
      persistence.initialize = async (data) => {
        const canonical = JSON.parse(data);
        canonical.generatedSecrets[0].service = "other";
        return initialize(JSON.stringify(canonical));
      };
      for (let attempt = 0; attempt < 2; attempt++)
        await expect(create(persistence).generatedSecrets()).rejects.toThrow(/generated identities/);
    });
    it("re-reads a seeded snapshot after generatedSecrets prepares identity", async () => {
      const persistence = memory();
      const stale = create(persistence);
      await stale.generatedSecrets();
      const winner = create(persistence);
      const privateKey = await key(winner);
      expect((await auth(winner, privateKey)).status).toBe(200);
      const canonical = JSON.parse(persistence.read());
      canonical.generatedSecrets[0].label = "Canonical";
      persistence.write(JSON.stringify(canonical));
      expect((await auth(stale, privateKey)).status).toBe(200);
      await auth(stale, privateKey, "POST");
      expect(JSON.parse(persistence.read()).generatedSecrets[0].label).toBe("Canonical");
    });
    it("selects one identity across concurrent cold starts", async () => {
      const persistence = memory();
      const handlers = Array.from({ length: 8 }, () => create(persistence));
      const privateKeys = await Promise.all(handlers.map(key));
      expect(new Set(privateKeys)).toEqual(new Set([privateKeys[0]]));
      expect(await Promise.all(handlers.map(async (handler) => (await auth(handler, privateKeys[0])).status))).toEqual(
        Array(8).fill(200),
      );
    });
    it("never exposes private keys through GitHub HTTP responses", async () => {
      const handler = create();
      const privateKey = await key(handler);
      const response = await auth(handler, privateKey);
      const serialized = `${JSON.stringify(Object.fromEntries(response.headers))}\n${await response.text()}`;
      expect(response.status).toBe(200);
      expect(serialized).not.toContain("BEGIN RSA PRIVATE KEY");
      expect(serialized).not.toContain(privateKey);
      expect(serialized).not.toContain(Buffer.from(privateKey).toString("base64"));
    });
    it("persists and restores installation-token inspection metadata", async () => {
      const persistence = memory();
      const first = create(persistence);
      const privateKey = await key(first);
      const mint = await h.request(
        first,
        "app/installations/124/access_tokens",
        `Bearer ${jwt(privateKey)}`,
        "POST",
      );
      expect(mint.status).toBe(201);
      const token = (await mint.json()).token;

      expect(await (await h.request(first, "_emulate/installation-tokens")).json()).toMatchObject({
        installation_tokens: [
          expect.objectContaining({
            app: { id: 123, slug: "embedded", name: "Embedded" },
            installation: { id: 124 },
            account: expect.objectContaining({ login: "acme", type: "Organization" }),
            status: "active",
          }),
        ],
      });
      await vi.waitFor(() => expect(persistence.read()).toContain("github.installation_token_metadata"));

      const second = create(persistence);
      expect(await (await h.request(second, "_emulate/installation-tokens")).json()).toEqual(
        await (await h.request(first, "_emulate/installation-tokens")).json(),
      );
      expect((await h.request(second, "repos/acme/private-repo", `Bearer ${token}`)).status).toBe(200);
    });
    it("restores legacy installation authorization without fabricating inspection metadata", async () => {
      const persistence = memory();
      const first = create(persistence);
      const privateKey = await key(first);
      const mint = await h.request(
        first,
        "app/installations/124/access_tokens",
        `Bearer ${jwt(privateKey)}`,
        "POST",
      );
      expect(mint.status).toBe(201);
      const token = (await mint.json()).token;
      await vi.waitFor(() => expect(persistence.read()).toContain("github.installation_token_metadata"));

      const snapshot = JSON.parse(persistence.read());
      delete snapshot.store.collections["github:github.installation_token_metadata"];
      const legacyPersistence = memory(JSON.stringify(snapshot));
      const restored = create(legacyPersistence);

      expect(await (await h.request(restored, "_emulate/installation-tokens")).json()).toEqual({
        installation_tokens: [],
      });
      expect((await h.request(restored, "repos/acme/private-repo", `Bearer ${token}`)).status).toBe(200);

      const nextMint = await h.request(
        restored,
        "app/installations/124/access_tokens",
        `Bearer ${jwt(privateKey)}`,
        "POST",
      );
      expect(nextMint.status).toBe(201);
      expect(await (await h.request(restored, "_emulate/installation-tokens")).json()).toMatchObject({
        installation_tokens: [expect.objectContaining({ installation: { id: 124 }, status: "active" })],
      });
      await vi.waitFor(() => expect(legacyPersistence.read()).toContain("github.installation_token_metadata"));
    });
  });
}
