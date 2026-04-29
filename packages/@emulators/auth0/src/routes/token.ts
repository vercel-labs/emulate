import { randomBytes } from "node:crypto";
import type { Context } from "hono";
import type { AppEnv, RouteContext, Store } from "@emulators/core";
import { constantTimeSecretEqual } from "@emulators/core";
import { collectUserRoles, parseScope, signJwt, userDisplayName } from "../helpers.js";
import type { Auth0Application, Auth0User } from "../entities.js";
import { findOrganizationByRef, findUserByRef } from "../route-helpers.js";
import { getAuth0Store } from "../store.js";
import { getPendingCodes, isCodeExpired, verifyPkce } from "./authorize.js";

export interface StoredAccessToken {
  clientId: string;
  scope: string;
  audience: string | null;
  userAuth0Id: string | null;
  organization: string | null;
  issuer: string;
  expiresAt: number;
}

export interface StoredRefreshToken {
  clientId: string;
  scope: string;
  audience: string | null;
  userAuth0Id: string;
  organization: string | null;
  issuer: string;
  nonce: string | null;
}

export function getAccessTokens(store: Store): Map<string, StoredAccessToken> {
  let map = store.getData<Map<string, StoredAccessToken>>("auth0.oauth.accessTokens");
  if (!map) {
    map = new Map();
    store.setData("auth0.oauth.accessTokens", map);
  }
  return map;
}

function getRefreshTokens(store: Store): Map<string, StoredRefreshToken> {
  let map = store.getData<Map<string, StoredRefreshToken>>("auth0.oauth.refreshTokens");
  if (!map) {
    map = new Map();
    store.setData("auth0.oauth.refreshTokens", map);
  }
  return map;
}

async function parseTokenBody(c: Context<AppEnv>): Promise<Record<string, string>> {
  const contentType = c.req.header("Content-Type") ?? "";
  const raw = await c.req.text();
  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") out[key] = value;
      }
      return out;
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function parseClientCredentials(
  c: Context<AppEnv>,
  body: Record<string, string>,
): { clientId: string; clientSecret: string } {
  let clientId = body.client_id ?? "";
  let clientSecret = body.client_secret ?? "";
  const authHeader = c.req.header("Authorization") ?? "";
  if (authHeader.startsWith("Basic ")) {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep !== -1) {
      if (!clientId) clientId = decodeURIComponent(decoded.slice(0, sep));
      if (!clientSecret) clientSecret = decodeURIComponent(decoded.slice(sep + 1));
    }
  }
  return { clientId, clientSecret };
}

function validateClient(
  clients: Auth0Application[],
  clientId: string,
  clientSecret: string,
): { client: Auth0Application | null; error: Response | null } {
  if (clients.length === 0) return { client: null, error: null };
  const client = clients.find((entry) => entry.client_id === clientId);
  if (!client) {
    return {
      client: null,
      error: Response.json({ error: "invalid_client", error_description: "Unknown client." }, { status: 401 }),
    };
  }
  if (client.token_endpoint_auth_method === "none") return { client, error: null };
  if (!constantTimeSecretEqual(client.client_secret, clientSecret)) {
    return {
      client: null,
      error: Response.json(
        { error: "invalid_client", error_description: "Invalid client credentials." },
        { status: 401 },
      ),
    };
  }
  return { client, error: null };
}

async function createIdToken(
  auth0: ReturnType<typeof getAuth0Store>,
  user: Auth0User,
  clientId: string,
  issuer: string,
  scope: string,
  nonce: string | null,
  organization: string | null,
): Promise<string> {
  const scopes = parseScope(scope);
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    auth_time: now,
  };
  if (scopes.includes("profile")) {
    claims.name = userDisplayName(user);
    claims.nickname = user.nickname;
    claims.picture = user.picture;
    claims.locale = user.locale;
  }
  if (scopes.includes("email")) {
    claims.email = user.email;
    claims.email_verified = user.email_verified;
  }
  if (nonce) claims.nonce = nonce;
  if (organization) {
    const org = findOrganizationByRef(auth0, organization);
    if (org) {
      claims.org_id = org.org_id;
      claims.org_name = org.name;
    }
  }
  const roles = collectUserRoles(auth0, user);
  if (roles.length > 0) claims["https://emulate.dev/roles"] = roles;

  return signJwt(claims, { issuer, audience: clientId, subject: user.auth0_id });
}

function validateAudience(auth0: ReturnType<typeof getAuth0Store>, audience: string): boolean {
  if (!audience) return true;
  const configured = auth0.apis.all();
  if (configured.length === 0) return true;
  return Boolean(auth0.apis.findOneBy("audience", audience));
}

