import { X509Certificate, createPublicKey, randomBytes, type KeyObject } from "node:crypto";
import { compactVerify, decodeJwt, decodeProtectedHeader, type JWTPayload, type ProtectedHeaderParameters } from "jose";
import type { Store, TokenMap } from "@emulators/core";
import { getGoogleStore } from "./store.js";
import { issueAccessToken } from "./oauth-tokens.js";

export const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

// The documented audience, plus the older token URLs that existing libraries and Google's own samples still use.
const TOKEN_AUDIENCES = new Set([
  "https://oauth2.googleapis.com/token",
  "https://accounts.google.com/o/oauth2/token",
  "https://www.googleapis.com/oauth2/v4/token",
]);
const MAX_LIFETIME_SECONDS = 65 * 60;
const CLOCK_SKEW_SECONDS = 5 * 60;

export interface GoogleSeedServiceAccount {
  client_email: string;
  client_id: string;
  keys: Array<{
    key_id: string;
    /** PEM public key or X.509 certificate for the account's private key. */
    public_key: string;
  }>;
}

export interface GoogleSeedDelegation {
  /** The service account's numeric client ID, as entered on the Admin console's domain-wide delegation page. */
  client_id: string;
  scopes: string[];
}

interface StoredServiceAccount {
  client_email: string;
  client_id: string;
  keys: Array<{ key_id: string; public_key: string }>;
}

const ACCOUNTS_KEY = "google.service_accounts";
const DELEGATION_KEY = "google.domain_wide_delegation";

export function seedServiceAccounts(
  store: Store,
  accounts: GoogleSeedServiceAccount[] | undefined,
  delegation: GoogleSeedDelegation[] | undefined,
): void {
  if (accounts) {
    const stored = [...(store.getData<StoredServiceAccount[]>(ACCOUNTS_KEY) ?? [])];
    for (const account of accounts) {
      if (!account.client_email || !account.client_id || !account.keys?.length) {
        throw new Error("Google service accounts need client_email, client_id, and at least one key");
      }
      for (const key of account.keys) toPublicKey(key.public_key, account.client_email);
      const index = stored.findIndex((entry) => entry.client_email === account.client_email);
      const entry = {
        client_email: account.client_email,
        client_id: String(account.client_id),
        keys: account.keys.map((key) => ({ key_id: key.key_id, public_key: key.public_key })),
      };
      if (index === -1) stored.push(entry);
      else stored[index] = entry;
    }
    store.setData(ACCOUNTS_KEY, stored);
  }

  if (delegation) {
    const stored = new Map(
      (store.getData<GoogleSeedDelegation[]>(DELEGATION_KEY) ?? []).map((entry) => [entry.client_id, entry]),
    );
    for (const entry of delegation) {
      stored.set(String(entry.client_id), { client_id: String(entry.client_id), scopes: [...(entry.scopes ?? [])] });
    }
    store.setData(DELEGATION_KEY, [...stored.values()]);
  }
}

/** The seeded service account with this email, which strict mode accepts as a token's subject. */
export function findServiceAccount(store: Store, email: string): { email: string; id: number } | undefined {
  const account = (store.getData<StoredServiceAccount[]>(ACCOUNTS_KEY) ?? []).find(
    (entry) => entry.client_email === email,
  );
  return account ? { email: account.client_email, id: 0 } : undefined;
}

function toPublicKey(pem: string, account: string): KeyObject {
  try {
    return pem.includes("BEGIN CERTIFICATE") ? new X509Certificate(pem).publicKey : createPublicKey(pem);
  } catch {
    throw new Error(`Google service account ${account} has a key that is not a PEM public key or certificate`);
  }
}

type TokenError = { status: 400 | 401 | 403; error: string; error_description: string };
type TokenResult = { ok: true; body: Record<string, unknown> } | ({ ok: false } & TokenError);

const fail = (status: TokenError["status"], error: string, error_description: string): TokenResult => ({
  ok: false,
  status,
  error,
  error_description,
});

/**
 * Exchanges a service account's signed JWT for an access token, following
 * https://developers.google.com/identity/protocols/oauth2/service-account. With a `sub` claim, the
 * token acts as that user, which needs domain-wide delegation for every requested scope.
 */
