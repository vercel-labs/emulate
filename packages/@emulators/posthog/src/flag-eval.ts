import type { FeatureFlagValue, PostHogFeatureFlag } from "./entities.js";
import { asRecord, asString } from "./helpers.js";

export interface FeatureFlagContext {
  distinct_id: string | null;
  person_properties?: Record<string, unknown>;
  groups?: Record<string, unknown>;
  group_properties?: Record<string, unknown>;
}

function conditionMatches(operator: string, actual: unknown, expected: unknown): boolean {
  if (operator === "is_set") {
    return actual !== undefined && actual !== null && actual !== "";
  }

  if (actual === undefined || actual === null) {
    return false;
  }

  if (operator === "exact") {
    return actual === expected || String(actual) === String(expected);
  }

  if (operator === "icontains") {
    return String(actual)
      .toLowerCase()
      .includes(String(expected ?? "").toLowerCase());
  }

  if (operator === "regex") {
    try {
      return new RegExp(String(expected ?? "")).test(String(actual));
    } catch {
      return false;
    }
  }

  return false;
}

export function evaluateFeatureFlag(flag: PostHogFeatureFlag, context: FeatureFlagContext): FeatureFlagValue {
  const distinctId = asString(context.distinct_id);
  if (distinctId && Object.prototype.hasOwnProperty.call(flag.overrides, distinctId)) {
    return flag.overrides[distinctId];
  }

  const personProperties = asRecord(context.person_properties);

  // This first version intentionally evaluates person properties only. Group properties,
  // cohorts, and percentage rollouts can be layered in here without changing route shape.
  for (const condition of flag.conditions) {
    if (conditionMatches(condition.operator, personProperties[condition.property], condition.value)) {
      return condition.variant;
    }
  }

  return flag.default;
}
