import { afterEach, expect, it, vi } from "vitest";
import { RateLimiter } from "../rate-limit.js";

const bucketCount = (limiter: RateLimiter) => (limiter as unknown as { buckets: Map<string, unknown> }).buckets.size;

afterEach(() => {
  vi.useRealTimers();
});

it("drops expired buckets once a window has passed and keeps live ones", () => {
  vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
  const limiter = new RateLimiter();
  for (let i = 0; i < 50; i++) limiter.charge(limiter.bucket(`token-${i}`, "core"), 1);
  vi.setSystemTime(new Date("2026-01-01T00:30:00Z"));
  limiter.charge(limiter.bucket("late", "core"), 2);
  expect(bucketCount(limiter)).toBe(51);

  vi.setSystemTime(new Date("2026-01-01T01:00:01Z"));
  expect(limiter.bucket("late", "core").used).toBe(2);
  expect(bucketCount(limiter)).toBe(1);
});
