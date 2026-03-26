import type { RouteContext } from "@emulators/core";

export function rateLimitRoutes({ app }: RouteContext): void {
  app.get("/rate_limit", (c) => {
    const now = Math.floor(Date.now() / 1000);
    const reset = now + 3600;
    const rateLimit = {
      limit: 5000,
      remaining: 4999,
      reset,
      used: 1,
      resource: "core",
    };

    return c.json({
      resources: {
        core: rateLimit,
        search: { limit: 30, remaining: 29, reset, used: 1, resource: "search" },
        graphql: { limit: 5000, remaining: 4999, reset, used: 1, resource: "graphql" },
        integration_manifest: { limit: 5000, remaining: 4999, reset, used: 1, resource: "integration_manifest" },
        source_import: { limit: 100, remaining: 99, reset, used: 1, resource: "source_import" },
        code_scanning_upload: { limit: 500, remaining: 499, reset, used: 1, resource: "code_scanning_upload" },
        actions_runner_registration: { limit: 10000, remaining: 9999, reset, used: 1, resource: "actions_runner_registration" },
        scim: { limit: 15000, remaining: 14999, reset, used: 1, resource: "scim" },
      },
      rate: rateLimit,
    });
  });
}
