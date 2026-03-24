import { randomBytes } from "crypto";
import type { Store } from "@internal/core";

export function generateUid(prefix = ""): string {
  const id = randomBytes(12).toString("base64url").slice(0, 20);
  return prefix ? `${prefix}_${id}` : id;
}

export function getStrict(store: Store): boolean {
  return store.getData<boolean>("idp.strict") ?? false;
}

export function getIssuer(store: Store, baseUrl: string): string {
  return store.getData<string>("idp.issuer") ?? baseUrl;
}

// --- Ephemeral data types ---

export type PendingCode = {
  uid: string;
  scope: string;
  redirectUri: string;
  clientId: string;
  nonce: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  created_at: number;
};

export type RefreshTokenData = {
  token: string;
  uid: string;
  clientId: string;
  scope: string;
  created_at: number;
  expires_at: number;
};

// --- Ephemeral data accessors (lazy-init pattern from Google plugin) ---

const PENDING_CODE_TTL_MS = 10 * 60 * 1000;

export function getPendingCodes(store: Store): Map<string, PendingCode> {
  let map = store.getData<Map<string, PendingCode>>("idp.oidc.pendingCodes");
  if (!map) {
    map = new Map();
    store.setData("idp.oidc.pendingCodes", map);
  }
  // Safety valve for long-running processes. Real cleanup happens via store.reset().
  if (map.size > 50000) map.clear();
  return map;
}

export function isPendingCodeExpired(p: PendingCode): boolean {
  return Date.now() - p.created_at > PENDING_CODE_TTL_MS;
}

export function getRefreshTokens(store: Store): Map<string, RefreshTokenData> {
  let map = store.getData<Map<string, RefreshTokenData>>("idp.oidc.refreshTokens");
  if (!map) {
    map = new Map();
    store.setData("idp.oidc.refreshTokens", map);
  }
  return map;
}

export function getRevokedTokens(store: Store): Set<string> {
  let set = store.getData<Set<string>>("idp.oidc.revokedTokens");
  if (!set) {
    set = new Set();
    store.setData("idp.oidc.revokedTokens", set);
  }
  // Safety valve for long-running processes. Real cleanup happens via store.reset().
  if (set.size > 50000) set.clear();
  return set;
}

export function getTokenClients(store: Store): Map<string, string> {
  let map = store.getData<Map<string, string>>("idp.oidc.tokenClients");
  if (!map) {
    map = new Map();
    store.setData("idp.oidc.tokenClients", map);
  }
  // Safety valve for long-running processes. Real cleanup happens via store.reset().
  if (map.size > 50000) map.clear();
  return map;
}

export type PendingSamlRequest = {
  requestId: string;
  acsUrl: string;
  spEntityId: string;
  relayState: string;
  created_at: number;
};

export function getPendingSamlRequests(store: Store): Map<string, PendingSamlRequest> {
  let map = store.getData<Map<string, PendingSamlRequest>>("idp.saml.pendingRequests");
  if (!map) {
    map = new Map();
    store.setData("idp.saml.pendingRequests", map);
  }
  // Safety valve for long-running processes. Real cleanup happens via store.reset().
  if (map.size > 50000) map.clear();
  return map;
}

export function getSamlEntityId(store: Store, baseUrl: string): string {
  return store.getData<string>("idp.saml.entityId") ?? `${baseUrl}/saml/metadata`;
}
