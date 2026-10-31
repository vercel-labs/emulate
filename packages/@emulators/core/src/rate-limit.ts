import type { Context } from "./http.js";

const WINDOW_SECONDS = 3600;
const DEFAULT_LIMIT = 5000;

export interface RateLimitBucket {
  readonly resource: string;
  readonly limit: number;
  used: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private lastPruneAt = Math.floor(Date.now() / 1000);

  bucket(token: string, resource: string): RateLimitBucket {
    const key = `${resource}:${token}`;
    const now = Math.floor(Date.now() / 1000);
    if (now - this.lastPruneAt >= WINDOW_SECONDS) {
      for (const [k, expired] of this.buckets) if (expired.resetAt <= now) this.buckets.delete(k);
      this.lastPruneAt = now;
    }
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { resource, limit: DEFAULT_LIMIT, used: 0, resetAt: now + WINDOW_SECONDS };
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  charge(bucket: RateLimitBucket, cost: number): boolean {
    if (remaining(bucket) < cost) return false;
    bucket.used += cost;
    return true;
  }
}

export function remaining(bucket: RateLimitBucket): number {
  return Math.max(0, bucket.limit - bucket.used);
}

export function setRateLimitHeaders(c: Context<any>, bucket: RateLimitBucket): void {
  c.header("X-RateLimit-Limit", String(bucket.limit));
  c.header("X-RateLimit-Remaining", String(remaining(bucket)));
  c.header("X-RateLimit-Used", String(bucket.used));
  c.header("X-RateLimit-Reset", String(bucket.resetAt));
  c.header("X-RateLimit-Resource", bucket.resource);
}

// Bundlers can inline several copies of this module, so the registry lives on globalThis under a registered symbol.
const REGISTRY = Symbol.for("@emulators/core/internal-requests");
const internalRequests: WeakSet<Request> = ((globalThis as Record<symbol, WeakSet<Request>>)[REGISTRY] ??=
  new WeakSet<Request>());

/** Marks a request a plugin dispatches to its own routes, so it is not charged a second time. */
export function internalRequest(input: string, init?: RequestInit): Request {
  const request = new Request(input, init);
  internalRequests.add(request);
  return request;
}

export function isInternalRequest(request: Request): boolean {
  return internalRequests.has(request);
}
