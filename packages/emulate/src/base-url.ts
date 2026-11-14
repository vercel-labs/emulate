import { isIPv6 } from "node:net";

export interface ResolveBaseUrlOptions {
  service: string;
  port: number;
  baseUrl?: string;
  seedBaseUrl?: string;
  hostname?: string;
}

function advertisedHost(hostname?: string): string {
  const host = hostname?.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host === "0.0.0.0" || host === "::" || host === "::1" || host.startsWith("127."))
    return "localhost";
  return isIPv6(host) ? `[${host}]` : host;
}

/**
 * Fallback chain:
 * 1. Per-service baseUrl from seed config
 * 2. Explicit baseUrl (CLI flag or programmatic option)
 * 3. EMULATE_BASE_URL env var (with {service} interpolation)
 * 4. PORTLESS_URL env var (with {service} interpolation)
 * 5. http://<listening host>:<port>, with localhost for loopback and wildcard hosts
 */
export function resolveBaseUrl(opts: ResolveBaseUrlOptions): string {
  if (opts.seedBaseUrl) {
    return opts.seedBaseUrl.replace(/\{service\}/g, opts.service);
  }
  if (opts.baseUrl) {
    return opts.baseUrl.replace(/\{service\}/g, opts.service);
  }
  const envBaseUrl = process.env.EMULATE_BASE_URL;
  if (envBaseUrl) {
    return envBaseUrl.replace(/\{service\}/g, opts.service);
  }
  const portlessUrl = process.env.PORTLESS_URL;
  if (portlessUrl) {
    return portlessUrl.replace(/\{service\}/g, opts.service);
  }
  return `http://${advertisedHost(opts.hostname)}:${opts.port}`;
}
