import type { Store, TokenMap } from "@emulators/core";
import { getGitHubStore } from "./store.js";

/** OAuth access tokens the emulator issued, mapped to the client_id that received them. */
export function getTokenToClientId(store: Store): Map<string, string> {
  let map = store.getData<Map<string, string>>("github.oauth.tokenToClientId");
  if (!map) {
    map = new Map();
    store.setData("github.oauth.tokenToClientId", map);
  }
  return map;
}

/**
 * Tokens revoked through the REST API or the settings page. A revoked token is invalid credentials, so it stays
 * rejected even when the service falls back to a default user for tokens it does not know.
 */
export function getRevokedTokens(store: Store): Set<string> {
  let set = store.getData<Set<string>>("github.revoked_tokens");
  if (!set) {
    set = new Set();
    store.setData("github.revoked_tokens", set);
  }
  return set;
}

export function isRevokedToken(store: Store, token: string): boolean {
  return getRevokedTokens(store).has(token);
}

export function revokeOAuthToken(store: Store, tokenMap: TokenMap | undefined, token: string): void {
  tokenMap?.delete(token);
  getTokenToClientId(store).delete(token);
  getRevokedTokens(store).add(token);
}

export function revokeOAuthGrant(
  store: Store,
  user: { login: string; id: number },
  clientId: string,
  tokenMap?: TokenMap,
): void {
  const gh = getGitHubStore(store);
  const grant = gh.oauthGrants.all().find((g) => g.user_id === user.id && g.client_id === clientId);
  if (grant) gh.oauthGrants.delete(grant.id);

  if (!tokenMap) return;
  for (const [token, tokenUser] of tokenMap.entries()) {
    if (tokenUser.login === user.login && getTokenToClientId(store).get(token) === clientId) {
      revokeOAuthToken(store, tokenMap, token);
    }
  }
}
