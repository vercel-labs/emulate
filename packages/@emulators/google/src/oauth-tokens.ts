import { randomBytes } from "node:crypto";
import type { Store, TokenMap } from "@emulators/core";
import type { GoogleUser } from "./entities.js";

interface AccessTokenRecord {
  email: string;
  scopes: string[];
  expiresAt: number;
  refreshToken: string;
}

interface RefreshTokenRecord {
  email: string;
  scope: string;
  clientId: string;
}

export function getAccessTokens(store: Store): Map<string, AccessTokenRecord> {
  let tokens = store.getData<Map<string, AccessTokenRecord>>("google.oauth.accessTokens");
  if (!tokens) {
    tokens = new Map();
    store.setData("google.oauth.accessTokens", tokens);
  }
  return tokens;
}

export function getRefreshTokens(store: Store): Map<string, RefreshTokenRecord> {
  let tokens = store.getData<Map<string, RefreshTokenRecord>>("google.oauth.refreshTokens");
  if (!tokens) {
    tokens = new Map();
    store.setData("google.oauth.refreshTokens", tokens);
  }
  return tokens;
}

export function issueAccessToken(
  store: Store,
  tokenMap: TokenMap | undefined,
  user: GoogleUser,
  scope: string,
  refreshToken: string,
): string {
  const token = "google_" + randomBytes(20).toString("base64url");
  const scopes = scope.split(/\s+/).filter(Boolean);
  tokenMap?.set(token, { login: user.email, id: user.id, scopes });
  getAccessTokens(store).set(token, {
    email: user.email,
    scopes: scope ? scopes : ["openid", "email", "profile"],
    expiresAt: Date.now() + 3600 * 1000,
    refreshToken,
  });
  return token;
}

export function revokeToken(store: Store, tokenMap: TokenMap | undefined, token: string): void {
  const accessTokens = getAccessTokens(store);
  const refreshTokens = getRefreshTokens(store);
  const refreshToken = accessTokens.get(token)?.refreshToken ?? token;
  if (store.getData<boolean>("google.strict_scopes") === true) {
    // Revoking either credential invalidates the access tokens issued from the same refresh token.
    for (const [accessToken, record] of accessTokens) {
      if (record.refreshToken === refreshToken) {
        accessTokens.delete(accessToken);
        tokenMap?.delete(accessToken);
      }
    }
    refreshTokens.delete(refreshToken);
  }
  accessTokens.delete(token);
  tokenMap?.delete(token);
  refreshTokens.delete(token);
}
