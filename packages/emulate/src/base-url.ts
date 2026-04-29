export interface ResolveBaseUrlOptions {
  service: string;
  port: number;
  baseUrl?: string;
  seedBaseUrl?: string;
}

/**
 * Fallback chain:
 * 1. Per-service baseUrl from seed config
 * 2. Explicit baseUrl (CLI flag or programmatic option)
 * 3. EMULATE_BASE_URL env var (with {service} interpolation)
 * 4. PORTLESS_URL env var (with {service} interpolation)
 * 5. http://localhost:<port>
 */
export function resolveBaseUrl(opts: ResolveBaseUrlOptions): string {
  if (opts.seedBaseUrl) {
    return opts.seedBaseUrl;
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
  return `http://localhost:${opts.port}`;
}
