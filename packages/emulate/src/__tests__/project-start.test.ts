import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectStartCommand } from "../commands/project-start.js";
import type { RunMetadata } from "../project-runner.js";
import * as secretsFile from "../generated-secrets-file.js";

const mocks = vi.hoisted(() => ({
  fork: vi.fn(),
  change: undefined as undefined | ((path: string) => void),
  start: vi.fn(async () => {}),
  update: vi.fn(async (_files: Iterable<string>, _patterns: string[], _recovery: boolean) => {}),
  close: vi.fn(async () => {}),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  fork: mocks.fork,
}));
vi.mock("../project-watcher.js", () => ({
  ProjectWatcher: class {
    constructor(_directory: string, change: (path: string) => void) {
      mocks.change = change;
    }
    start = mocks.start;
    update = mocks.update;
    close = mocks.close;
  },
}));
function metadata(): RunMetadata {
  return {
    services: [{ name: "mail", url: "http://localhost:4000", port: 4000, source: "resend" }],
    dependencies: ["/tmp/emulate-watch/config.json"],
    directory: "/tmp/emulate-watch",
    watch: [],
    aliases: [],
    secrets: [{ service: "github", kind: "key", id: "1", label: "App", value: "private-value" }],
    retained: { mail: { emulator: "resend", input: "{}", config: { token: "private-value" }, secrets: [] } },
  };
}

class Worker extends EventEmitter {
  exitCode: number | null = null;
  signalCode = null;
  connected = true;
  send = vi.fn((message: { type: string }, callback?: (error: null) => void) => {
    queueMicrotask(() => {
      if (message.type === "close") {
        this.connected = false;
        this.exitCode = 0;
        this.emit("message", { type: "closed" });
        this.emit("exit", 0);
      } else if (message.type === "prepare") {
        if (this.error) {
          this.emit("message", { type: "dependencies", dependencies: ["/tmp/emulate-watch/missing.ts"] });
          this.emit("message", { type: "error", error: this.error });
        } else this.emit("message", { type: "prepared", metadata: this.metadata });
      } else if (message.type === "start") this.emit("message", { type: "started" });
      callback?.(null);
    });
    return true;
  });
  kill = vi.fn(() => true);

  constructor(
    readonly metadata: RunMetadata,
    readonly error?: string,
  ) {
    super();
  }
}

const runs: Array<{ close(): Promise<void> }> = [];
const sendDescriptor = Object.getOwnPropertyDescriptor(process, "send");
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(process, "send", {
    value: vi.fn((message: unknown, ...args: unknown[]) => {
      if (message && typeof message === "object" && "type" in message)
        if (message.type === "emulate:ready" || message.type === "emulate:error") return true;
      return sendDescriptor?.value?.call(process, message, ...args);
    }),
    configurable: true,
    writable: true,
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
});
afterEach(async () => {
  await Promise.all(runs.splice(0).map((run) => run.close()));
  vi.restoreAllMocks();
  if (sendDescriptor) Object.defineProperty(process, "send", sendDescriptor);
  else Reflect.deleteProperty(process, "send");
});

it.each(["start", "watch", "watch-ready"])("rolls back secrets when stopped before readiness: %s", async (mode) => {
  const watch = mode !== "start";
  mocks.fork.mockReturnValue(new Worker(metadata()));
  let resumeWatch!: () => void;
  if (mode === "watch-ready")
    mocks.update.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resumeWatch = resolve;
        }),
    );
  vi.spyOn(secretsFile, "preflightGeneratedSecretsFile").mockResolvedValue({
    path: "/tmp/stopped-secrets.json",
    parent: "/tmp",
    platform: "linux",
  });
  let publish!: (file: secretsFile.PublishedGeneratedSecretsFile) => void;
  vi.spyOn(secretsFile, "publishGeneratedSecretsFile").mockReturnValue(
    new Promise((resolve) => {
      publish = resolve;
    }),
  );
  const starting = projectStartCommand({
    port: 4000,
    service: "resend",
    watch,
    generatedSecretsFile: "/tmp/stopped-secrets.json",
  }).catch((error) => error);
  await vi.waitFor(() => expect(secretsFile.publishGeneratedSecretsFile).toHaveBeenCalledOnce());
  let artifactExists = true;
  const artifact = {
    path: "/tmp/stopped-secrets.json",
    identity: { dev: 1n, ino: 1n },
    rollback: async () => {
      artifactExists = false;
    },
  };
  if (mode === "watch-ready") {
    publish(artifact);
    await vi.waitFor(() => expect(mocks.update).toHaveBeenCalledOnce());
  }
  process.listeners("SIGTERM").at(-1)!("SIGTERM");
  try {
    await new Promise((resolve) => setImmediate(resolve));
    expect(process.exit).not.toHaveBeenCalled();
  } finally {
    if (mode === "watch-ready") resumeWatch();
    else publish(artifact);
  }
  await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
  expect(artifactExists).toBe(false);
  const result = await starting;
  if (watch) await result.close();
  else expect(result).toEqual(new Error("Emulator startup stopped"));
});

