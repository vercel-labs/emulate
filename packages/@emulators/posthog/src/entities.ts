import type { Entity } from "@emulators/core";

export type FeatureFlagValue = boolean | string;

export interface FlagCondition {
  property: string;
  operator: "exact" | "is_set" | "icontains" | "regex";
  value?: string | number | boolean;
  variant: FeatureFlagValue;
}

export interface PostHogProject extends Entity {
  project_id: number;
  api_token: string;
  name: string | null;
}

export interface PostHogEvent extends Entity {
  uuid: string;
  project_id: number;
  event: string;
  distinct_id: string | null;
  properties: Record<string, unknown>;
  timestamp: string;
}

export interface PostHogFeatureFlag extends Entity {
  key: string;
  project_id: number;
  default: FeatureFlagValue;
  variants: string[];
  conditions: FlagCondition[];
  overrides: Record<string, FeatureFlagValue>;
}