export async function exchangeServiceAccountAssertion(
  store: Store,
  tokenMap: TokenMap | undefined,
  assertion: string,
  baseUrl: string,
  now = Math.floor(Date.now() / 1000),
): Promise<TokenResult> {
  let header: ProtectedHeaderParameters;
  let claims: JWTPayload;
  try {
    header = decodeProtectedHeader(assertion);
    claims = decodeJwt(assertion);
  } catch {
    return fail(400, "invalid_request", "Bad Request");
  }

  const scopes = typeof claims.scope === "string" ? claims.scope.split(" ").filter(Boolean) : [];
  if (scopes.length === 0) {
    return fail(400, "invalid_scope", "Invalid OAuth scope or ID token audience provided.");
  }

  const gs = getGoogleStore(store);
  const subject = typeof claims.sub === "string" && claims.sub ? claims.sub : undefined;
  const user = subject
    ? gs.users.all().find((candidate) => candidate.email.toLowerCase() === subject.toLowerCase())
    : undefined;
  if (subject && !user) return fail(400, "invalid_grant", "Not a valid email or user ID.");

  const account = (store.getData<StoredServiceAccount[]>(ACCOUNTS_KEY) ?? []).find(
    (entry) => entry.client_email === claims.iss,
  );
  if (!account) return fail(400, "invalid_grant", "Invalid grant: account not found");

  if (!(await verifySignature(assertion, header, account))) {
    return fail(400, "invalid_grant", "Invalid JWT Signature.");
  }

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  // Clients whose token_uri points at the emulator sign its own token URL as the audience.
  const emulatorAudience = `${baseUrl.replace(/\/+$/, "")}/oauth2/token`;
  if (!audiences.some((aud) => typeof aud === "string" && (TOKEN_AUDIENCES.has(aud) || aud === emulatorAudience))) {
    return fail(400, "invalid_grant", "Invalid JWT: Invalid audience.");
  }

  const { iat, exp } = claims;
  if (
    typeof iat !== "number" ||
    typeof exp !== "number" ||
    exp < iat ||
    exp - iat > MAX_LIFETIME_SECONDS ||
    iat > now + CLOCK_SKEW_SECONDS ||
    exp < now - CLOCK_SKEW_SECONDS
  ) {
    return fail(
      400,
      "invalid_grant",
      "Invalid JWT: Token must be a short-lived token (60 minutes) and in a reasonable timeframe. Check your iat and exp values in the JWT claim.",
    );
  }

  if (user) {
    const delegation = (store.getData<GoogleSeedDelegation[]>(DELEGATION_KEY) ?? []).find(
      (entry) => entry.client_id === account.client_id,
    );
    if (!delegation) return fail(401, "unauthorized_client", "Unauthorized client or scope in request.");
    const granted = scopes.filter((scope) => delegation.scopes.includes(scope));
    if (granted.length === 0) {
      return fail(
        401,
        "unauthorized_client",
        "Client is unauthorized to retrieve access tokens using this method, or client not authorized for any of the scopes requested.",
      );
    }
    if (granted.length < scopes.length) return fail(403, "access_denied", "Requested client not authorized.");
  }

  const scope = scopes.join(" ");
  // Service account tokens have no refresh token, so each one gets its own revocation key.
  const revocationKey = "google_sa_" + randomBytes(12).toString("base64url");
  const accessToken = issueAccessToken(
    store,
    tokenMap,
    user ?? { email: account.client_email, id: 0 },
    scope,
    revocationKey,
  );
  return { ok: true, body: { access_token: accessToken, expires_in: 3600, scope, token_type: "Bearer" } };
}

async function verifySignature(
  assertion: string,
  header: ProtectedHeaderParameters,
  account: StoredServiceAccount,
): Promise<boolean> {
  if (header.alg !== "RS256") return false;
  // A key ID that names none of the account's keys falls back to trying every key, as Google documents.
  const named = account.keys.filter((key) => key.key_id === header.kid);
  const candidates =
    named.length > 0 ? [...named, ...account.keys.filter((key) => !named.includes(key))] : account.keys;
  for (const key of candidates) {
    try {
      await compactVerify(assertion, toPublicKey(key.public_key, account.client_email), { algorithms: ["RS256"] });
      return true;
    } catch {
      // Try the next key.
    }
  }
  return false;
}
