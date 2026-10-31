import type { Context, Store, TokenMap } from "@emulators/core";
import type { SlackToken } from "./entities.js";
import { getSlackStore } from "./store.js";

export function slackRequestToken(c: Context): string | undefined {
  const authHeader = c.req.header("Authorization");
  if (!authHeader) return undefined;
  return authHeader.replace(/^(Bearer|token)\s+/i, "").trim() || undefined;
}

export function isSlackTokenRevoked(store: Store, token: string): boolean {
  return store.getData<Set<string>>("slack.revoked_tokens")?.has(token) ?? false;
}

export function revokeSlackTokens(store: Store, tokens: SlackToken[], tokenMap?: TokenMap): void {
  const revoked = store.getData<Set<string>>("slack.revoked_tokens") ?? new Set<string>();
  const ss = getSlackStore(store);
  for (const token of tokens) {
    revoked.add(token.token);
    ss.tokens.delete(token.id);
    tokenMap?.delete(token.token);
  }
  store.setData("slack.revoked_tokens", revoked);
}
