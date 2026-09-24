import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes, type ModuleHooks } from "node:module";
import { dirname, extname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { ProjectPaths, sourceCandidates, sourceFile } from "./project-paths.js";

let transformTypesAvailable = true;

/** Scoped native hooks keep installed packages on Node's own exports/conditions resolver. */
export class ProjectLoader {
  readonly dependencies = new Set<string>();
  onDependenciesChange?: (files: string[]) => void;
  private readonly id = randomUUID();
  private readonly prefix = `emulate-project:${this.id}/`;
  private readonly cache = new Map<string, Promise<unknown>>();
  private readonly hooks: ModuleHooks;
  private closed = false;

  constructor(readonly directory: string) {
    const paths = new ProjectPaths(this.dependencies);
    const track = (files: Iterable<string>) => {
      let changed = false;
      for (const file of files) {
        if (this.dependencies.has(file)) continue;
        this.dependencies.add(file);
        changed = true;
      }
      if (changed) this.onDependenciesChange?.([...this.dependencies]);
    };
    const owns = (url?: string) => url?.startsWith("file:") && new URL(url).searchParams.get("emulate") === this.id;
    this.hooks = registerHooks({
      resolve: (specifier, context, nextResolve) => {
        const entry = specifier.startsWith(this.prefix);
        if (!entry && !owns(context.parentURL)) return nextResolve(specifier, context);
        const parentURL = entry ? pathToFileURL(join(directory, "package.json")).href : context.parentURL!;
        if (entry) specifier = specifier.slice(this.prefix.length);
        const local = specifier.startsWith(".") || isAbsolute(specifier) || specifier.startsWith("file:");
        let target = specifier;
        let missingCandidates: string[] = [];
        if (local) {
          const url = isAbsolute(specifier) ? pathToFileURL(specifier) : new URL(specifier, parentURL);
          const path = fileURLToPath(url);
          const file = sourceFile(path);
          if (file) target = pathToFileURL(file).href;
          else missingCandidates = sourceCandidates(path);
        } else if (!specifier.startsWith("node:")) {
          const previousSize = this.dependencies.size;
          const alias = paths.resolve(specifier, dirname(fileURLToPath(parentURL)), missingCandidates);
          if (this.dependencies.size !== previousSize) this.onDependenciesChange?.([...this.dependencies]);
          if (alias) target = pathToFileURL(alias).href;
        }
        let result;
        try {
          result = nextResolve(target, { ...context, parentURL });
        } catch (error) {
          track(missingCandidates);
          if (entry && !local)
            throw new Error(
              `Cannot load emulator package "${specifier}" from ${directory}. Install it in this project with npm install ${specifier}.`,
              { cause: error },
            );
          throw error;
        }
        if (!result.url.startsWith("file:")) return result;
        const file = fileURLToPath(result.url);
        // Installed dependencies are shared. Workspace source and local imports belong to this graph.
        if (
          /[/\\]node_modules[/\\]/.test(file) ||
          specifier === "emulate" ||
          specifier.startsWith("emulate/") ||
          specifier.startsWith("@emulators/")
        )
          return result;
        track([file]);
        const url = new URL(result.url);
        url.searchParams.set("emulate", this.id);
        return {
          ...result,
          url: url.href,
          ...(extname(file) === ".json" ? { importAttributes: { type: "json" } } : {}),
        };
      },
      load: (url, context, nextLoad) => {
        if (!owns(url)) return nextLoad(url, context);
        const file = fileURLToPath(url);
        const extension = extname(file);
        if (![".ts", ".mts", ".js", ".mjs"].includes(extension) || context.format === "commonjs")
          return nextLoad(url, context);
        const originalURL = pathToFileURL(file).href;
        let source = readFileSync(file, "utf8").replace(/^#![^\r\n]*/, "");
        if (extension === ".ts" || extension === ".mts") {
          try {
            if (transformTypesAvailable) {
              try {
                source = stripTypeScriptTypes(source, { mode: "transform", sourceMap: true, sourceUrl: originalURL });
              } catch (error) {
                if (
                  error instanceof TypeError &&
                  "code" in error &&
                  error.code === "ERR_INVALID_ARG_VALUE" &&
                  error.message.includes("options.mode")
                )
                  transformTypesAvailable = false;
                else throw error;
              }
            }
            if (!transformTypesAvailable) {
              // Strip mode preserves positions, so the identity map only accounts for the injected line.
              source = stripTypeScriptTypes(source, { mode: "strip", sourceUrl: originalURL });
              const map = {
                version: 3,
                sources: [originalURL],
                names: [],
                mappings: ";AAAA" + ";AACA".repeat(source.split("\n").length - 1),
              };
              source +=
                "\n//# sourceMappingURL=data:application/json;base64," +
                Buffer.from(JSON.stringify(map)).toString("base64");
            }
          } catch (error) {
            throw new Error(`Cannot load ${file}: ${error instanceof Error ? error.message : error}`, { cause: error });
          }
          if (transformTypesAvailable) {
            // A separate generated line keeps every original line/column in the native source map intact.
            source = source.replace(
              /(\/\/# sourceMappingURL=data:application\/json;base64,)([^\s]+)/,
              (_match, prefix, encoded) => {
                const map = JSON.parse(Buffer.from(encoded, "base64").toString());
                map.mappings = ";" + map.mappings;
                return prefix + Buffer.from(JSON.stringify(map)).toString("base64");
              },
            );
          }
        } else {
          const map = {
            version: 3,
            sources: [originalURL],
            names: [],
            mappings: ";AAAA" + ";AACA".repeat(source.split("\n").length - 1),
          };
          source += `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}`;
        }
        return {
          format: "module",
          shortCircuit: true,
          source: `import.meta.url = ${JSON.stringify(originalURL)};\n${source}`,
        };
      },
    });
  }

  load(specifier: string): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Project loader is closed"));
    if (!this.cache.has(specifier))
      this.cache.set(
        specifier,
        (async () => {
          // Keep project imports in Node's loader even when the calling app uses a module runner (such as Vitest).
          const bridge = "data:text/javascript,export default (specifier) => import(specifier)";
          const nativeImport = (await import(bridge)).default;
          return (await nativeImport(this.prefix + specifier)).default;
        })(),
      );
    return this.cache.get(specifier)!;
  }

  close(): void {
    this.closed = true;
    this.onDependenciesChange = undefined;
    this.hooks.deregister();
    this.cache.clear();
  }
}