it.each([false, true])("keeps published secrets after a ready run closes: watch=%s", async (watch) => {
  mocks.fork.mockReturnValue(new Worker(metadata()));
  vi.spyOn(secretsFile, "preflightGeneratedSecretsFile").mockResolvedValue({
    path: "/tmp/ready-secrets.json",
    parent: "/tmp",
    platform: "linux",
  });
  let artifactExists = true;
  vi.spyOn(secretsFile, "publishGeneratedSecretsFile").mockResolvedValue({
    path: "/tmp/ready-secrets.json",
    identity: { dev: 1n, ino: 1n },
    rollback: async () => {
      artifactExists = false;
    },
  });
  const run = await projectStartCommand({
    port: 18495,
    service: "resend",
    watch,
    generatedSecretsFile: "/tmp/ready-secrets.json",
  });
  expect(process.send).toHaveBeenCalledWith(
    { type: "emulate:ready", text: expect.stringContaining(watch ? "Watching imports" : "Ready.") },
    expect.any(Function),
  );
  await run.close();
  expect(artifactExists).toBe(true);
});

it("reports a rejected publish only to its caller", async () => {
  vi.spyOn(secretsFile, "preflightGeneratedSecretsFile").mockResolvedValue({
    path: "/tmp/failed-secrets.json",
    parent: "/tmp",
    platform: "linux",
  });
  const error = new Error("publish failed");
  vi.spyOn(secretsFile, "publishGeneratedSecretsFile").mockRejectedValue(error);
  await expect(
    projectStartCommand({ port: 18495, service: "resend", generatedSecretsFile: "/tmp/failed-secrets.json" }),
  ).rejects.toBe(error);
  expect(console.error).not.toHaveBeenCalled();
});

describe("CLI watch lifecycle", () => {
  it("reports a failed initial load and recovers when a missing dependency is created", async () => {
    const broken = new Worker(metadata(), "Missing import");
    const recovered = new Worker(metadata());
    mocks.fork.mockReturnValueOnce(broken).mockReturnValueOnce(recovered);
    const run = await projectStartCommand({ port: 4000, watch: true });
    runs.push(run);
    expect(process.send).toHaveBeenLastCalledWith(
      { type: "emulate:error", error: "Missing import" },
      expect.any(Function),
    );
    expect(mocks.update).toHaveBeenCalledWith(expect.any(Set), [], true);
    expect([...mocks.update.mock.calls[0][0]]).toContain("/tmp/emulate-watch/missing.ts");
    mocks.change?.("/tmp/emulate-watch/missing.ts");
    await vi.waitFor(() =>
      expect(process.send).toHaveBeenLastCalledWith(
        { type: "emulate:ready", text: expect.stringContaining("Watching imports") },
        expect.any(Function),
      ),
    );
    expect(console.log).not.toHaveBeenCalled();
    expect(broken.connected).toBe(false);
  });
});

it.each(["SIGTERM", "disconnect"] as const)("propagates shutdown failure on %s", async (event) => {
  mocks.fork.mockReturnValue(new Worker(metadata()));
  const run = await projectStartCommand({ port: 4000, watch: true });
  mocks.close.mockRejectedValueOnce(new Error("Watcher close failed"));
  const listeners = event === "SIGTERM" ? process.listeners("SIGTERM") : process.listeners("disconnect");
  listeners.at(-1)!("SIGTERM");
  await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
  expect(console.error).toHaveBeenCalledWith(expect.any(AggregateError));
  await expect(run.close()).rejects.toThrow("Failed to shut down watch");
});
