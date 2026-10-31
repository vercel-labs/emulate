import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { startMcpServer } from "../mcp.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.runIf(process.platform !== "win32")(
  "times out a hung command and kills its process group after the grace period",
  async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: 12345,
      exitCode: null,
      signalCode: null,
      connected: false,
      kill: vi.fn(() => true),
    });
    mocks.spawn.mockReturnValue(child);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      child.emit("close", null, "SIGKILL");
      return true;
    });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as typeof process.stdin);
    vi.spyOn(process, "stdout", "get").mockReturnValue(stdout as unknown as typeof process.stdout);
    const done = startMcpServer();
    try {
      const response = new Promise<{ result: unknown }>((resolve) =>
        stdout.once("data", (data) => resolve(JSON.parse(data.toString()))),
      );
      stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list" } }) + "\n");
      await vi.advanceTimersByTimeAsync(29999);
      expect(mocks.spawn).toHaveBeenCalledOnce();
      child.stdout.emit("data", Buffer.from("http://localhost:4000 http://LOCALHOST:4000/%7e?public=a%20b"));
      expect(child.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      await vi.advanceTimersByTimeAsync(7999);
      expect(kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
      expect((await response).result).toMatchObject({
        isError: true,
        structuredContent: {
          stdout: "http://localhost:4000 http://LOCALHOST:4000/%7e?public=a%20b",
          stderr: "CLI command timed out",
          exitCode: 1,
        },
      });
    } finally {
      stdin.end();
      await done;
      stdout.destroy();
    }
  },
);
