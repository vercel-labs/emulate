import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_SERVICE = "github";
const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_READY_INTERVAL_MS = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 1_000;
const DEFAULT_LOG_LIMIT_BYTES = 64 * 1024;

const harnessDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const repoRoot = path.resolve(harnessDir, "../..");

export async function allocatePort(host = DEFAULT_HOST) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        if (!address || typeof address === "string") {
          reject(new Error("Port allocation did not return a TCP address"));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

export function selectRuntime(env = process.env) {
  if (env.EMULATE_SDK_RUNTIME) return env.EMULATE_SDK_RUNTIME;
  if (env.EMULATE_TARGET_URL) return "external";
  return "cli";
}

export async function startRuntime(options = {}) {
  const env = { ...process.env, ...options.env };
  const runtime = options.runtime ?? selectRuntime(env);
  if (runtime === "external") {
    const target = connectRuntime({
      readinessPath: options.readinessPath ?? env.EMULATE_SDK_READY_PATH,
      url: options.url ?? options.targetUrl ?? env.EMULATE_TARGET_URL,
      runtime,
      service: options.service,
    });
    if (target.readyUrl) {
      await waitForHttp(target.readyUrl, {
        timeoutMs: options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
        intervalMs: options.readyIntervalMs ?? DEFAULT_READY_INTERVAL_MS,
        requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      });
    }
    return target;
  }

  const service = options.service ?? DEFAULT_SERVICE;
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? (await allocatePort(host));
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? `http://${host}:${port}`);
  const spec = await runtimeCommand({ ...options, baseUrl, env, host, port, runtime, service });
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: {
      ...env,
      ...options.processEnv,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = captureLogs(child, options.logLimitBytes ?? DEFAULT_LOG_LIMIT_BYTES);
  const exit = waitForExit(child);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      await stopChild(child, exit, options.stopTimeoutMs);
    } finally {
      await spec.cleanup?.();
    }
  };
  const readinessPath = options.readinessPath ?? env.EMULATE_SDK_READY_PATH ?? spec.readinessPath;
  const readyUrl = new URL(readinessPath, `${baseUrl}/`).toString();

  try {
    await Promise.race([
      waitForHttp(readyUrl, {
        timeoutMs: options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
        intervalMs: options.readyIntervalMs ?? DEFAULT_READY_INTERVAL_MS,
        requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      }),
      exit.then((result) => {
        throw runtimeExitError(spec.label, result);
      }),
    ]);
  } catch (err) {
    await stop();
    throw withRuntimeLogs(err, spec.label, logs);
  }

  return {
    baseUrl,
    child,
    logs,
    port,
    readyUrl,
    runtime,
    service,
    stop,
  };
}

export function connectRuntime(options = {}) {
  const baseUrl = normalizeBaseUrl(options.url ?? options.targetUrl);
  if (!baseUrl) {
    throw new Error("External runtime selected but no target URL was provided");
  }
  return {
    baseUrl,
    child: null,
    logs: emptyLogs(),
    port: null,
    readyUrl: options.readinessPath ? new URL(options.readinessPath, `${baseUrl}/`).toString() : null,
    runtime: options.runtime ?? "external",
    service: options.service ?? DEFAULT_SERVICE,
    stop: async () => {},
  };
}

export async function waitForHttp(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_READY_INTERVAL_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const acceptStatus = options.acceptStatus ?? ((status) => status >= 200 && status < 500);
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() <= deadline) {
    try {
      const result = await fetchWithTimeout(url, requestTimeoutMs);
      if (acceptStatus(result.status, result.body)) {
        return result;
      }
      lastError = new Error(`GET ${url} returned ${result.status}`);
    } catch (err) {
      lastError = err;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }

  const reason = lastError ? ` Last error: ${formatError(lastError)}` : "";
  throw new Error(`Timed out waiting for ${url}.${reason}`);
}

