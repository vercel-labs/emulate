import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";

export function sourceCandidates(path: string): string[] {
  const candidates = [path];
  if (/\.[cm]?js$/.test(path)) candidates.push(path.replace(/js$/, "ts"));
  if (!extname(path)) candidates.push(...[".ts", ".mts", ".js", ".mjs", ".json"].map((ext) => path + ext));
  candidates.push(...["index.ts", "index.mts", "index.js", "index.mjs"].map((name) => join(path, name)));
  return candidates;
}

export function sourceFile(path: string): string | undefined {
  return sourceCandidates(path).find((candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

// JSONC permits comments and trailing commas. Preserve quoted strings verbatim and never evaluate configuration.
function jsonc(source: string): any {
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g;
  const comments = source.replace(tokens, (token) => (token.startsWith('"') ? token : token.replace(/[^\r\n]/g, " ")));
  return JSON.parse(
    comments
      .replace(/"(?:\\[\s\S]|[^"\\])*"|,\s*(?=[}\]])/g, (token) => (token.startsWith(",") ? "" : token))
      .replace(/^\uFEFF/, ""),
  );
}

interface PathConfig {
  baseUrl?: string;
  paths?: Record<string, string[]>;
  pathsDirectory?: string;
}

export class ProjectPaths {
  private readonly configs = new Map<string, PathConfig>();
  private readonly directories = new Map<string, PathConfig>();
  constructor(private readonly dependencies: Set<string>) {}

  private read(path: string, visiting = new Set<string>()): PathConfig {
    const cached = this.configs.get(path);
    if (cached) return cached;
    if (visiting.has(path)) throw new Error(`Circular tsconfig extends: ${path}`);
    visiting.add(path);
    this.dependencies.add(path);
    let raw;
    try {
      raw = jsonc(readFileSync(path, "utf8"));
    } catch (error) {
      throw new Error(`Cannot read TypeScript configuration ${path}`, { cause: error });
    }
    const directory = dirname(path);
    let config: PathConfig = {};
    for (const base of Array.isArray(raw.extends) ? raw.extends : raw.extends ? [raw.extends] : []) {
      let file;
      if (base.startsWith(".") || isAbsolute(base)) {
        const target = resolve(directory, base);
        file = [target, `${target}.json`, join(target, "tsconfig.json")].find((candidate) => {
          try {
            return statSync(candidate).isFile();
          } catch {
            return false;
          }
        });
      } else {
        const require = createRequire(path);
        try {
          file = require.resolve(base);
        } catch {
          file = require.resolve(`${base}/tsconfig.json`);
        }
      }
      if (!file) throw new Error(`Cannot resolve tsconfig extends "${base}" from ${path}`);
      config = { ...config, ...this.read(file, visiting) };
    }
    const options = raw.compilerOptions ?? {};
    if (options.baseUrl !== undefined) config.baseUrl = resolve(directory, options.baseUrl);
    if (options.paths !== undefined) {
      config.paths = options.paths;
      config.pathsDirectory = directory;
    }
    visiting.delete(path);
    this.configs.set(path, config);
    return config;
  }

  private nearest(directory: string): PathConfig {
    const cached = this.directories.get(directory);
    if (cached) return cached;
    const path = join(directory, "tsconfig.json");
    // Track missing configs too, so adding a nearer configuration causes a reload.
    this.dependencies.add(path);
    const parent = dirname(directory);
    const config = existsSync(path) ? this.read(path) : parent === directory ? {} : this.nearest(parent);
    this.directories.set(directory, config);
    return config;
  }

  resolve(specifier: string, directory: string, missingCandidates: string[] = []): string | undefined {
    const config = this.nearest(directory);
    const keys = Object.keys(config.paths ?? {}).sort((a, b) => {
      if (a === specifier) return -1;
      if (b === specifier) return 1;
      return b.split("*")[0].length - a.split("*")[0].length;
    });
    for (const key of keys) {
      const [prefix, suffix] = key.split("*");
      const wildcard = suffix !== undefined;
      if (
        wildcard
          ? !specifier.startsWith(prefix) ||
            !specifier.endsWith(suffix) ||
            specifier.length < prefix.length + suffix.length
          : key !== specifier
      )
        continue;
      const matched = wildcard ? specifier.slice(prefix.length, specifier.length - suffix.length) : "";
      const values = config.paths![key];
      if (!Array.isArray(values) || values.some((value) => typeof value !== "string"))
        throw new Error(`TypeScript path "${key}" must contain an array of paths`);
      for (const target of values) {
        const path = resolve(config.baseUrl ?? config.pathsDirectory!, target.replace("*", matched));
        const file = sourceFile(path);
        if (file) return file;
        missingCandidates.push(...sourceCandidates(path));
      }
      break;
    }
    if (config.baseUrl) {
      const path = resolve(config.baseUrl, specifier);
      const file = sourceFile(path);
      if (file) return file;
      missingCandidates.push(...sourceCandidates(path));
    }
    return undefined;
  }
}
