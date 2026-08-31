import type { Store } from "@emulators/core";

export interface GitHubGraphQLRateLimit {
  limit: number;
  remaining: number;
  used: number;
  resetAt: number;
  cost: number;
}

const GRAPHQL_RATE_LIMIT_KEY = "github.graphql.rateLimit";
const GRAPHQL_RATE_LIMIT = 5000;
const RESET_WINDOW_SECONDS = 60 * 60;

function initialRateLimit(now: number): GitHubGraphQLRateLimit {
  return {
    limit: GRAPHQL_RATE_LIMIT,
    remaining: GRAPHQL_RATE_LIMIT,
    used: 0,
    resetAt: now + RESET_WINDOW_SECONDS,
    cost: 1,
  };
}

export function getGitHubGraphQLRateLimit(store: Store): GitHubGraphQLRateLimit {
  const now = Math.floor(Date.now() / 1000);
  const existing = store.getData<GitHubGraphQLRateLimit>(GRAPHQL_RATE_LIMIT_KEY);
  if (!existing || existing.resetAt <= now) {
    const reset = initialRateLimit(now);
    store.setData(GRAPHQL_RATE_LIMIT_KEY, reset);
    return reset;
  }
  return existing;
}

/** Consume one request from the GraphQL bucket and return its post-consumption state. */
export function consumeGitHubGraphQLRateLimit(store: Store): GitHubGraphQLRateLimit {
  const current = getGitHubGraphQLRateLimit(store);
  const next: GitHubGraphQLRateLimit = {
    ...current,
    remaining: Math.max(0, current.remaining - 1),
    used: current.used + 1,
    cost: 1,
  };
  store.setData(GRAPHQL_RATE_LIMIT_KEY, next);
  return next;
}
