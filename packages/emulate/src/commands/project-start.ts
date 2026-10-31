import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { ProjectWatcher } from "../project-watcher.js";
import { CONFIG_FILES, findConfig } from "../config-loader.js";
import { prepareProject, type ProjectOptions, type RunMetadata, type RetainedSeed } from "../project-runner.js";
import { ensurePortless, registerAliases, removeAliases, type PortlessAlias } from "../portless.js";
import {
  preflightGeneratedSecretsFile,
  publishGeneratedSecretsFile,
  type PublishedGeneratedSecretsFile,
} from "../generated-secrets-file.js";

function printReady(metadata: RunMetadata, watching: boolean) {
  const lines = ["\nemulate\n"];
  for (const service of metadata.services) {
    lines.push(`  ${service.name}  ${service.url}\n    Source: ${service.source}`);
    if (service.inspectorUrl)
      lines.push(`    Inspector: ${service.inspectorUrl}\n    Routes: ${service.inspectorUrl}?tab=routes`);
  }
  lines.push(`\n  ${watching ? "Watching imports and fixtures. Reloads reset state to seed." : "Ready."}`);
  const text = lines.join("\n");
  if (process.connected) process.send?.({ type: "emulate:ready", text }, () => {});
  else console.log(text);
}

function receive(child: ChildProcess, wanted: string, timeout = 30000): Promise<any> {
  return new Promise((resolveMessage, reject) => {
    const cleanup = () => {
      child.off("message", message);
      child.off("exit", exit);
      child.off("error", error);
      clearTimeout(timer);
    };
    const message = (value: any) => {
      if (value.type === wanted) {
        cleanup();
        resolveMessage(value);
      } else if (value.type === "error") {
        cleanup();
        reject(new Error(value.error));
      }
    };
    const exit = (code: number | null) => {
      cleanup();
      reject(new Error(`Emulator runner exited (${code})`));
    };
    const error = (value: Error) => {
      cleanup();
      reject(value);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Emulator runner timed out waiting for ${wanted}`));
    }, timeout);
    child.on("message", message);
    child.once("exit", exit);
    child.once("error", error);
  });
}
async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (!child.connected) {
    child.kill("SIGKILL");
    return;
  }
  const done = receive(child, "closed", 7000);
  child.send({ type: "close" }, (error) => {
    if (error) child.kill("SIGKILL");
  });
  try {
    await done;
  } catch (error) {
    child.kill("SIGKILL");
    console.error(error instanceof Error ? error.message : error);
  }
}

export async function projectStartCommand(options: ProjectOptions): Promise<{ close(): Promise<void> }> {
  const controller = new AbortController();
  let cleanup: (() => Promise<void>) | undefined;
  let closing: Promise<void> | undefined;
  const run = {
    close() {
      return (closing ??= Promise.resolve().then(async () => {
        controller.abort(new Error("Emulator startup stopped"));
        try {
          await cleanup?.();
        } finally {
          process.off("SIGINT", shutdown);
          process.off("SIGTERM", shutdown);
          process.off("disconnect", shutdown);
          process.off("message", onMessage);
        }
      }));
    },
  };
  const shutdown = () => {
    if (closing) return;
    void run.close().then(
      () => process.exit(0),
      (error) => {
        console.error(error);
        process.exit(1);
      },
    );
  };
  const onMessage = (message: unknown) => {
    if (message && typeof message === "object" && "type" in message && message.type === "emulate:stop") shutdown();
  };
  process.on("message", onMessage);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("disconnect", shutdown);
  try {
    await startProject(options, controller.signal, (close) => {
      cleanup = close;
    });
    return run;
  } catch (error) {
    await run.close().catch(console.error);
    throw error;
  }
}

async function startProject(options: ProjectOptions, signal: AbortSignal, own: (close: () => Promise<void>) => void) {
  async function setupPortless(aliases: PortlessAlias[]) {
    await ensurePortless({ throwOnFailure: true, signal });
    signal.throwIfAborted();
    registerAliases(aliases);
  }
  const preflighting = options.generatedSecretsFile
    ? preflightGeneratedSecretsFile(options.generatedSecretsFile)
    : undefined;
  own(async () => {
    await preflighting?.catch(() => undefined);
  });
  const target = await preflighting;
  signal.throwIfAborted();
  let published: PublishedGeneratedSecretsFile | undefined;
  let deliveredSecrets: string | undefined;
  let aliases: PortlessAlias[] = [];
  if (!options.watch) {
    let preparing: ReturnType<typeof prepareProject> | undefined;
    let publishing: Promise<PublishedGeneratedSecretsFile> | undefined;
    let ready = false;
    const close = async () => {
      const run = await preparing?.catch((error) => {
        if (error instanceof AggregateError) throw error;
        return undefined;
      });
      try {
        await run?.close();
      } finally {
        removeAliases(aliases);
        if (!ready)
          await publishing?.then(
            (file) => file.rollback(),
            () => undefined,
          );
      }
    };
    own(close);
    signal.throwIfAborted();
    const run = await (preparing = prepareProject(options, {}, false, undefined, signal));
    signal.throwIfAborted();
    if (target)
      await (publishing = publishGeneratedSecretsFile(target, {
        schemaVersion: 1,
        generatedSecrets: run.metadata.secrets,
      }));
    signal.throwIfAborted();
    if (options.portless) {
      await setupPortless(run.metadata.aliases);
      aliases = run.metadata.aliases;
    }
    await run.start();
    signal.throwIfAborted();
    ready = true;
    printReady(run.metadata, false);
    return;
  }

  const configPath = findConfig(options.config ?? options.seed);
  const directory = configPath ? dirname(configPath) : process.cwd();
  const configCandidates = options.config || options.seed ? [] : CONFIG_FILES.map((name) => resolve(directory, name));
  let worker: ChildProcess | undefined;
  let candidate: ChildProcess | undefined;
  let retained: Record<string, RetainedSeed> = {};
  let dependencies = new Set<string>([...configCandidates, ...(configPath ? [configPath] : [])]);
  // A new worker has not executed lazy route imports yet. Keep watching files discovered by earlier generations.
  const lazyDependencies = new Set<string>();
  let patterns: string[] = [];
  let successful = false;
  let failed = false;
  let stopped = false;
  let queued = false;
  let loading = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let activeReload: Promise<void> | undefined;
  function queueReload(): Promise<void> {
    if (loading) {
      queued = true;
      return activeReload!;
    }
    return (activeReload = reload());
  }
  async function reload() {
    if (stopped) return;
    loading = true;
    const attemptedDependencies = new Set<string>();
    let candidateProcess: ChildProcess | undefined;
    const trackCandidateDependencies = (message: any) => {
      if (message.type === "dependencies")
        for (const file of message.dependencies as string[]) attemptedDependencies.add(file);
    };
    try {
      candidate = fork(fileURLToPath(new URL("./project-worker.js", import.meta.url)), [], {
        execArgv: ["--enable-source-maps"],
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      candidateProcess = candidate;
      candidate.on("message", trackCandidateDependencies);
      const prepared = receive(candidate, "prepared");
      candidate.send({ type: "prepare", options, retained, reload: successful });
      const { metadata } = (await prepared) as { metadata: RunMetadata };
      if (stopped) return;
      const secretsIdentity = JSON.stringify(metadata.secrets.map((secret) => JSON.stringify(secret)).sort());
      if (published && deliveredSecrets !== secretsIdentity)
        throw new Error(
          "Generated identities changed. Restart with a new --generated-secrets-file path to apply the change.",
        );
      if (target && !published) {
        published = await publishGeneratedSecretsFile(target, { schemaVersion: 1, generatedSecrets: metadata.secrets });
        deliveredSecrets = secretsIdentity;
      }
      await stop(worker);
      worker = undefined;
      if (stopped) return;
      removeAliases(aliases);
      aliases = [];
      if (options.portless) {
        await setupPortless(metadata.aliases);
        if (stopped) {
          removeAliases(metadata.aliases);
          return;
        }
        aliases = metadata.aliases;
      }
      const started = receive(candidate, "started");
      candidate.send({ type: "start" });
      await started;
      if (stopped) return;
      worker = candidate;
      candidate = undefined;
      dependencies = new Set([...configCandidates, ...metadata.dependencies, ...lazyDependencies]);
      patterns = metadata.watch.map((pattern) => resolve(directory, pattern));
      const running = worker;
      running.on("message", (message: any) => {
        if (worker !== running || stopped || message.type !== "dependencies") return;
        for (const file of message.dependencies as string[]) {
          if (!metadata.dependencies.includes(file)) lazyDependencies.add(file);
        }
        dependencies = new Set([...configCandidates, ...metadata.dependencies, ...lazyDependencies]);
        void watcher.update(dependencies, patterns, failed).catch(console.error);
      });
      running.once("exit", (code, signal) => {
        if (worker !== running || stopped) return;
        worker = undefined;
        failed = true;
        void watcher.update(dependencies, patterns, true).catch(console.error);
        removeAliases(aliases);
        aliases = [];
        const error = `Emulator runner exited (${signal ?? code}). Save a source file to restart.`;
        console.error(error);
      });
      retained = metadata.retained;
      failed = false;
      await watcher.update(dependencies, patterns, false);
      if (stopped) return;
      successful = true;
      printReady(metadata, true);
    } catch (error) {
      if (stopped) return;
      failed = true;
      dependencies = new Set([...dependencies, ...attemptedDependencies]);
      await watcher.update(dependencies, patterns, true);
      const message = `\nReload failed${worker ? "; serving the last successful version" : ""}. Fix the source and save to retry.\n${error instanceof Error ? error.message : error}`;
      console.error(message);
      if (!successful && process.connected)
        process.send?.(
          { type: "emulate:error", error: error instanceof Error ? error.message : String(error) },
          () => {},
        );
      await stop(candidate);
      candidate = undefined;
      if (!worker) {
        removeAliases(aliases);
        aliases = [];
      }
      if (!successful) {
        await published?.rollback();
        published = undefined;
        deliveredSecrets = undefined;
      }
    } finally {
      candidateProcess?.off("message", trackCandidateDependencies);
      loading = false;
      if (queued && !stopped) {
        queued = false;
        void queueReload();
      }
    }
  }
  const watcher = new ProjectWatcher(
    directory,
    (path) => {
      if (stopped || (options.generatedSecretsFile && path === resolve(options.generatedSecretsFile))) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        void queueReload();
      }, 100);
    },
    (error) => console.error("Watch error:", error),
  );
  own(async () => {
    stopped = true;
    clearTimeout(debounce);
    try {
      const results = await Promise.allSettled([watcher.close(), stop(worker), stop(candidate)]);
      await activeReload;
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (errors.length)
        throw new AggregateError(
          errors.map((result) => result.reason),
          "Failed to shut down watch",
        );
    } finally {
      removeAliases(aliases);
      if (!successful) await published?.rollback();
    }
  });
  await watcher.start();
  if (!stopped) await queueReload();
}