export function tokenRoutes({ app, store, tokenMap }: RouteContext): void {
  const auth0 = getAuth0Store(store);

  app.post("/oauth/token", async (c) => {
    const body = await parseTokenBody(c);
    const grantType = body.grant_type ?? "";
    const creds = parseClientCredentials(c, body);
    const validation = validateClient(auth0.applications.all(), creds.clientId, creds.clientSecret);
    if (validation.error) return validation.error;
    const client = validation.client;

    if (grantType === "authorization_code") {
      const code = body.code ?? "";
      const pending = getPendingCodes(store).get(code);
      if (!pending || isCodeExpired(pending)) {
        if (pending) getPendingCodes(store).delete(code);
        return c.json({ error: "invalid_grant", error_description: "Authorization code is invalid or expired." }, 400);
      }
      if (body.redirect_uri && body.redirect_uri !== pending.redirectUri) {
        return c.json({ error: "invalid_grant", error_description: "redirect_uri does not match." }, 400);
      }
      if (client && client.client_id !== pending.clientId) {
        return c.json(
          { error: "invalid_grant", error_description: "Authorization code was not issued to this client." },
          400,
        );
      }
      if (!verifyPkce(pending, body.code_verifier)) {
        return c.json({ error: "invalid_grant", error_description: "PKCE verification failed." }, 400);
      }

      const user = findUserByRef(auth0, pending.userRef);
      if (!user) return c.json({ error: "invalid_grant", error_description: "Unknown user." }, 400);
      getPendingCodes(store).delete(code);

      const accessToken = `auth0_${randomBytes(20).toString("base64url")}`;
      const refreshToken = `r_auth0_${randomBytes(20).toString("base64url")}`;
      const now = Math.floor(Date.now() / 1000);
      const clientId = pending.clientId || creds.clientId || "auth0-client";
      const scope = pending.scope || "openid profile email";
      getAccessTokens(store).set(accessToken, {
        clientId,
        scope,
        audience: pending.audience,
        userAuth0Id: user.auth0_id,
        organization: pending.organization,
        issuer: pending.issuer,
        expiresAt: now + 3600,
      });
      getRefreshTokens(store).set(refreshToken, {
        clientId,
        scope,
        audience: pending.audience,
        userAuth0Id: user.auth0_id,
        organization: pending.organization,
        issuer: pending.issuer,
        nonce: pending.nonce,
      });
      tokenMap?.set(accessToken, { login: user.email, id: user.id, scopes: parseScope(scope) });

      const response: Record<string, unknown> = {
        token_type: "Bearer",
        expires_in: 3600,
        access_token: accessToken,
        refresh_token: refreshToken,
        scope,
      };
      if (parseScope(scope).includes("openid")) {
        response.id_token = await createIdToken(
          auth0,
          user,
          clientId,
          pending.issuer,
          scope,
          pending.nonce,
          pending.organization,
        );
      }
      return c.json(response);
    }

    if (grantType === "refresh_token") {
      const refreshToken = body.refresh_token ?? "";
      const existing = getRefreshTokens(store).get(refreshToken);
      if (!existing) return c.json({ error: "invalid_grant", error_description: "Invalid refresh token." }, 400);
      if (client && client.client_id !== existing.clientId) {
        return c.json(
          { error: "invalid_grant", error_description: "Refresh token was not issued to this client." },
          400,
        );
      }
      const user = auth0.users.findOneBy("auth0_id", existing.userAuth0Id);
      if (!user) return c.json({ error: "invalid_grant", error_description: "Unknown user." }, 400);
      getRefreshTokens(store).delete(refreshToken);

      const nextAccessToken = `auth0_${randomBytes(20).toString("base64url")}`;
      const nextRefreshToken = `r_auth0_${randomBytes(20).toString("base64url")}`;
      const scope = body.scope || existing.scope;
      const now = Math.floor(Date.now() / 1000);
      getAccessTokens(store).set(nextAccessToken, {
        clientId: existing.clientId,
        scope,
        audience: existing.audience,
        userAuth0Id: user.auth0_id,
        organization: existing.organization,
        issuer: existing.issuer,
        expiresAt: now + 3600,
      });
      getRefreshTokens(store).set(nextRefreshToken, { ...existing, scope });
      tokenMap?.set(nextAccessToken, { login: user.email, id: user.id, scopes: parseScope(scope) });

      const response: Record<string, unknown> = {
        token_type: "Bearer",
        expires_in: 3600,
        access_token: nextAccessToken,
        refresh_token: nextRefreshToken,
        scope,
      };
      if (parseScope(scope).includes("openid")) {
        response.id_token = await createIdToken(
          auth0,
          user,
          existing.clientId,
          existing.issuer,
          scope,
          existing.nonce,
          existing.organization,
        );
      }
      return c.json(response);
    }

    if (grantType === "client_credentials") {
      if (auth0.applications.all().length > 0 && !client) {
        return c.json({ error: "invalid_client", error_description: "Unknown client." }, 401);
      }
      const audience = body.audience ?? "";
      if (!validateAudience(auth0, audience)) {
        return c.json({ error: "access_denied", error_description: "Unknown audience." }, 403);
      }
      const clientId = client?.client_id ?? creds.clientId;
      if (!clientId) return c.json({ error: "invalid_client", error_description: "client_id is required." }, 401);
      const accessToken = `auth0_${randomBytes(20).toString("base64url")}`;
      const issuer = auth0.apis.findOneBy("audience", audience)?.audience ?? audience;
      getAccessTokens(store).set(accessToken, {
        clientId,
        scope: body.scope ?? "",
        audience: audience || null,
        userAuth0Id: null,
        organization: null,
        issuer,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });
      tokenMap?.set(accessToken, { login: clientId, id: 0, scopes: parseScope(body.scope ?? "") });
      return c.json({
        token_type: "Bearer",
        expires_in: 3600,
        access_token: accessToken,
        scope: body.scope ?? "",
      });
    }

    return c.json({ error: "unsupported_grant_type" }, 400);
  });
}
