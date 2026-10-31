import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../program.js";
import { initCommand } from "../commands/init.js";

let directory: string;
let previousDirectory: string;

beforeEach(async () => {
  previousDirectory = process.cwd();
  directory = await realpath(await mkdtemp(join(tmpdir(), "emulate-commands-")));
  vi.stubEnv("EMULATE_BASE_URL", "");
  vi.stubEnv("PORTLESS_URL", "");
  process.chdir(directory);
});

afterEach(async () => {
  process.chdir(previousDirectory);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

describe("CLI command execution", () => {
  it("refuses to overwrite an existing init config", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    initCommand({ service: "resend" });
    const path = join(directory, "emulate.config.yaml");
    const before = await readFile(path, "utf8");
    expect(() => initCommand({ service: "all" })).toThrow("Config file already exists");
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it.each(["missing", "toString"])("rejects unknown init service %s without creating a config", async (service) => {
    await expect(createProgram().parseAsync(["init", "--service", service], { from: "user" })).rejects.toThrow(
      "Unknown service",
    );
    await expect(readFile(join(directory, "emulate.config.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a missing Portless installation without prompting even on a TTY", async () => {
    const originalTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    vi.stubEnv("CI", "1");
    vi.stubEnv("PATH", directory);
    try {
      await expect(
        createProgram().parseAsync(
          ["start", "--service", "resend", "--portless", "--port", String(await availablePort())],
          { from: "user" },
        ),
      ).rejects.toThrow("portless is required but not installed");
    } finally {
      process.stdin.isTTY = originalTTY;
    }
  });
});
