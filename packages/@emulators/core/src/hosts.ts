/**
 * Describes how one real provider hostname maps onto an emulator's single origin.
 *
 * Real providers spread their APIs across several hostnames (for example
 * `api.twilio.com` and `verify.twilio.com`), while each emulator serves every
 * endpoint from one origin. A service's host table lets request interceptors,
 * proxies, and SDK clients translate a real URL into the emulator path that
 * serves it.
 */
export interface ServiceHost {
  /**
   * Hostname such as `api.github.com`. A `*` matches one or more DNS labels,
   * so `*.s3.amazonaws.com` matches `my-bucket.s3.amazonaws.com`.
   */
  readonly host: string;
  /** Path prefix under which the emulator serves this host's routes, such as `/verify`. */
  readonly prefix?: string;
  /**
   * Builds the emulator pathname when the hostname carries data, such as an S3
   * bucket in a virtual-hosted URL. The query string is preserved separately.
   */
  readonly toPath?: (url: URL) => string;
}

const LABELS = "[a-z0-9-]+(?:\\.[a-z0-9-]+)*";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hostPatternSource(host: string): string {
  return host.toLowerCase().split("*").map(escapeRegExp).join(LABELS);
}

/** Returns true when a hostname matches a host pattern. */
export function matchesHost(pattern: string, hostname: string): boolean {
  return new RegExp(`^${hostPatternSource(pattern)}$`, "i").test(hostname);
}

/** Finds the first host entry that serves a URL. */
export function findServiceHost(hosts: readonly ServiceHost[], input: URL | string): ServiceHost | undefined {
  const url = typeof input === "string" ? new URL(input) : input;
  return hosts.find((entry) => matchesHost(entry.host, url.hostname));
}

/**
 * Translates a real provider URL into the emulator path and query string that
 * serve it, or returns undefined when no host entry matches.
 */
export function toEmulatorPath(hosts: readonly ServiceHost[], input: URL | string): string | undefined {
  const url = typeof input === "string" ? new URL(input) : input;
  const entry = findServiceHost(hosts, url);
  if (!entry) return undefined;
  const pathname = entry.toPath ? entry.toPath(url) : `${entry.prefix ?? ""}${url.pathname}`;
  return `${pathname}${url.search}`;
}

/**
 * Returns the first host that the emulator serves without translation. Its
 * origin is a natural advertised base URL, because URLs the emulator generates
 * against it map back onto the same emulator paths.
 */
export function primaryHost(hosts: readonly ServiceHost[]): string | undefined {
  return hosts.find((entry) => !entry.prefix && !entry.toPath && !entry.host.includes("*"))?.host;
}
