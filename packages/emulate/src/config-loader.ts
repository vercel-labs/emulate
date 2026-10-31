import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, extname } from "node:path";
import { parseDocument } from "yaml";
import { ProjectLoader } from "./project-loader.js";
import { assertEmulatorDefinition, type EmulatorDefinition, type PersistenceAdapter } from "@emulators/core";
import { SERVICE_NAMES, SERVICE_REGISTRY, type ServiceName } from "./registry.js";
import type { EmulateConfig, ServiceConfig } from "./config.js";

export const CONFIG_FILES = [
  "emulate.config.ts",
  "emulate.config.mts",
  "emulate.config.js",
  "emulate.config.mjs",
  "emulate.config.yaml",
  "emulate.config.yml",
  "emulate.config.json",
  "service-emulator.config.yaml",
  "service-emulator.config.yml",
  "service-emulator.config.json",
];
export function findConfig(path?: string, cwd = process.cwd()): string | undefined {
  if (path) {
    const target = resolve(cwd, path);
    if (!existsSync(target)) throw new Error(`Config file not found: ${target}`);
    return target;
  }
  const candidates = CONFIG_FILES.map((name) => resolve(cwd, name)).filter(existsSync);
  if (candidates.length > 1)
    throw new Error(`Multiple config files found. Select one with --config:\n${candidates.join("\n")}`);
  return candidates[0];
}

export interface ResolvedService extends Omit<ServiceConfig, "emulator"> {
  name: string;
  emulator: ServiceName | EmulatorDefinition;
  source: string;
}
export interface LoadedConfig {
  path?: string;
  directory: string;
  services: ResolvedService[];
  tokens?: EmulateConfig["tokens"];
  watch: string[];
  loader: ProjectLoader;
}
const isRecord = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export const isBuiltin = (value: string): value is ServiceName => Object.hasOwn(SERVICE_REGISTRY, value);

