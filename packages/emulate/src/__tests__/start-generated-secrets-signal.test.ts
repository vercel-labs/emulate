import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const portless = vi.hoisted(() => {
  let markStarted!: () => void;
  let releaseCheck!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    releaseCheck = resolve;
  });

  return {
    started,
    release: () => releaseCheck(),
    ensurePortless: vi.fn(async () => {
      markStarted();
      await pending;
    }),
  };
});

vi.mock("../portless.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../portless.js")>()),
  ensurePortless: portless.ensurePortless,
}));

const { startCommand } = await import("../commands/start.js");

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("CLI generated secrets startup signals", () => {
  it("removes the published artifact when termination arrives during Portless setup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "emulate-start-signal-"));
    directories.push(directory);
    const destination = join(directory, "secrets.json");
    const beforeSigint = process.listeners("SIGINT");
    const beforeSigterm = process.listeners("SIGTERM");
    const start = startCommand({
      port: 15100,
      service: "vercel",
      generatedSecretsFile: destination,
      portless: true,
    });

    await portless.started;
    await expect(access(destination)).resolves.toBeUndefined();
    const shutdown = process.listeners("SIGTERM").find((listener) => !beforeSigterm.includes(listener));
    const interrupt = process.listeners("SIGINT").find((listener) => !beforeSigint.includes(listener));
    expect(shutdown).toBeDefined();
    expect(interrupt).toBe(shutdown);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    shutdown?.("SIGTERM");
    portless.release();
    await start;

    expect(exit).toHaveBeenCalledWith(0);
    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(process.listeners("SIGINT")).toEqual(beforeSigint);
    expect(process.listeners("SIGTERM")).toEqual(beforeSigterm);
  });
});
