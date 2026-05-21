import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const SUPPORTED_VERCEL_SERVICES = [
  "apple",
  "aws",
  "github",
  "google",
  "microsoft",
  "resend",
  "slack",
  "stripe",
  "vercel",
] as const;
export const DEFAULT_VERCEL_SERVICE_OPTION = SUPPORTED_VERCEL_SERVICES.join(",");
const REQUIRED_GO_VERSION = "1.24";
const DEFAULT_REWRITE = {
  source: "/emulate/:path*",
  destination: "/api/emulate?path=:path*",
};

export interface VercelInitOptions {
  service?: string;
  force?: boolean;
  cwd?: string;
  version: string;
}

export interface VercelScaffoldResult {
  created: string[];
  updated: string[];
  unchanged: string[];
  services: string[];
}

type VercelConfig = Record<string, unknown>;

interface PreparedVercelConfig {
  relativePath: string;
  target: string;
  existed: boolean;
  changed: boolean;
  content?: string;
}

export function vercelInitCommand(options: VercelInitOptions): void {
  try {
    const result = createVercelScaffold(options);
    for (const file of result.created) {
      console.log(`Created ${file}`);
    }
    for (const file of result.updated) {
      console.log(`Updated ${file}`);
    }
    for (const file of result.unchanged) {
      console.log(`Skipped existing ${file}`);
    }
    console.log(`\nVercel Go Function scaffold ready for: ${result.services.join(", ")}`);
    console.log(
      "State uses warm in-memory stores by default. Cold starts reset state, and concurrent instances can diverge.",
    );
    console.log(
      "Add a vercel.Persistence implementation in api/emulate.go when snapshots need to survive cold starts.",
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

export function createVercelScaffold(options: VercelInitOptions): VercelScaffoldResult {
  const cwd = resolve(options.cwd ?? process.cwd());
  const services = parseServiceList(options.service);
  const force = options.force ?? false;
  const vercelConfig = prepareVercelConfig(cwd, force);
  const result: VercelScaffoldResult = {
    created: [],
    updated: [],
    unchanged: [],
    services,
  };

  mkdirSync(join(cwd, "api"), { recursive: true });

  writeFileIfAllowed(cwd, "api/emulate.go", renderHandler(services), force, result);
  updateGoMod(cwd, options.version, result);
  writePreparedVercelConfig(vercelConfig, result);

  return result;
}

function parseServiceList(input: string | undefined): string[] {
  if (!input || input.trim() === "" || input.trim().toLowerCase() === "all") {
    return [...SUPPORTED_VERCEL_SERVICES];
  }
  const seen = new Set<string>();
  const services: string[] = [];
  for (const raw of input.split(",")) {
    const name = raw.trim().toLowerCase();
    if (!name || seen.has(name)) {
      continue;
    }
    if (!SUPPORTED_VERCEL_SERVICES.includes(name as (typeof SUPPORTED_VERCEL_SERVICES)[number])) {
      throw new Error(
        `The Vercel Go Function scaffold currently supports native services: ${SUPPORTED_VERCEL_SERVICES.join(", ")}`,
      );
    }
    seen.add(name);
    services.push(name);
  }
  if (services.length === 0) {
    return [...SUPPORTED_VERCEL_SERVICES];
  }
  return services;
}

function writeFileIfAllowed(
  cwd: string,
  relativePath: string,
  content: string,
  force: boolean,
  result: VercelScaffoldResult,
): void {
  const target = join(cwd, relativePath);
  if (existsSync(target) && !force) {
    result.unchanged.push(relativePath);
    return;
  }
  const existed = existsSync(target);
  writeFileSync(target, content, "utf-8");
  if (existed) {
    result.updated.push(relativePath);
  } else {
    result.created.push(relativePath);
  }
}

function updateGoMod(cwd: string, version: string, result: VercelScaffoldResult): void {
  const relativePath = "go.mod";
  const target = join(cwd, relativePath);
  const moduleVersion = normalizeGoModuleVersion(version);
  if (!existsSync(target)) {
    writeFileSync(target, renderGoMod(moduleVersion), "utf-8");
    result.created.push(relativePath);
    return;
  }

  const content = readFileSync(target, "utf-8");
  const existingVersion = getEmulateRequirementVersion(content);
  let nextContent = content;
  if (existingVersion !== moduleVersion) {
    nextContent = existingVersion
      ? updateEmulateRequirement(nextContent, moduleVersion)
      : addEmulateRequirement(nextContent, moduleVersion);
  }
  nextContent = ensureGoDirective(nextContent, REQUIRED_GO_VERSION);

  if (nextContent === content) {
    result.unchanged.push(relativePath);
    return;
  }

  writeFileSync(target, nextContent, "utf-8");
  result.updated.push(relativePath);
}

function getEmulateRequirementVersion(content: string): string | undefined {
  return content.match(/^[ \t]*(?:require[ \t]+)?github\.com\/vercel-labs\/emulate[ \t]+(v\S+)/m)?.[1];
}

function updateEmulateRequirement(content: string, moduleVersion: string): string {
  return content.replace(
    /^([ \t]*(?:require[ \t]+)?github\.com\/vercel-labs\/emulate[ \t]+)v\S+([ \t]*(?:\/\/.*)?$)/m,
    `$1${moduleVersion}$2`,
  );
}

function addEmulateRequirement(content: string, moduleVersion: string): string {
  const dependency = `github.com/vercel-labs/emulate ${moduleVersion}`;
  if (/^require\s*\(/m.test(content)) {
    return content.replace(/^require\s*\(\s*\n/m, (match) => `${match}\t${dependency}\n`);
  }
  const suffix = content.endsWith("\n") ? "" : "\n";
  return `${content}${suffix}\nrequire ${dependency}\n`;
}

function ensureGoDirective(content: string, requiredVersion: string): string {
  const directive = content.match(/^[ \t]*go[ \t]+(\S+)[ \t]*(?:\/\/.*)?$/m);
  if (directive) {
    const existingVersion = directive[1];
    if (compareGoVersions(existingVersion, requiredVersion) >= 0) {
      return content;
    }
    return content.replace(/^([ \t]*go[ \t]+)\S+([ \t]*(?:\/\/.*)?$)/m, `$1${requiredVersion}$2`);
  }

  if (/^module[ \t]+\S+[ \t]*(?:\/\/.*)?$/m.test(content)) {
    return content.replace(
      /^(module[ \t]+\S+[ \t]*(?:\/\/.*)?)(?:\r?\n)+/m,
      (_match, moduleLine: string) => `${moduleLine}\n\ngo ${requiredVersion}\n\n`,
    );
  }

  const suffix = content.endsWith("\n") ? "" : "\n";
  return `${content}${suffix}\ngo ${requiredVersion}\n`;
}

function compareGoVersions(left: string, right: string): number {
  const leftVersion = parseGoVersion(left);
  const rightVersion = parseGoVersion(right);
  if (!leftVersion || !rightVersion) {
    return left === right ? 0 : -1;
  }
  for (const key of ["major", "minor", "patch"] as const) {
    const diff = leftVersion[key] - rightVersion[key];
    if (diff !== 0) {
      return diff;
    }
  }
  if (leftVersion.rc === rightVersion.rc) {
    return 0;
  }
  if (leftVersion.rc === undefined) {
    return 1;
  }
  if (rightVersion.rc === undefined) {
    return -1;
  }
  return leftVersion.rc - rightVersion.rc;
}

function parseGoVersion(version: string): { major: number; minor: number; patch: number; rc?: number } | undefined {
  const match = version.match(/^(\d+)\.(\d+)(?:\.(\d+))?(?:rc(\d+))?$/);
  if (!match) {
    return undefined;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] ? Number(match[3]) : 0,
    rc: match[4] ? Number(match[4]) : undefined,
  };
}

function prepareVercelConfig(cwd: string, force: boolean): PreparedVercelConfig {
  const relativePath = "vercel.json";
  const target = join(cwd, relativePath);
  let config: VercelConfig = {
    $schema: "https://openapi.vercel.sh/vercel.json",
  };
  let existed = false;
  if (existsSync(target)) {
    existed = true;
    try {
      config = JSON.parse(readFileSync(target, "utf-8")) as VercelConfig;
    } catch (err) {
      throw new Error(`Failed to parse ${relativePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const rewrites = config.rewrites;
  if (rewrites !== undefined && !Array.isArray(rewrites)) {
    throw new Error(`${relativePath} rewrites must be an array to add the emulate preview route`);
  }

  const rewriteList = rewrites ?? [];
  const sameSource = rewriteList.find((entry) => isRewrite(entry) && entry.source === DEFAULT_REWRITE.source);
  if (sameSource && isRewrite(sameSource) && sameSource.destination !== DEFAULT_REWRITE.destination) {
    throw new Error(`${relativePath} already has a rewrite for ${DEFAULT_REWRITE.source}`);
  }

  const hasRewrite = rewriteList.some(isDefaultRewrite);
  const nextRewriteList = moveExistingRewriteBeforeCatchAll(hasRewrite ? rewriteList : insertRewrite(rewriteList));
  if (hasRewrite && !force && nextRewriteList === rewriteList) {
    return { relativePath, target, existed, changed: false };
  }
  config.rewrites = nextRewriteList;

  if (!("$schema" in config)) {
    config.$schema = "https://openapi.vercel.sh/vercel.json";
  }
  return {
    relativePath,
    target,
    existed,
    changed: true,
    content: `${JSON.stringify(config, null, 2)}\n`,
  };
}

function writePreparedVercelConfig(prepared: PreparedVercelConfig, result: VercelScaffoldResult): void {
  if (!prepared.changed) {
    result.unchanged.push(prepared.relativePath);
    return;
  }
  writeFileSync(prepared.target, prepared.content ?? "", "utf-8");

  if (prepared.existed) {
    result.updated.push(prepared.relativePath);
  } else {
    result.created.push(prepared.relativePath);
  }
}

function insertRewrite(rewriteList: unknown[]): unknown[] {
  const catchAllIndex = rewriteList.findIndex((entry) => isRewrite(entry) && isCatchAllSource(entry.source));
  if (catchAllIndex < 0) {
    return [...rewriteList, DEFAULT_REWRITE];
  }
  return [...rewriteList.slice(0, catchAllIndex), DEFAULT_REWRITE, ...rewriteList.slice(catchAllIndex)];
}

function moveExistingRewriteBeforeCatchAll(rewriteList: unknown[]): unknown[] {
  const rewriteIndex = rewriteList.findIndex(isDefaultRewrite);
  const catchAllIndex = rewriteList.findIndex((entry) => isRewrite(entry) && isCatchAllSource(entry.source));
  if (rewriteIndex < 0 || catchAllIndex < 0 || rewriteIndex < catchAllIndex) {
    return rewriteList;
  }
  const ordered = [...rewriteList];
  const [rewrite] = ordered.splice(rewriteIndex, 1);
  const updatedCatchAllIndex = ordered.findIndex((entry) => isRewrite(entry) && isCatchAllSource(entry.source));
  ordered.splice(updatedCatchAllIndex, 0, rewrite);
  return ordered;
}

function isCatchAllSource(source: string): boolean {
  const value = source.trim();
  return value === "/(.*)" || /^\/:[A-Za-z_][\w-]*\*$/.test(value) || /^\/:[A-Za-z_][\w-]*\(\.\*\)$/.test(value);
}

function isDefaultRewrite(value: unknown): boolean {
  return (
    isRewrite(value) && value.source === DEFAULT_REWRITE.source && value.destination === DEFAULT_REWRITE.destination
  );
}

function isRewrite(value: unknown): value is { source: string; destination: string } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const maybe = value as Record<string, unknown>;
  return typeof maybe.source === "string" && typeof maybe.destination === "string";
}

function renderHandler(services: string[]): string {
  const serviceList = services.map((service) => `"${service}"`).join(", ");
  return `package handler

import (
\t"net/http"

\temulate "github.com/vercel-labs/emulate/vercel"
)

var emulateHandler = emulate.NewHandler(emulate.Options{
\tServices: []string{${serviceList}},
})

func Handler(w http.ResponseWriter, r *http.Request) {
\temulateHandler.ServeHTTP(w, r)
}
`;
}

function normalizeGoModuleVersion(version: string): string {
  const moduleVersion = version.startsWith("v") ? version : `v${version}`;
  return moduleVersion;
}

function renderGoMod(moduleVersion: string): string {
  return `module emulate-vercel-preview

go ${REQUIRED_GO_VERSION}

require github.com/vercel-labs/emulate ${moduleVersion}
`;
}
