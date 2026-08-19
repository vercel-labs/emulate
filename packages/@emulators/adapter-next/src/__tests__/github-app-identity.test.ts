import { sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import * as github from "@emulators/github";
import { createEmulateHandler, type EmulateHandlerConfig } from "../index.js";

function createAppJwt(appId: number, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")}.${Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) }),
  ).toString("base64url")}`;
  return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
}

function memoryPersistence(initial: string | null = null) {
  let value = initial;
  return {
    async load() {
      return value;
    },
    async save(data: string) {
      value = data;
    },
    async initialize(data: string) {
      if (value === null) value = data;
      return value;
    },
    read() {
      return value;
    },
    write(data: string) {
      value = data;
    },
  };
}

function config(persistence?: ReturnType<typeof memoryPersistence>, privateKey?: string): EmulateHandlerConfig {
  return {
    services: {
      github: {
        emulator: github,
        seed: {
          apps: [{ app_id: 123, slug: "embedded", name: "Embedded", private_key: privateKey }],
        },
      },
    },
    persistence,
  };
}

async function requestApp(
  handler: ReturnType<typeof createEmulateHandler>,
  authorization?: string,
  method: "GET" | "POST" = "GET",
): Promise<Response> {
  return handler[method](
    new Request("http://localhost/emulate/github/app", {
      method,
      headers: authorization ? { Authorization: authorization } : undefined,
    }),
    { params: Promise.resolve({ path: ["github", "app"] }) },
  );
}

describe("embedded GitHub App identity", () => {
  it("generates, persists, restores, and authenticates the same identity", async () => {
    const persistence = memoryPersistence();
    const first = createEmulateHandler(config(persistence));
    const [generated] = await first.generatedSecrets();

    expect(generated).toMatchObject({
      service: "github",
      kind: "github.app_private_key",
      id: "123",
      label: "Embedded",
    });
    expect(generated?.value).toMatch(/^-----BEGIN RSA PRIVATE KEY-----/);

    const jwt = createAppJwt(123, generated!.value);
    expect((await requestApp(first, `Bearer ${jwt}`)).status).toBe(200);

    await vi.waitFor(() => expect(persistence.read()).not.toBeNull());
    expect(persistence.read()).toContain('"generatedSecrets"');

    const second = createEmulateHandler(config(persistence));
    expect((await second.generatedSecrets())[0]?.value).toBe(generated?.value);
    expect((await requestApp(second, `Bearer ${jwt}`)).status).toBe(200);
  });

  it("authenticates explicit keys without reporting them as generated", async () => {
    const prepared = await github.materializeGitHubSeedConfig({ apps: [{ app_id: 123, slug: "key", name: "Key" }] });
    const privateKey = prepared.config.apps![0]!.private_key!;
    const handler = createEmulateHandler(config(undefined, privateKey));

    expect(await handler.generatedSecrets()).toEqual([]);
    expect((await requestApp(handler, `Bearer ${createAppJwt(123, privateKey)}`)).status).toBe(200);
  });

  it("loads snapshots without generated-secret metadata", async () => {
    const source = memoryPersistence();
    const first = createEmulateHandler(config(source));
    const [generated] = await first.generatedSecrets();
    const jwt = createAppJwt(123, generated!.value);
    expect((await requestApp(first, `Bearer ${jwt}`)).status).toBe(200);
    await vi.waitFor(() => expect(source.read()).not.toBeNull());
    const snapshot = JSON.parse(source.read()!);
    delete snapshot.generatedSecrets;

    const restored = createEmulateHandler(config(memoryPersistence(JSON.stringify(snapshot))));
    expect(await restored.generatedSecrets()).toEqual([]);
    expect((await requestApp(restored, `Bearer ${jwt}`)).status).toBe(200);
  });

  it("refuses corrupt persistence instead of rotating a generated identity", async () => {
    const handler = createEmulateHandler(config(memoryPersistence("not json")));
    await expect(handler.generatedSecrets()).rejects.toThrow(
      "Cannot restore persisted emulator state without replacing generated identities",
    );
  });

  it("fails initialization when a generated identity cannot be persisted", async () => {
    let saveAttempts = 0;
    const persistence = memoryPersistence();
    const handler = createEmulateHandler({
      ...config(),
      persistence: {
        ...persistence,
        async save(data) {
          saveAttempts += 1;
          if (saveAttempts === 1) throw new Error("storage unavailable");
          await persistence.save(data);
        },
      },
    });

    const [generated] = await handler.generatedSecrets();
    const jwt = createAppJwt(123, generated!.value);
    await expect(requestApp(handler)).rejects.toThrow("storage unavailable");
    expect((await requestApp(handler, `Bearer ${jwt}`)).status).toBe(200);
    expect((await handler.generatedSecrets())[0]?.value).toBe(generated?.value);
    expect(saveAttempts).toBe(2);
  });

  it("retries generated identity preparation after initialize fails", async () => {
    const persistence = memoryPersistence();
    let initializeAttempts = 0;
    const handler = createEmulateHandler({
      ...config(),
      persistence: {
        ...persistence,
        async initialize(data) {
          initializeAttempts += 1;
          if (initializeAttempts === 1) throw new Error("storage unavailable");
          return persistence.initialize(data);
        },
      },
    });

    await expect(handler.generatedSecrets()).rejects.toThrow("storage unavailable");
    const [generated] = await handler.generatedSecrets();
    expect((await requestApp(handler, `Bearer ${createAppJwt(123, generated!.value)}`)).status).toBe(200);
    expect(initializeAttempts).toBe(2);
  });

  it("recovers when initialize publishes identity before losing its response", async () => {
    const persistence = memoryPersistence();
    let initializeAttempts = 0;
    const handler = createEmulateHandler({
      ...config(),
      persistence: {
        ...persistence,
        async initialize(data) {
          initializeAttempts += 1;
          const canonical = await persistence.initialize(data);
          if (initializeAttempts === 1) throw new Error("response lost");
          return canonical;
        },
      },
    });

    await expect(handler.generatedSecrets()).rejects.toThrow("response lost");
    const publishedKey = JSON.parse(persistence.read()!).generatedSecrets[0].value;
    const [generated] = await handler.generatedSecrets();
    expect(generated?.value).toBe(publishedKey);
    expect((await requestApp(handler, `Bearer ${createAppJwt(123, publishedKey)}`)).status).toBe(200);
  });

  it("recovers when save publishes seeded state before losing its response", async () => {
    const persistence = memoryPersistence();
    let saveAttempts = 0;
    const handler = createEmulateHandler({
      ...config(),
      persistence: {
        ...persistence,
        async save(data) {
          saveAttempts += 1;
          await persistence.save(data);
          if (saveAttempts === 1) throw new Error("response lost");
        },
      },
    });

    const [generated] = await handler.generatedSecrets();
    const jwt = createAppJwt(123, generated!.value);
    await expect(requestApp(handler)).rejects.toThrow("response lost");
    expect((await requestApp(handler, `Bearer ${jwt}`)).status).toBe(200);
    expect((await handler.generatedSecrets())[0]?.value).toBe(generated?.value);
  });

  it("recovers the save queue after a later mutating save fails", async () => {
    const persistence = memoryPersistence();
    let saveAttempts = 0;
    const handler = createEmulateHandler({
      ...config(),
      persistence: {
        ...persistence,
        async save(data) {
          saveAttempts += 1;
          if (saveAttempts === 2) throw new Error("storage unavailable");
          await persistence.save(data);
        },
      },
    });

    const [generated] = await handler.generatedSecrets();
    const jwt = createAppJwt(123, generated!.value);
    expect((await requestApp(handler, `Bearer ${jwt}`)).status).toBe(200);
    await requestApp(handler, `Bearer ${jwt}`, "POST");
    await vi.waitFor(() => expect(saveAttempts).toBe(2));
    await requestApp(handler, `Bearer ${jwt}`, "POST");
    await vi.waitFor(() => expect(saveAttempts).toBe(3));
    expect((await handler.generatedSecrets())[0]?.value).toBe(generated?.value);
  });

  it("retries after a transient persistence load failure", async () => {
    const persistence = memoryPersistence();
    let loadAttempts = 0;
    const handler = createEmulateHandler({
      ...config(),
      persistence: {
        ...persistence,
        async load() {
          loadAttempts += 1;
          if (loadAttempts === 1) throw new Error("storage unavailable");
          return persistence.load();
        },
      },
    });

    await expect(handler.generatedSecrets()).rejects.toThrow("storage unavailable");
    const [generated] = await handler.generatedSecrets();
    expect((await requestApp(handler, `Bearer ${createAppJwt(123, generated!.value)}`)).status).toBe(200);
  });

  it("rejects a malformed canonical identity snapshot", async () => {
    const handler = createEmulateHandler({
      ...config(),
      persistence: {
        async load() {
          return null;
        },
        async save() {},
        async initialize() {
          return "not json";
        },
      },
    });

    await expect(handler.generatedSecrets()).rejects.toThrow();
  });

  it("re-reads a seeded snapshot after generatedSecrets prepares identity", async () => {
    const persistence = memoryPersistence();
    const stale = createEmulateHandler(config(persistence));
    await stale.generatedSecrets();

    const winner = createEmulateHandler(config(persistence));
    const [generated] = await winner.generatedSecrets();
    const jwt = createAppJwt(123, generated!.value);
    expect((await requestApp(winner, `Bearer ${jwt}`)).status).toBe(200);
    const canonical = JSON.parse(persistence.read()!);
    canonical.generatedSecrets[0].label = "Canonical";
    persistence.write(JSON.stringify(canonical));

    expect((await requestApp(stale, `Bearer ${jwt}`)).status).toBe(200);
    await requestApp(stale, `Bearer ${jwt}`, "POST");
    expect(JSON.parse(persistence.read()!).generatedSecrets[0].label).toBe("Canonical");
  });

  it("selects one identity across concurrent cold starts", async () => {
    const persistence = memoryPersistence();
    const handlers = Array.from({ length: 8 }, () => createEmulateHandler(config(persistence)));
    const secrets = await Promise.all(handlers.map((handler) => handler.generatedSecrets()));
    const privateKey = secrets[0]![0]!.value;

    expect(new Set(secrets.map(([secret]) => secret?.value))).toEqual(new Set([privateKey]));
    const jwt = createAppJwt(123, privateKey);
    expect(
      await Promise.all(handlers.map(async (handler) => (await requestApp(handler, `Bearer ${jwt}`)).status)),
    ).toEqual(Array(8).fill(200));
  });

  it("never exposes private keys through GitHub HTTP responses", async () => {
    const handler = createEmulateHandler(config());
    const [generated] = await handler.generatedSecrets();
    const response = await requestApp(handler, `Bearer ${createAppJwt(123, generated!.value)}`);
    const body = await response.text();
    const serializedResponse = `${JSON.stringify(Object.fromEntries(response.headers))}\n${body}`;

    expect(response.status).toBe(200);
    expect(serializedResponse).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(serializedResponse).not.toContain(generated!.value);
    expect(serializedResponse).not.toContain(Buffer.from(generated!.value).toString("base64"));
  });
});
