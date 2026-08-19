import { cpSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  createAdapterRuntime,
  debug,
  type AdapterEmulatorEntry,
  type AdapterEmulatorModule,
  type AdapterHandlerConfig,
  type GeneratedSecret,
  type PreparedServiceSeed,
} from "@emulators/core";
export type { PersistenceAdapter } from "@emulators/core";
export type EmulatorModule = AdapterEmulatorModule;
export type EmulatorEntry = AdapterEmulatorEntry;
export type EmulateHandlerConfig = AdapterHandlerConfig;
export type { GeneratedSecret, PreparedServiceSeed };
export interface NuxtAdapterOptions {
  param?: string;
  routePrefix?: string;
}
type HeaderValue = string | string[] | number | undefined;
interface NodeRequestLike {
  method?: string;
  url?: string;
  headers?: Record<string, HeaderValue>;
}
export interface NuxtEventLike {
  req?: Request;
  node?: { req?: NodeRequestLike };
  context?: { params?: Record<string, unknown>; path?: string };
}
function normalizePrefix(prefix: string): string {
  return (prefix.startsWith("/") ? prefix : `/${prefix}`).replace(/\/+$/, "") || "/";
}
function joinPath(base: string, segment: string): string {
  return base === "/" ? `/${segment}` : `${base}/${segment}`;
}
function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}
function getPathSegments(event: NuxtEventLike, param: string, routePrefix?: string): string[] {
  const params = event.context?.params ?? {};
  const value = params[param] ?? params._ ?? params.path;
  if (Array.isArray(value)) return value.flatMap((part) => splitPath(String(part)));
  if (typeof value === "string" && value) return splitPath(value);
  if (routePrefix && event.context?.path) {
    const path = event.context.path;
    return splitPath(path.startsWith(routePrefix) ? path.slice(routePrefix.length) : path);
  }
  return [];
}
function firstHeader(value: HeaderValue): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === undefined ? undefined : String(raw).split(",")[0]?.trim();
}
function requestFromEvent(event: NuxtEventLike): Request {
  if (
    event.req &&
    typeof event.req.url === "string" &&
    typeof event.req.method === "string" &&
    typeof event.req.headers?.get === "function"
  ) {
    return event.req;
  }
  const nodeRequest = event.node?.req;
  if (!nodeRequest) throw new Error("Nuxt event must provide `req` or `node.req`");
  const sourceHeaders = nodeRequest.headers ?? {};
  const protocol = firstHeader(sourceHeaders["x-forwarded-proto"]) ?? "http";
  const host = firstHeader(sourceHeaders["x-forwarded-host"]) ?? firstHeader(sourceHeaders.host) ?? "localhost";
  const headers = new Headers();
  for (const [name, value] of Object.entries(sourceHeaders)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, String(value));
  }
  const method = nodeRequest.method ?? "GET";
  const init: RequestInit & { duplex?: string } = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = nodeRequest as unknown as RequestInit["body"];
    init.duplex = "half";
  }
  return new Request(new URL(nodeRequest.url ?? "/", `${protocol}://${host}`), init);
}
function detectPrefix(url: string, pathSegments: string[]): string {
  const pathname = new URL(url).pathname;
  const index = pathname.lastIndexOf("/" + pathSegments.join("/"));
  if (index >= 0) return pathname.slice(0, index) || "/";
  throw new Error(`Could not detect mount path from URL: ${url}`);
}
export function createEmulateHandler(config: EmulateHandlerConfig, options: NuxtAdapterOptions = {}) {
  const param = options.param ?? "path";
  const configuredMountPath = options.routePrefix ? normalizePrefix(options.routePrefix) : null;
  const runtime = createAdapterRuntime(config, joinPath);
  let mountPath = configuredMountPath;
  const handler = async (event: NuxtEventLike): Promise<Response> => {
    const request = requestFromEvent(event);
    const path = getPathSegments(event, param, configuredMountPath ?? undefined);
    if (path.length === 0) return new Response("Not found", { status: 404 });
    mountPath ??= detectPrefix(request.url, path);
    return runtime.handle(request, path, mountPath);
  };
  handler.generatedSecrets = runtime.generatedSecrets;
  return handler;
}
interface NitroInstanceLike {
  options?: { output?: { serverDir?: string } };
}
function copyCoreFonts(nitro: NitroInstanceLike): void {
  const serverDir = nitro.options?.output?.serverDir;
  if (!serverDir) return;
  try {
    const corePackage = createRequire(import.meta.url).resolve("@emulators/core/package.json");
    cpSync(join(dirname(corePackage), "dist", "fonts"), join(serverDir, "fonts"), { recursive: true });
  } catch (error) {
    debug("nuxt", "font copy failed: %o", error);
  }
}
export function withEmulate<T>(nuxtConfig: T): T {
  const config = nuxtConfig as Record<string, unknown>;
  const nitro = { ...((config.nitro as Record<string, unknown> | undefined) ?? {}) };
  const hooks = (nitro.hooks as Record<string, unknown> | undefined) ?? {};
  const previous = hooks.compiled as ((nitro: NitroInstanceLike) => unknown) | undefined;
  return {
    ...config,
    nitro: {
      ...nitro,
      hooks: {
        ...hooks,
        async compiled(instance: NitroInstanceLike) {
          if (previous) await previous(instance);
          copyCoreFonts(instance);
        },
      },
    },
  } as T;
}
