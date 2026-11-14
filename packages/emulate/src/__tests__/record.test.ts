import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/index.js");

async function availablePort() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  await new Promise((done) => server.close(done));
  return port;
}

describe("emulate record", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("proxies traffic and writes a seed config on interrupt", async () => {
    const upstream = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ login: "octocat", id: 1, name: "Octo Cat" }));
    });
    await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    const dir = mkdtempSync(join(tmpdir(), "emulate-record-"));
    dirs.push(dir);
    const output = join(dir, "emulate.config.yaml");
    const port = await availablePort();

    const child = spawn(
      process.execPath,
      [cli, "record", "-s", "github", "-u", `http://127.0.0.1:${upstreamPort}/`, "-p", String(port), "-o", output],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const exited = new Promise<number | null>((done) => child.once("exit", done));
    try {
      await new Promise<void>((done, fail) => {
        child.stdout.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("Press Ctrl+C")) done();
        });
        child.once("exit", () => fail(new Error("record exited early")));
      });

      const response = await fetch(`http://127.0.0.1:${port}/user`);
      expect(await response.json()).toMatchObject({ login: "octocat" });

      child.kill("SIGINT");
      expect(await exited).toBe(0);
      expect(readFileSync(output, "utf-8")).toContain("octocat");
    } finally {
      child.kill();
      await new Promise((done) => upstream.close(done));
    }
  });
});
