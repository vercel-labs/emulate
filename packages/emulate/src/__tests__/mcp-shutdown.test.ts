import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createJsonRpcStream, type JsonRpcMessage } from "./mcp-protocol.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

type ToolResult = {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: { stdout: string; stderr: string; exitCode: number | null };
  isError?: boolean;
};

function toolResult(response: JsonRpcMessage) {
  return response.result as ToolResult;
}

it.each([
  { watch: false, signal: "stop" as const },
  { watch: false, signal: "stop-preparing" as const },
  { watch: false, signal: "SIGTERM" as const },
  { watch: true, signal: "stop" as const },
  { watch: true, signal: "stop-preparing" as const },
  { watch: true, signal: undefined },
])(
  "closes bound listeners during a stalled startup: watch=$watch, signal=$signal",
  async ({ watch, signal }) => {
    const directory = await mkdtemp(join(tmpdir(), "emulate-mcp-stalled-"));
    const socket = createServer();
    await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
    const { port } = socket.address() as AddressInfo;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    await mkdir(join(directory, "node_modules"));
    await symlink(root, join(directory, "node_modules/emulate"), "junction");
    const config = join(directory, "config.mjs");
    const preparing = signal === "stop-preparing";
    const preparedService = preparing
      ? `prepared: { port: 1, emulator: defineEmulator({
  name: "prepared", state: () => ({}), setup({ onDispose }) {
    const timer = setInterval(() => {}, 1000);
    onDispose(() => { clearInterval(timer); writeFileSync("disposed", "done"); });
  }
}) },`
      : "";
    const source = `
import { defineEmulator } from "emulate";
import { writeFileSync } from "node:fs";
export default { services: { ${preparedService} stalled: {
  port: ${port},
  emulator: defineEmulator({ name: "stalled", state: () => ({}), setup({ app }) { app.get("/", c => c.text("ready")); } }),
  persistence: {
    load: async () => { ${preparing ? 'writeFileSync("preparing", "ready"); await new Promise(() => {});' : ""} return null; },
    save: () => new Promise(() => {})
  }
} } };
`;
    await writeFile(config, source);
    const child = spawn(process.execPath, [join(root, "dist/index.js"), "mcp"], {
      cwd: directory,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    const client = createJsonRpcStream(child.stdout, child.stdin);
    try {
      await client.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "shutdown-test", version: "1.0.0" },
      });
      client.notification("notifications/initialized");
      const starting = client
        .request("tools/call", { name: "start", arguments: { config, watch } })
        .catch(() => undefined);
      if (preparing) {
        await expect.poll(() => readFile(join(directory, "preparing"), "utf8").catch(() => "")).toBe("ready");
      } else {
        await expect
          .poll(
            async () => {
              try {
                return (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) })).status;
              } catch {
                return undefined;
              }
            },
            { timeout: 5000 },
          )
          .toBe(503);
      }
      const returnedEarly = await Promise.race([
        starting.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
      ]);
      expect(returnedEarly).toBe(false);
      const queued =
        signal === "stop" ? client.request("tools/call", { name: "start", arguments: { config, watch } }) : undefined;
      const stoppingAt = Date.now();
      if (signal === "stop" || signal === "stop-preparing") {
        await expect(
          client.request("tools/call", { name: "stop", arguments: { unknown: true } }),
        ).resolves.toMatchObject({ result: { isError: true } });
        if (!preparing) expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(503);
        const stopped = toolResult(await client.request("tools/call", { name: "stop" }));
        expect(Date.now() - stoppingAt).toBeLessThan(5000);
        expect(stopped.isError).not.toBe(true);
        if (queued) expect(toolResult(await queued).structuredContent?.stderr).toBe("Emulator startup stopped");
        const cancelled = toolResult((await starting) as JsonRpcMessage);
        expect(cancelled.isError).toBe(true);
        expect(cancelled.structuredContent).toMatchObject({
          stdout: expect.any(String),
          stderr: expect.any(String),
        });
        expect(cancelled.structuredContent).toHaveProperty("exitCode");
        if (preparing) expect(await readFile(join(directory, "disposed"), "utf8")).toBe("done");
        await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
        await writeFile(
          config,
          source
            .replace(preparedService, "")
            .replace("await new Promise(() => {});", "")
            .replace("save: () => new Promise(() => {})", "save: async () => {}"),
        );
        const restarted = toolResult(
          await client.request("tools/call", { name: "start", arguments: { config, watch } }),
        );
        expect(restarted.isError).not.toBe(true);
        expect(restarted.structuredContent).toMatchObject({
          stdout: expect.stringContaining(watch ? "Watching imports" : "Ready."),
          exitCode: null,
        });
        expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("ready");
        child.stdin.end();
      } else if (signal) child.kill(signal);
      else child.stdin.end();
      await expect.poll(() => child.exitCode, { timeout: watch ? 10000 : 3000, message: stderr }).toBe(0);
      await starting;
      await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    } finally {
      child.kill("SIGKILL");
      await exited;
      client.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000,
);
