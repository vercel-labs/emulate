import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/index.js");

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

it.each(["ipc", "disconnect", ...(process.platform === "win32" ? [] : (["terminal", "SIGTERM"] as const))] as const)(
  "reports readiness and releases the listener on %s",
  async (event) => {
    const directory = await mkdtemp(join(tmpdir(), "emulate-cli-"));
    const port = await availablePort();
    const child = spawn(process.execPath, [cli, "start", "--service", "resend", "--port", String(port)], {
      cwd: directory,
      env: { ...process.env, CI: "1", EMULATE_BASE_URL: "", PORTLESS_URL: "" },
      stdio: event === "terminal" ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe", "ipc"],
    });
    let stdout = "";
    child.stdout!.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr!.resume();
    const exited = once(child, "exit");
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 10000);
    try {
      const ready =
        event === "terminal"
          ? new Promise<void>((resolve) =>
              child.stdout!.on("data", () => {
                if (stdout.includes("Ready.")) resolve();
              }),
            )
          : once(child, "message").then(([message]) => {
              expect(message).toEqual({ type: "emulate:ready", text: expect.stringContaining("Ready.") });
            });
      await Promise.race([
        ready,
        exited.then(([code, signal]) => {
          throw new Error(`CLI exited before readiness (${signal ?? code})`);
        }),
      ]);
      expect((await fetch(`http://127.0.0.1:${port}/emails`, { signal: AbortSignal.timeout(3000) })).status).toBe(200);
      if (event === "ipc") child.send({ type: "emulate:stop" });
      else if (event === "disconnect") child.disconnect();
      else child.kill(event === "terminal" ? "SIGTERM" : event);
      expect(await exited).toEqual([0, null]);
      if (event === "terminal") expect(stdout).toContain("Ready.");
      else expect(stdout).toBe("");
      await expect(fetch(`http://127.0.0.1:${port}/emails`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
    } finally {
      child.kill("SIGKILL");
      await exited;
      clearTimeout(timer);
      await rm(directory, { recursive: true, force: true });
    }
  },
  15000,
);

it("rejects removed JSON flags, reports errors on stderr, and exits cleanly for help and version", () => {
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: tmpdir(), encoding: "utf8" });
  expect(run(["list", "--json"]).status).toBe(1);
  const text = run(["start", "--port", "bad"]);
  expect(text.status).toBe(1);
  expect(text.stdout).toBe("");
  expect(text.stderr).toContain("Invalid port: bad");
  for (const args of [["--help"], ["--version"]]) expect(run(args).status).toBe(0);
});
