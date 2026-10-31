import { RateLimiter, remaining, setRateLimitHeaders, type RateLimitBucket, type RouteContext } from "@emulators/core";

function view(bucket: RateLimitBucket) {
  return {
    limit: bucket.limit,
    remaining: remaining(bucket),
    reset: bucket.resetAt,
    used: bucket.used,
    resource: bucket.resource,
  };
}

export function rateLimitRoutes({ app }: RouteContext): void {
  const fallbackLimiter = new RateLimiter();

  app.get("/rate_limit", (c) => {
    const limiter = c.get("rateLimiter") ?? fallbackLimiter;
    const token = c.get("authToken") ?? "__anonymous__";
    const coreBucket = limiter.bucket(token, "core");
    setRateLimitHeaders(c, coreBucket);
    const core = view(coreBucket);
    const reset = core.reset;

    return c.json({
      resources: {
        core,
        search: { limit: 30, remaining: 29, reset, used: 1, resource: "search" },
        graphql: view(limiter.bucket(token, "graphql")),
        integration_manifest: { limit: 5000, remaining: 4999, reset, used: 1, resource: "integration_manifest" },
        source_import: { limit: 100, remaining: 99, reset, used: 1, resource: "source_import" },
        code_scanning_upload: { limit: 500, remaining: 499, reset, used: 1, resource: "code_scanning_upload" },
        actions_runner_registration: {
          limit: 10000,
          remaining: 9999,
          reset,
          used: 1,
          resource: "actions_runner_registration",
        },
        scim: { limit: 15000, remaining: 14999, reset, used: 1, resource: "scim" },
      },
      rate: core,
    });
  });
}
