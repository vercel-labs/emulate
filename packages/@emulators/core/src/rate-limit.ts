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

  bucket(token: string, resource: string): RateLimitBucket {
    const key = `${resource}:${token}`;
    const now = Math.floor(Date.now() / 1000);
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

const internalRequests = new WeakSet<Request>();

/** Marks a request a plugin dispatches to its own routes, so it is not charged a second time. */
export function internalRequest(input: string, init?: RequestInit): Request {
  const request = new Request(input, init);
  internalRequests.add(request);
  return request;
}

export function isInternalRequest(request: Request): boolean {
  return internalRequests.has(request);
}
