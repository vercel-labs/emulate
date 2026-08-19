import {
  createAdapterRuntime,
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
type RouteHandler = (req: Request, ctx: { params: Promise<{ path: string[] }> }) => Promise<Response>;
function detectPrefix(url: string, pathSegments: string[]): string {
  const pathname = new URL(url).pathname;
  const index = pathname.lastIndexOf("/" + pathSegments.join("/"));
  if (index > 0) return pathname.slice(0, index);
  throw new Error(`Could not detect mount path from URL: ${url}`);
}
export function createEmulateHandler(config: EmulateHandlerConfig) {
  const runtime = createAdapterRuntime(config, (mountPath, service) => `${mountPath}/${service}`);
  let mountPath: string | null = null;
  const handler: RouteHandler = async (request, context) => {
    const { path } = await context.params;
    mountPath ??= detectPrefix(request.url, path);
    return runtime.handle(request, path, mountPath);
  };
  return {
    GET: handler,
    POST: handler,
    PUT: handler,
    PATCH: handler,
    DELETE: handler,
    generatedSecrets: runtime.generatedSecrets,
  };
}
export function withEmulate<T>(nextConfig: T, options?: { routePrefix?: string }): T {
  const config = nextConfig as Record<string, unknown>;
  const routePattern = `${options?.routePrefix ?? "/emulate"}/**`;
  const fontGlob = "./node_modules/@emulators/core/dist/fonts/**";
  const includes = { ...((config.outputFileTracingIncludes as Record<string, string[]> | undefined) ?? {}) };
  const existing = includes[routePattern] ?? [];
  if (!existing.includes(fontGlob)) includes[routePattern] = [...existing, fontGlob];
  return { ...config, outputFileTracingIncludes: includes } as T;
}