export async function loadConfig(
  options: { config?: string; seed?: string; service?: string; cwd?: string } = {},
  onDependenciesChange?: (files: string[]) => void,
): Promise<LoadedConfig> {
  if (options.config && options.seed)
    throw new Error("--config and --seed select a config file and cannot be used together");
  const path = findConfig(options.config ?? options.seed, options.cwd);
  const directory = path ? dirname(path) : resolve(options.cwd ?? process.cwd());
  const loader = new ProjectLoader(directory);
  loader.onDependenciesChange = onDependenciesChange;
  try {
    let raw: Record<string, any> = {};
    if (path) {
      loader.dependencies.add(path);
      if ([".json", ".yaml", ".yml"].includes(extname(path))) {
        const doc = parseDocument(readFileSync(path, "utf8"), { uniqueKeys: true });
        if (doc.errors.length) throw new Error(`Invalid config ${path}: ${doc.errors[0].message}`);
        raw = doc.toJS();
      } else raw = (await loader.load(path)) as typeof raw;
      if (!isRecord(raw)) throw new Error(`${path} must export a configuration object`);
    }
    const unknown = Object.keys(raw).filter((key) => ![...SERVICE_NAMES, "services", "tokens", "watch"].includes(key));
    if (unknown.length)
      throw new Error(`Unknown config key: ${unknown.join(", ")}. Register custom APIs under services.`);
    if (raw.services !== undefined && !isRecord(raw.services))
      throw new Error("services must be an object of named emulators");
    if (raw.watch !== undefined && (!Array.isArray(raw.watch) || raw.watch.some((v: unknown) => typeof v !== "string")))
      throw new Error("watch must be an array of paths or glob patterns");
    if (
      raw.tokens !== undefined &&
      (!isRecord(raw.tokens) ||
        Object.values(raw.tokens).some(
          (v) =>
            !isRecord(v) ||
            typeof v.login !== "string" ||
            (v.scopes !== undefined &&
              (!Array.isArray(v.scopes) || v.scopes.some((s: unknown) => typeof s !== "string"))),
        ))
    )
      throw new Error("tokens must map token strings to { login, scopes? }");
    const entries: Record<string, ServiceConfig> = { ...raw.services };
    for (const name of SERVICE_NAMES)
      if (Object.hasOwn(raw, name)) {
        if (Object.hasOwn(entries, name))
          throw new Error(`Service ${name} is defined in both legacy config and services`);
        if (!isRecord(raw[name])) throw new Error(`${name} seed config must be an object`);
        entries[name] = { emulator: name, seed: raw[name], port: raw[name].port, baseUrl: raw[name].baseUrl };
      }
    const selected = options.service
      ? options.service.split(",").map((v) => v.trim())
      : Object.keys(entries).length || raw.services
        ? Object.keys(entries)
        : [...SERVICE_NAMES];
    if (!selected.length || selected.some((s) => !s)) throw new Error("Select at least one service");
    if (new Set(selected).size !== selected.length) throw new Error("A service cannot be selected more than once");
    const services: ResolvedService[] = [];
    for (const name of selected) {
      if (!/^[a-z][a-z0-9-]*$/.test(name))
        throw new Error(`Invalid service name "${name}". Use lowercase letters, digits, and hyphens.`);
      const entry = entries[name] ?? (isBuiltin(name) ? { emulator: name } : undefined);
      if (!entry || !isRecord(entry)) throw new Error(`Unknown service: ${name}`);
      const extra = Object.keys(entry).filter(
        (key) => !["emulator", "seed", "port", "baseUrl", "inspector", "persistence"].includes(key),
      );
      if (extra.length) throw new Error(`services.${name}: unknown option ${extra.join(", ")}`);
      if (entry.port !== undefined && (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535))
        throw new Error(`services.${name}.port must be an integer from 1 to 65535`);
      if (entry.baseUrl !== undefined) {
        if (typeof entry.baseUrl !== "string") throw new Error(`services.${name}.baseUrl must be an HTTP URL`);
        const url = new URL(entry.baseUrl);
        if (!["http:", "https:"].includes(url.protocol))
          throw new Error(`services.${name}.baseUrl must be an HTTP URL`);
      }
      let emulator: unknown = entry.emulator;
      const source = typeof emulator === "string" ? emulator : (path ?? "inline definition");
      try {
        if (typeof emulator === "string" && !isBuiltin(emulator)) emulator = await loader.load(emulator);
        if (typeof emulator !== "string" || !isBuiltin(emulator)) assertEmulatorDefinition(emulator);
      } catch (error) {
        throw new Error(`services.${name}.emulator (${source}): ${error instanceof Error ? error.message : error}`, {
          cause: error,
        });
      }
      if (typeof emulator !== "string" || !isBuiltin(emulator)) {
        if (isBuiltin(name))
          throw new Error(`Custom service ${name} would replace a built-in. Choose another instance name.`);
      }
      const persistence = entry.persistence;
      if (
        persistence !== undefined &&
        typeof persistence !== "string" &&
        (!isRecord(persistence) || typeof persistence.load !== "function" || typeof persistence.save !== "function")
      )
        throw new Error(`services.${name}.persistence must be a file path or persistence adapter`);
      if (typeof emulator === "string" && (entry.inspector !== undefined || entry.persistence !== undefined))
        throw new Error(
          `services.${name}: inspector and persistence options apply to custom APIs; built-ins retain their own inspectors and adapter persistence`,
        );
      services.push({
        ...entry,
        name,
        emulator: emulator as ServiceName | EmulatorDefinition,
        source,
        persistence:
          typeof persistence === "string"
            ? resolve(directory, persistence)
            : (persistence as PersistenceAdapter | undefined),
      });
    }
    return { path, directory, services, tokens: raw.tokens, watch: raw.watch ?? [], loader };
  } catch (error) {
    loader.close();
    throw error;
  }
}
