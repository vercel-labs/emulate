import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNativeBinary } from "./native.js";

export const SERVICE_NAMES = [
  "vercel",
  "github",
  "google",
  "slack",
  "apple",
  "microsoft",
  "okta",
  "aws",
  "resend",
  "stripe",
  "mongoatlas",
  "clerk",
] as const;

export type ServiceName = (typeof SERVICE_NAMES)[number];

export interface SeedConfig {
  tokens?: Record<string, { login: string; scopes?: string[] }>;
  [service: string]: unknown;
}

export interface EmulatorOptions {
  service: ServiceName;
  port?: number;
  seed?: SeedConfig;
  baseUrl?: string;
  startupTimeoutMs?: number;
}

export interface Emulator {
  url: string;
  reset(): Promise<void>;
  close(): Promise<void>;
}

interface NativeRuntime {
  child: ChildProcess;
  exit: Promise<void>;
  output: string[];
}

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 5_000;
const serviceSet = new Set<string>(SERVICE_NAMES);

export async function createEmulator(options: EmulatorOptions): Promise<Emulator> {
  const { service, port = 4000, startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS } = options;
  if (!serviceSet.has(service)) {
    throw new Error(`Unknown service: ${service}`);
  }

  const resolved = resolveNativeBinary();
  if (!resolved.ok) {
    throw new Error(resolved.message);
  }
  const binary = resolved.path;

  const url = options.baseUrl ?? `http://localhost:${port}`;
  const seed = await prepareSeed(options.seed);
  let runtime = await startRuntime({
    binary,
    service,
    port,
    seedPath: seed.path,
    baseUrl: options.baseUrl,
    startupTimeoutMs,
  });

  async function restart(): Promise<void> {
    await closeRuntime(runtime);
    runtime = await startRuntime({
      binary,
      service,
      port,
      seedPath: seed.path,
      baseUrl: options.baseUrl,
      startupTimeoutMs,
    });
  }

  return {
    url,
    async reset() {
      await restart();
    },
    async close() {
      await closeRuntime(runtime);
      await seed.cleanup();
    },
  };
}

async function prepareSeed(seed: SeedConfig | undefined): Promise<{ path?: string; cleanup(): Promise<void> }> {
  if (!seed) {
    return { cleanup: async () => {} };
  }
  const dir = await mkdtemp(join(tmpdir(), "emulate-api-"));
  const path = join(dir, "seed.json");
  await writeFile(path, JSON.stringify(seed, null, 2));
  return {
    path,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function startRuntime(options: {
  binary: string;
  service: ServiceName;
  port: number;
  seedPath?: string;
  baseUrl?: string;
  startupTimeoutMs: number;
}): Promise<NativeRuntime> {
  const args = ["start", "--service", options.service, "--port", String(options.port)];
  if (options.seedPath) {
    args.push("--seed", options.seedPath);
  }
  if (options.baseUrl) {
    args.push("--base-url", options.baseUrl);
  }

  const child = spawn(options.binary, args, { stdio: ["ignore", "pipe", "pipe"] });
  const output: string[] = [];
  const capture = (chunk: Buffer) => {
    output.push(chunk.toString());
    if (output.length > 40) {
      output.shift();
    }
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);

  const exit = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  child.once("error", (error) => {
    output.push(error.message);
  });

  const runtime = { child, exit, output };
  try {
    await waitForReady(runtime, `http://127.0.0.1:${options.port}/_emulate/health`, options.startupTimeoutMs);
  } catch (error) {
    await closeRuntime(runtime);
    throw error;
  }
  return runtime;
}

async function waitForReady(runtime: NativeRuntime, healthUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (runtime.child.exitCode != null || runtime.child.signalCode != null) {
      throw new Error(`Native emulate process exited before it was ready.\n${runtime.output.join("")}`.trim());
    }
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        return;
      }
    } catch {
      // Server is still starting.
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for native emulate process.\n${runtime.output.join("")}`.trim());
}

async function closeRuntime(runtime: NativeRuntime): Promise<void> {
  if (runtime.child.exitCode != null || runtime.child.signalCode != null) {
    return;
  }
  runtime.child.kill("SIGTERM");
  const closed = await Promise.race([runtime.exit.then(() => true), delay(CLOSE_TIMEOUT_MS).then(() => false)]);
  if (!closed && runtime.child.exitCode == null && runtime.child.signalCode == null) {
    runtime.child.kill("SIGKILL");
    await runtime.exit;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
