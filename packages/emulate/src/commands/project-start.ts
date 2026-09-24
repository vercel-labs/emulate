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
  console.log("\nemulate\n");
  for (const service of metadata.services) {
    console.log(`  ${service.name}  ${service.url}\n    Source: ${service.source}`);
    if (service.inspectorUrl)
      console.log(`    Inspector: ${service.inspectorUrl}\n    Routes: ${service.inspectorUrl}?tab=routes`);
  }
  console.log(`\n  ${watching ? "Watching imports and fixtures. Reloads reset state to seed." : "Ready."}`);
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

export async function projectStartCommand(options: ProjectOptions): Promise<void> {
  const target = options.generatedSecretsFile
    ? await preflightGeneratedSecretsFile(options.generatedSecretsFile)
    : undefined;
  let published: PublishedGeneratedSecretsFile | undefined;
  let deliveredSecrets: string | undefined;
  let aliases: PortlessAlias[] = [];
  if (!options.watch) {
    const run = await prepareProject(options);
    try {
      if (target)
        published = await publishGeneratedSecretsFile(target, {
          schemaVersion: 1,
          generatedSecrets: run.metadata.secrets,
        });
      if (options.portless) {
        await ensurePortless({ throwOnFailure: true });
        registerAliases(run.metadata.aliases);
        aliases = run.metadata.aliases;
      }
      await run.start();
      printReady(run.metadata, false);
    } catch (error) {
      await run.close().catch(console.error);
      removeAliases(aliases);
      await published?.rollback();
      throw error;
    }
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      void run
        .close()
        .catch(console.error)
        .finally(() => {
          removeAliases(aliases);
          process.exit(0);
        });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
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
  async function reload() {
    if (stopped) return;
    if (loading) {
      queued = true;
      return;
    }
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
      if (stopped) {
        await stop(candidate);
        return;
      }
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
        await ensurePortless({ throwOnFailure: true });
        if (stopped) return;
        registerAliases(metadata.aliases);
        aliases = metadata.aliases;
      }
      const started = receive(candidate, "started");
      candidate.send({ type: "start" });
      await started;
      if (stopped) {
        await stop(candidate);
        return;
      }
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
        console.error(`Emulator runner exited (${signal ?? code}). Save a source file to restart.`);
      });
      retained = metadata.retained;
      successful = true;
      failed = false;
      await watcher.update(dependencies, patterns, false);
      printReady(metadata, true);
    } catch (error) {
      failed = true;
      dependencies = new Set([...dependencies, ...attemptedDependencies]);
      await watcher.update(dependencies, patterns, true);
      console.error(
        `\nReload failed${worker ? "; serving the last successful version" : ""}. Fix the source and save to retry.\n${error instanceof Error ? error.message : error}`,
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
        void reload();
      }
    }
  }
  const watcher = new ProjectWatcher(
    directory,
    (path) => {
      if (stopped || (options.generatedSecretsFile && path === resolve(options.generatedSecretsFile))) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        void reload();
      }, 100);
    },
    (error) => console.error("Watch error:", error),
  );
  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(debounce);
    void Promise.allSettled([watcher.close(), stop(worker), stop(candidate)]).finally(() => {
      removeAliases(aliases);
      process.exit(0);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await watcher.start();
  await reload();
}
