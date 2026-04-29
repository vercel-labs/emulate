import type { Hono } from "hono";
import type { AppEnv, RouteContext, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import type { FeatureFlagValue, FlagCondition } from "./entities.js";
import { getPostHogStore } from "./store.js";
import { captureRoutes } from "./routes/capture.js";
import { decideRoutes } from "./routes/decide.js";
import { inspectorRoutes } from "./routes/inspector.js";

export { getPostHogStore, type PostHogStore } from "./store.js";
export * from "./entities.js";

export interface PostHogSeedConfig {
  port?: number;
  projects?: Array<{
    id: number;
    api_token: string;
    name?: string;
  }>;
  feature_flags?: Array<{
    key: string;
    project_id: number;
    default: FeatureFlagValue;
    variants?: string[];
    conditions?: FlagCondition[];
    overrides?: Record<string, FeatureFlagValue>;
  }>;
}

function seedDefaults(store: Store): void {
  const ph = getPostHogStore(store);
  const existing = ph.projects.findOneBy("api_token", "phc_test");
  if (existing) return;

  ph.projects.insert({
    project_id: 1,
    api_token: "phc_test",
    name: "Default Project",
  });
}

export function seedFromConfig(store: Store, _baseUrl: string, config: PostHogSeedConfig): void {
  const ph = getPostHogStore(store);

  if (config.projects) {
    for (const project of config.projects) {
      const existingById = ph.projects.findOneBy("project_id", project.id);
      if (existingById) {
        ph.projects.update(existingById.id, {
          api_token: project.api_token,
          name: project.name ?? existingById.name,
        });
        continue;
      }

      const existingByToken = ph.projects.findOneBy("api_token", project.api_token);
      if (existingByToken) {
        ph.projects.update(existingByToken.id, {
          project_id: project.id,
          name: project.name ?? existingByToken.name,
        });
        continue;
      }

      ph.projects.insert({
        project_id: project.id,
        api_token: project.api_token,
        name: project.name ?? null,
      });
    }
  }

  if (config.feature_flags) {
    for (const flag of config.feature_flags) {
      const existing = ph.featureFlags
        .findBy("key", flag.key)
        .find((candidate) => candidate.project_id === flag.project_id);
      if (existing) continue;

      ph.featureFlags.insert({
        key: flag.key,
        project_id: flag.project_id,
        default: flag.default,
        variants: flag.variants ?? [],
        conditions: flag.conditions ?? [],
        overrides: flag.overrides ?? {},
      });
    }
  }
}

export const posthogPlugin: ServicePlugin = {
  name: "posthog",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    captureRoutes(ctx);
    decideRoutes(ctx);
    inspectorRoutes(ctx);
  },
  seed(store: Store): void {
    seedDefaults(store);
  },
};

export default posthogPlugin;
