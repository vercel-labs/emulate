import { generateKeyPairSync, sign } from "node:crypto";
import { createServer as createNodeServer } from "node:net";
import { access, chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareStartServices, startCommand } from "../commands/start.js";
import { SERVICE_REGISTRY } from "../registry.js";

const directories: string[] = [];

function createAppJwt(appId: string, privateKey: string): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: appId })).toString(
    "base64url",
  );
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "emulate-start-secrets-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("CLI generated secrets", () => {
  it("delivers a usable key before startup without exposing it in output or HTTP", async () => {
    const directory = await temporaryDirectory();
    const seedPath = join(directory, "seed.yaml");
    const destination = join(directory, "secrets.json");
    await writeFile(
      seedPath,
      [
        "github:",
        "  users:",
        "    - login: octocat",
        "  apps:",
        "    - app_id: 91",
        "      slug: generated",
        "      name: Generated",
        "      installations:",
        "        - installation_id: 92",
        "          account: octocat",
      ].join("\n"),
    );
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const beforeSigint = process.listeners("SIGINT");
    const beforeSigterm = process.listeners("SIGTERM");

    await startCommand({
      port: 14990,
      service: "github",
      seed: seedPath,
      generatedSecretsFile: destination,
    });

    const artifact = JSON.parse(await readFile(destination, "utf8")) as {
      schemaVersion: number;
      generatedSecrets: Array<{ service: string; kind: string; id: string; label: string; value: string }>;
    };
    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.generatedSecrets).toHaveLength(1);
    expect(artifact.generatedSecrets[0]).toMatchObject({
      service: "github",
      kind: "github.app_private_key",
      id: "91",
      label: "Generated",
    });
    const privateKey = artifact.generatedSecrets[0]!.value;
    const response = await fetch("http://localhost:14990/app", {
      headers: { Authorization: `Bearer ${createAppJwt("91", privateKey)}` },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(privateKey);
    expect(stdout.mock.calls.flat().join("\n")).not.toContain(privateKey);
    expect(stderr.mock.calls.flat().join("\n")).not.toContain(privateKey);

    const shutdown = process.listeners("SIGTERM").find((listener) => !beforeSigterm.includes(listener));
    expect(shutdown).toBeDefined();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("test shutdown");
    }) as typeof process.exit);
    expect(() => shutdown?.("SIGTERM")).toThrow("test shutdown");
    exit.mockRestore();
    for (const listener of process.listeners("SIGINT")) {
      if (!beforeSigint.includes(listener)) process.removeListener("SIGINT", listener);
    }
    for (const listener of process.listeners("SIGTERM")) {
      if (!beforeSigterm.includes(listener)) process.removeListener("SIGTERM", listener);
    }
  });

  it("materializes usable generated keys in service order and excludes explicit keys", async () => {
    const { privateKey: explicitKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "pkcs1", format: "pem" },
    });
    const seed = {
      github: {
        apps: [
          { app_id: 101, slug: "first", name: "First" },
          { app_id: 102, slug: "explicit", name: "Explicit", private_key: explicitKey },
          { app_id: 103, slug: "third", name: "Third" },
        ],
      },
      vercel: {},
    };

    const result = await prepareStartServices(["github", "vercel"], seed, { port: 15000 }, true);

    expect(result.prepared.map(({ svc }) => svc)).toEqual(["github", "vercel"]);
    expect(result.generatedSecrets.map(({ service, id }) => [service, id])).toEqual([
      ["github", "101"],
      ["github", "103"],
    ]);
    expect(result.generatedSecrets.some(({ value }) => value === explicitKey)).toBe(false);
    for (const secret of result.generatedSecrets) {
      expect(secret.value).toMatch(/^-----BEGIN RSA PRIVATE KEY-----/);
      expect(() => sign("RSA-SHA256", Buffer.from("proof"), secret.value)).not.toThrow();
    }
  });

  it("writes an empty artifact when selected services generate no secrets", async () => {
    const directory = await temporaryDirectory();
    const seedPath = join(directory, "seed.yaml");
    const destination = join(directory, "secrets.json");
    await writeFile(seedPath, "vercel:\n  users:\n    - username: developer\n");
    const beforeSigint = process.listeners("SIGINT");
    const beforeSigterm = process.listeners("SIGTERM");

    await startCommand({
      port: 15005,
      service: "vercel",
      seed: seedPath,
      generatedSecretsFile: destination,
    });

    expect(JSON.parse(await readFile(destination, "utf8"))).toEqual({
      schemaVersion: 1,
      generatedSecrets: [],
    });

    const shutdown = process.listeners("SIGTERM").find((listener) => !beforeSigterm.includes(listener));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("test shutdown");
    }) as typeof process.exit);
    expect(() => shutdown?.("SIGTERM")).toThrow("test shutdown");
    exit.mockRestore();
    for (const listener of process.listeners("SIGINT")) {
      if (!beforeSigint.includes(listener)) process.removeListener("SIGINT", listener);
    }
    for (const listener of process.listeners("SIGTERM")) {
      if (!beforeSigterm.includes(listener)) process.removeListener("SIGTERM", listener);
    }
  });

  it("preserves missing private keys without the flag", async () => {
    const seed = { github: { apps: [{ app_id: 201, slug: "missing", name: "Missing" }] } };

    const result = await prepareStartServices(["github"], seed, { port: 15010 }, false);

    expect(result.generatedSecrets).toEqual([]);
    expect(result.prepared[0]?.svcSeedConfig).toEqual(seed.github);
    expect((result.prepared[0]?.svcSeedConfig as typeof seed.github).apps).toEqual([
      { app_id: 201, slug: "missing", name: "Missing" },
    ]);
  });

  it("writes no secrets, output, listener, or portless state when delivery preflight fails", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "secrets.json");
    const seedPath = join(directory, "seed.yaml");
    await writeFile(destination, "keep");
    await writeFile(seedPath, "github:\n  apps:\n    - app_id: 301\n      slug: blocked\n      name: Blocked\n");
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const loadService = vi.spyOn(SERVICE_REGISTRY.github, "load");
    const sigintListeners = process.listenerCount("SIGINT");
    const sigtermListeners = process.listenerCount("SIGTERM");

    await expect(
      startCommand({
        port: 15020,
        service: "github",
        seed: seedPath,
        generatedSecretsFile: destination,
        portless: true,
      }),
    ).rejects.toThrow("already exists");

    expect(await readFile(destination, "utf8")).toBe("keep");
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    expect(loadService).not.toHaveBeenCalled();
    expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
    await expect(fetch("http://localhost:15020/user")).rejects.toThrow();
  });

  it("stays silent and closed when another writer wins after key generation starts", async () => {
    const directory = await temporaryDirectory();
    const destination = join(directory, "secrets.json");
    const seedPath = join(directory, "seed.yaml");
    await writeFile(seedPath, "github:\n  apps:\n    - app_id: 302\n      slug: raced\n      name: Raced\n");
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const loadService = vi.spyOn(SERVICE_REGISTRY.github, "load");
    let sawProbe = false;
    const racer = (async () => {
      while (true) {
        const files = await readdir(directory);
        const hasProbe = files.some((file) => file.endsWith(".probe") || file.endsWith(".probe-link"));
        if (hasProbe) sawProbe = true;
        if (sawProbe && !hasProbe) {
          await writeFile(destination, "winner", { flag: "wx" });
          return;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })();

    await expect(
      startCommand({
        port: 15025,
        service: "github",
        seed: seedPath,
        generatedSecretsFile: destination,
        portless: true,
      }),
    ).rejects.toThrow("already exists");
    await racer;

    expect(loadService).toHaveBeenCalledOnce();
    expect(await readFile(destination, "utf8")).toBe("winner");
    expect((await readdir(directory)).sort()).toEqual(["secrets.json", "seed.yaml"]);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    await expect(fetch("http://localhost:15025/user")).rejects.toThrow();
  });

  it("does not generate keys when the destination parent is unwritable", async () => {
    const directory = await temporaryDirectory();
    const seedPath = join(directory, "seed.yaml");
    await writeFile(seedPath, "github:\n  apps:\n    - app_id: 301\n      slug: blocked\n      name: Blocked\n");
    const outputDirectory = join(directory, "output");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(outputDirectory));
    await chmod(outputDirectory, 0o500);
    try {
      await expect(
        startCommand({
          port: 15030,
          service: "github",
          seed: seedPath,
          generatedSecretsFile: join(outputDirectory, "secrets.json"),
        }),
      ).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(outputDirectory, 0o700);
    }
  });

  it("keeps the existing missing-key failure without the flag", async () => {
    const directory = await temporaryDirectory();
    const seedPath = join(directory, "seed.yaml");
    await writeFile(seedPath, "github:\n  apps:\n    - app_id: 401\n      slug: missing\n      name: Missing\n");

    await expect(startCommand({ port: 15040, service: "github", seed: seedPath })).rejects.toThrow(
      'GitHub App "missing" requires private_key',
    );
    await expect(fetch("http://localhost:15040/user")).rejects.toThrow();
  });

  it("preserves portless aliases and URLs after preparation", async () => {
    const result = await prepareStartServices(
      ["github", "vercel"],
      { github: {}, vercel: {} },
      { port: 15050, portless: true },
      true,
    );

    expect(result.portlessAliases).toEqual([
      { name: "github.emulate", port: 15050 },
      { name: "vercel.emulate", port: 15051 },
    ]);
    expect(result.prepared.map(({ baseUrl }) => baseUrl)).toEqual([
      "https://github.emulate.localhost",
      "https://vercel.emulate.localhost",
    ]);
  });

  it("removes a published artifact when Portless fails and permits immediate retry", async () => {
    const directory = await temporaryDirectory();
    const seedPath = join(directory, "seed.yaml");
    const destination = join(directory, "secrets.json");
    const portlessPath = join(directory, "portless");
    const logPath = join(directory, "portless.log");
    await writeFile(seedPath, "vercel:\n  users:\n    - username: developer\n");
    await writeFile(portlessPath, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PORTLESS_TEST_LOG"\nexit 1\n');
    await chmod(portlessPath, 0o700);
    const originalPath = process.env.PATH;
    const originalLog = process.env.PORTLESS_TEST_LOG;
    process.env.PATH = `${directory}:${originalPath}`;
    process.env.PORTLESS_TEST_LOG = logPath;
    try {
      await expect(
        startCommand({
          port: 15060,
          service: "vercel",
          seed: seedPath,
          generatedSecretsFile: destination,
          portless: true,
        }),
      ).rejects.toThrow("portless is required");
    } finally {
      process.env.PATH = originalPath;
      if (originalLog === undefined) delete process.env.PORTLESS_TEST_LOG;
      else process.env.PORTLESS_TEST_LOG = originalLog;
    }

    expect(await readFile(logPath, "utf8")).toBe("--version\n");
    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
    const beforeSigint = process.listeners("SIGINT");
    const beforeSigterm = process.listeners("SIGTERM");
    await startCommand({
      port: 15060,
      service: "vercel",
      seed: seedPath,
      generatedSecretsFile: destination,
    });
    const shutdown = process.listeners("SIGTERM").find((listener) => !beforeSigterm.includes(listener));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("test shutdown");
    }) as typeof process.exit);
    expect(() => shutdown?.("SIGTERM")).toThrow("test shutdown");
    exit.mockRestore();
    for (const listener of process.listeners("SIGINT")) {
      if (!beforeSigint.includes(listener)) process.removeListener("SIGINT", listener);
    }
    for (const listener of process.listeners("SIGTERM")) {
      if (!beforeSigterm.includes(listener)) process.removeListener("SIGTERM", listener);
    }
  });

  it("removes registered aliases and the artifact when a later alias fails", async () => {
    const directory = await temporaryDirectory();
    const seedPath = join(directory, "seed.yaml");
    const destination = join(directory, "secrets.json");
    const portlessPath = join(directory, "portless");
    const logPath = join(directory, "portless.log");
    await writeFile(seedPath, "vercel: {}\nresend: {}\n");
    await writeFile(
      portlessPath,
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ] || [ "$1" = "list" ]; then exit 0; fi',
        'if [ "$1" = "alias" ] && [ "$2" = "resend.emulate" ]; then exit 1; fi',
        'printf "%s\\n" "$*" >> "$PORTLESS_TEST_LOG"',
      ].join("\n"),
    );
    await chmod(portlessPath, 0o700);
    const originalPath = process.env.PATH;
    const originalLog = process.env.PORTLESS_TEST_LOG;
    process.env.PATH = `${directory}:${originalPath}`;
    process.env.PORTLESS_TEST_LOG = logPath;
    try {
      await expect(
        startCommand({
          port: 15065,
          service: "vercel,resend",
          seed: seedPath,
          generatedSecretsFile: destination,
          portless: true,
        }),
      ).rejects.toThrow("Failed to register portless alias: resend.emulate");
    } finally {
      process.env.PATH = originalPath;
      if (originalLog === undefined) delete process.env.PORTLESS_TEST_LOG;
      else process.env.PORTLESS_TEST_LOG = originalLog;
    }

    expect(await readFile(logPath, "utf8")).toBe(
      ["alias vercel.emulate 15065 --force", "alias --remove vercel.emulate", ""].join("\n"),
    );
    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves the startup error and continues cleanup when alias removal fails", async () => {
    const directory = await temporaryDirectory();
    const seedPath = join(directory, "seed.yaml");
    const destination = join(directory, "secrets.json");
    const portlessPath = join(directory, "portless");
    await writeFile(seedPath, "vercel: {}\nresend: {}\n");
    await writeFile(
      portlessPath,
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ] || [ "$1" = "list" ]; then exit 0; fi',
        'if [ "$1" = "alias" ] && [ "$2" = "resend.emulate" ]; then exit 1; fi',
        'if [ "$1" = "alias" ] && [ "$2" = "--remove" ]; then exit 1; fi',
      ].join("\n"),
    );
    await chmod(portlessPath, 0o700);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const originalPath = process.env.PATH;
    process.env.PATH = `${directory}:${originalPath}`;
    try {
      await expect(
        startCommand({
          port: 15067,
          service: "vercel,resend",
          seed: seedPath,
          generatedSecretsFile: destination,
          portless: true,
        }),
      ).rejects.toThrow("Failed to register portless alias: resend.emulate");
    } finally {
      process.env.PATH = originalPath;
    }

    expect(stderr).toHaveBeenCalledWith(
      "Warning: startup cleanup failed for portless alias: failed to remove portless alias: vercel.emulate",
    );
    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes the artifact when seeding fails after store creation", async () => {
    const directory = await temporaryDirectory();
    const seedPath = join(directory, "seed.yaml");
    const destination = join(directory, "secrets.json");
    await writeFile(seedPath, "vercel: {}\n");
    const originalLoad = SERVICE_REGISTRY.vercel.load;
    vi.spyOn(SERVICE_REGISTRY.vercel, "load").mockImplementation(async () => {
      const loaded = await originalLoad();
      return {
        ...loaded,
        seedFromConfig() {
          throw new Error("forced seed failure");
        },
      };
    });

    await expect(
      startCommand({
        port: 15068,
        service: "vercel",
        seed: seedPath,
        generatedSecretsFile: destination,
      }),
    ).rejects.toThrow("forced seed failure");

    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fetch("http://localhost:15068/v2/user")).rejects.toThrow();
  });

  it("closes an earlier listener and removes the artifact when a later listener cannot bind", async () => {
    const directory = await temporaryDirectory();
    const seedPath = join(directory, "seed.yaml");
    const destination = join(directory, "secrets.json");
    const basePort = 15070;
    await writeFile(seedPath, "vercel: {}\nresend: {}\n");
    const blocker = createNodeServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(basePort + 1, resolve);
    });

    try {
      await expect(
        startCommand({
          port: basePort,
          service: "vercel,resend",
          seed: seedPath,
          generatedSecretsFile: destination,
        }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await new Promise<void>((resolve, reject) => {
        blocker.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }

    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fetch(`http://localhost:${basePort}/v2/user`)).rejects.toThrow();
    const beforeSigint = process.listeners("SIGINT");
    const beforeSigterm = process.listeners("SIGTERM");
    await startCommand({
      port: basePort,
      service: "vercel,resend",
      seed: seedPath,
      generatedSecretsFile: destination,
    });
    const shutdown = process.listeners("SIGTERM").find((listener) => !beforeSigterm.includes(listener));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("test shutdown");
    }) as typeof process.exit);
    expect(() => shutdown?.("SIGTERM")).toThrow("test shutdown");
    exit.mockRestore();
    for (const listener of process.listeners("SIGINT")) {
      if (!beforeSigint.includes(listener)) process.removeListener("SIGINT", listener);
    }
    for (const listener of process.listeners("SIGTERM")) {
      if (!beforeSigterm.includes(listener)) process.removeListener("SIGTERM", listener);
    }
  });
});
