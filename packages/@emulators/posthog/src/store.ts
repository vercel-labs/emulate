import { Store, type Collection } from "@emulators/core";
import type { PostHogEvent, PostHogFeatureFlag, PostHogProject } from "./entities.js";

export interface PostHogStore {
  events: Collection<PostHogEvent>;
  featureFlags: Collection<PostHogFeatureFlag>;
  projects: Collection<PostHogProject>;
}

export function getPostHogStore(store: Store): PostHogStore {
  return {
    events: store.collection<PostHogEvent>("posthog.events", ["uuid", "project_id"]),
    featureFlags: store.collection<PostHogFeatureFlag>("posthog.feature_flags", ["key", "project_id"]),
    projects: store.collection<PostHogProject>("posthog.projects", ["project_id", "api_token"]),
  };
}
