import type { RouteContext } from "@emulators/core";
import { generateClerkId, nowUnix } from "../helpers.js";
import {
  clerkError,
  requireSecretKey,
  isAuthResponse,
  readJsonBody,
} from "../route-helpers.js";
import { getClerkStore } from "../store.js";
import { createSessionToken, keyPairPromise, KID } from "./oauth.js";
import { SignJWT } from "jose";

function m2mTokenResponse(token: {
  token_id: string;
  token?: string;
  subject: string;
  scopes: string[];
  claims: Record<string, unknown> | null;
  revoked: boolean;
  revocation_reason: string | null;
  expired: boolean;
  expiration: number | null;
  created_at_unix: number;
  updated_at_unix: number;
}): Record<string, unknown> {
  return {
    object: "machine_to_machine_token",
    id: token.token_id,
    token: token.token,
    subject: token.subject,
    scopes: token.scopes,
    claims: token.claims,
    revoked: token.revoked,
    revocation_reason: token.revocation_reason,
    expired: token.expired,
    expiration: token.expiration,
    created_at: token.created_at_unix,
    updated_at: token.updated_at_unix,
  };
}

export function m2mTokenRoutes({ app, store, baseUrl, tokenMap }: RouteContext): void {
  const cs = getClerkStore(store);

  app.post("/m2m_tokens", async (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const body = await readJsonBody(c);
    const tokenFormat = (body.token_format as string) ?? "opaque";
    const secondsUntilExpiration = body.seconds_until_expiration as number | null | undefined;
    const claims = (body.claims as Record<string, unknown>) ?? null;

    const tokenId = generateClerkId("mt_");
    const subject = generateClerkId("mch_");
    const now = nowUnix();
    const nowMs = now * 1000;

    const ttlSeconds = secondsUntilExpiration ?? 3600;
    const expiration = nowMs + ttlSeconds * 1000;

    let tokenString: string;

    if (tokenFormat === "jwt") {
      const { privateKey } = await keyPairPromise;
      const jwtClaims: Record<string, unknown> = {
        scopes: subject,
      };
      if (claims) {
        Object.assign(jwtClaims, claims);
      }

      const builder = new SignJWT(jwtClaims)
        .setProtectedHeader({ alg: "RS256", kid: KID, typ: "JWT" })
        .setIssuer(baseUrl)
        .setSubject(subject)
        .setJti(tokenId)
        .setIssuedAt(now)
        .setExpirationTime(now + ttlSeconds);

      tokenString = await builder.sign(privateKey);
    } else {
      tokenString = `mt_${generateClerkId("")}`;
    }

    const record = cs.m2mTokens.insert({
      token_id: tokenId,
      token: tokenString,
      subject,
      scopes: [subject],
      claims,
      revoked: false,
      revocation_reason: null,
      expired: false,
      expiration,
      created_at_unix: nowMs,
      updated_at_unix: nowMs,
    });

    return c.json(m2mTokenResponse({ ...record, token: tokenString }));
  });

  app.post("/m2m_tokens/verify", async (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const body = await readJsonBody(c);
    const token = body.token as string;
    if (!token) {
      return clerkError(c, 422, "INVALID_REQUEST_BODY", "token is required");
    }

    const record = cs.m2mTokens.all().find((t) => t.token === token);
    if (!record) {
      return clerkError(c, 404, "TOKEN_NOT_FOUND", "Token not found or invalid");
    }

    if (record.revoked) {
      return clerkError(c, 401, "TOKEN_REVOKED", "Token has been revoked");
    }

    if (record.expiration != null && Date.now() > record.expiration) {
      cs.m2mTokens.update(record.id, { expired: true });
      return clerkError(c, 401, "TOKEN_EXPIRED", "Token has expired");
    }

    return c.json(m2mTokenResponse(record));
  });

  app.get("/m2m_tokens", (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const subjectFilter = c.req.query("subject");
    let tokens = cs.m2mTokens.all();

    if (subjectFilter) {
      tokens = tokens.filter((t) => t.subject === subjectFilter);
    }

    tokens.sort((a, b) => b.created_at_unix - a.created_at_unix);

    return c.json({
      m2m_tokens: tokens.map((t) => m2mTokenResponse(t)),
      total_count: tokens.length,
    });
  });

  app.post("/m2m_tokens/:tokenId/revoke", (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const tokenId = c.req.param("tokenId");
    const record = cs.m2mTokens.findOneBy("token_id", tokenId);
    if (!record) {
      return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Token not found");
    }

    cs.m2mTokens.update(record.id, {
      revoked: true,
      revocation_reason: "manually_revoked",
      updated_at_unix: Date.now(),
    });

    const updated = cs.m2mTokens.findOneBy("token_id", tokenId)!;
    return c.json(m2mTokenResponse(updated));
  });
}
