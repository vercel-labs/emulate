import { spawn } from "node:child_process";
import { resolveNativeBinary } from "./native.js";

const args = process.argv.slice(2);
const resolved = resolveNativeBinary();

if (!resolved.ok) {
  console.error(resolved.message);
  process.exit(1);
}

const child = spawn(resolved.path, args, { stdio: "inherit" });
const forwardedSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

const forwardSignal = (signal: NodeJS.Signals) => {
  if (!child.killed) {
    child.kill(signal);
  }
};

for (const signal of forwardedSignals) {
  process.once(signal, () => forwardSignal(signal));
}

child.once("error", (error) => {
  console.error(`Failed to run native emulate binary: ${error.message}`);
  process.exit(1);
});

child.once("exit", (code, signal) => {
  for (const forwarded of forwardedSignals) {
    process.removeAllListeners(forwarded);
  }
  if (signal) {
    process.exit(exitCodeForSignal(signal));
  }
  process.exit(code ?? 1);
});

function exitCodeForSignal(signal: NodeJS.Signals): number {
  return 128 + (signalNumbers[signal] ?? 1);
}

const signalNumbers: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGKILL: 9,
  SIGTERM: 15,
};