async function runtimeCommand(options) {
  if (options.runtime === "cli" || options.runtime === "typescript") return cliCommand(options);
  if (options.runtime === "go") return goCommand(options);
  throw new Error(`Unsupported runtime: ${options.runtime}`);
}

async function cliCommand(options) {
  const cliPath =
    options.cliPath ?? options.env.EMULATE_CLI ?? options.env.EMULATE_TYPESCRIPT_CLI ?? path.join(repoRoot, "packages/emulate/dist/index.js");
  await assertExecutableFile(cliPath, "emulate CLI");
  const workingDirectory = await runtimeWorkingDirectory(options);
  return {
    args: [
      cliPath,
      "start",
      "--port",
      String(options.port),
      "--service",
      options.service,
      "--base-url",
      options.baseUrl,
    ],
    command: process.execPath,
    cwd: workingDirectory.cwd,
    cleanup: workingDirectory.cleanup,
    label: "emulate CLI runtime",
    readinessPath: "/rate_limit",
  };
}

async function goCommand(options) {
  const binary = options.binary ?? options.env.EMULATE_GO_BINARY;
  if (!binary) {
    throw new Error("Go runtime selected but no binary was provided");
  }
  await assertExecutableFile(binary, "Go runtime binary");
  const workingDirectory = await runtimeWorkingDirectory(options);
  return {
    args: ["start", "--port", String(options.port), "--service", options.service, "--base-url", options.baseUrl],
    command: binary,
    cwd: workingDirectory.cwd,
    cleanup: workingDirectory.cleanup,
    label: "Go runtime",
    readinessPath: "/_emulate/health",
  };
}

async function runtimeWorkingDirectory(options) {
  if (options.cwd) {
    return { cwd: options.cwd, cleanup: null };
  }
  const cwd = await mkdtemp(path.join(os.tmpdir(), "emulate-sdk-js-"));
  return {
    cwd,
    cleanup: async () => {
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

async function assertExecutableFile(filePath, label) {
  try {
    await access(filePath);
  } catch {
    throw new Error(`${label} not found at ${filePath}`);
  }
}

function captureLogs(child, maxBytes) {
  const logs = {
    stderr: "",
    stdout: "",
    text() {
      return formatRuntimeLogs(logs);
    },
  };
  child.stdout?.on("data", (chunk) => {
    logs.stdout = appendBounded(logs.stdout, chunk, maxBytes);
  });
  child.stderr?.on("data", (chunk) => {
    logs.stderr = appendBounded(logs.stderr, chunk, maxBytes);
  });
  return logs;
}

function emptyLogs() {
  return {
    stderr: "",
    stdout: "",
    text() {
      return formatRuntimeLogs(this);
    },
  };
}

function appendBounded(current, chunk, maxBytes) {
  const next = current + Buffer.from(chunk).toString("utf8");
  if (Buffer.byteLength(next) <= maxBytes) return next;
  return Buffer.from(next).subarray(-maxBytes).toString("utf8");
}

function formatRuntimeLogs(logs) {
  return [
    "stdout:",
    logs.stdout.trimEnd() || "(empty)",
    "",
    "stderr:",
    logs.stderr.trimEnd() || "(empty)",
  ].join("\n");
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function runtimeExitError(label, result) {
  if (result.error) {
    return new Error(`${label} failed to start: ${formatError(result.error)}`);
  }
  return new Error(`${label} exited before it became ready with code ${result.code} and signal ${result.signal}`);
}

async function stopChild(child, exit, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const result = await Promise.race([exit, sleep(timeoutMs).then(() => null)]);
  if (result) return;
  child.kill("SIGKILL");
  await exit;
}

function withRuntimeLogs(err, label, logs) {
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`${label} readiness failed: ${message}\n${logs.text()}`);
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return {
      status: response.status,
      body: await response.text(),
    };
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeBaseUrl(url) {
  if (!url) return "";
  return String(url).replace(/\/+$/, "");
}

function formatError(err) {
  return err instanceof Error ? err.message : String(err);
}
