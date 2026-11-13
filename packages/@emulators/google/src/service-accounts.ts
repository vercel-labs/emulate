import { randomBytes } from "node:crypto";
import { decodeJwt, decodeProtectedHeader, importSPKI, importX509, jwtVerify } from "jose";
import type { Context, Store, TokenMap } from "@emulators/core";
import { getGoogleStore } from "./store.js";
import { getAccessTokens } from "./oauth-tokens.js";

export const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

export interface GoogleServiceAccountSeed {
  /** The service account's email address, the JWT's `iss`. */
  client_email: string;
  /** The numeric client ID, which domain-wide delegation names. */
  client_id: string;
  /** The public part of each key: a PEM public key or X.509 certificate, with the key ID (`private_key_id`). */
  keys: Array<{ id: string; public_key: string }>;
}

export interface GoogleDomainWideDelegationSeed {
  client_id: string;
  scopes: string[];
}

const ACCOUNTS_KEY = "google.service_accounts";
const DELEGATION_KEY = "google.domain_wide_delegation";
// The audience Google documents ("always https://oauth2.googleapis.com/token"), and the two older token URLs its own
// examples on the same page still sign for.
const AUDIENCES = new Set([
  "https://oauth2.googleapis.com/token",
  "https://accounts.google.com/o/oauth2/token",
  "https://www.googleapis.com/oauth2/v4/token",
]);
const TOKEN_LIFETIME_S = 3600;
// "the exp value is more than 65 mins in the future from the iat value" is refused.
const MAX_ASSERTION_S = 65 * 60;

export function seedServiceAccounts(
  store: Store,
  accounts: GoogleServiceAccountSeed[] | undefined,
  delegation: GoogleDomainWideDelegationSeed[] | undefined,
): void {
  if (accounts) store.setData(ACCOUNTS_KEY, accounts);
  if (delegation) store.setData(DELEGATION_KEY, delegation);
}

function error(c: Context, code: string, description: string, status: 400 | 401 = 400) {
  return c.json({ error: code, error_description: description }, status);
}

/**
 * The JWT bearer grant of Google's service accounts
 * (https://developers.google.com/identity/protocols/oauth2/service-account): an RS256 assertion signed with one of the
 * account's keys, for itself or, with `sub`, for a user of the domain when domain-wide delegation authorizes the
 * account's client ID for every requested scope.
 */
export async function jwtBearerGrant(c: Context, store: Store, tokenMap: TokenMap | undefined, assertion: string) {
  let header: ReturnType<typeof decodeProtectedHeader>;
  let claims: ReturnType<typeof decodeJwt>;
  try {
    header = decodeProtectedHeader(assertion);
    claims = decodeJwt(assertion);
  } catch {
    return error(c, "invalid_grant", "Invalid JWT Signature.");
  }

  const accounts = store.getData<GoogleServiceAccountSeed[]>(ACCOUNTS_KEY) ?? [];
  const account = accounts.find((entry) => entry.client_email === claims.iss);
  if (!account) {
    // The answer Google gives for a service account that does not exist (deleted or never created).
    return error(c, "invalid_grant", "Invalid grant: account not found");
  }

  // "If an incorrect Key ID is specified, all keys associated with the service account are tried."
  const keys = [...account.keys].sort((a, b) => Number(b.id === header.kid) - Number(a.id === header.kid));
  let verified = false;
  for (const key of keys) {
    try {
      const publicKey = key.public_key.includes("CERTIFICATE")
        ? await importX509(key.public_key, "RS256")
        : await importSPKI(key.public_key, "RS256");
      await jwtVerify(assertion, publicKey, { algorithms: ["RS256"], clockTolerance: 300 });
      verified = true;
      break;
    } catch (cause) {
      if ((cause as { code?: string }).code === "ERR_JWT_EXPIRED") break;
    }
  }
  const now = Math.floor(Date.now() / 1000);
  const iat = typeof claims.iat === "number" ? claims.iat : NaN;
  const exp = typeof claims.exp === "number" ? claims.exp : NaN;
  if (!(exp >= iat && exp - iat <= MAX_ASSERTION_S && iat <= now + 300 && exp >= now - 300)) {
    return error(
      c,
      "invalid_grant",
      "Invalid JWT: Token must be a short-lived token (60 minutes) and in a reasonable timeframe. Check your 'iat' and 'exp' values and use a clock with skew to account for clock differences between systems.",
    );
  }
  if (!verified) return error(c, "invalid_grant", "Invalid JWT Signature.");
  if (typeof claims.aud !== "string" || !AUDIENCES.has(claims.aud)) {
    return error(c, "invalid_grant", "Invalid JWT: Invalid audience.");
  }

  const scope = typeof claims.scope === "string" ? claims.scope.trim() : "";
  const scopes = scope.split(/\s+/).filter(Boolean);
  if (scopes.length === 0) {
    return error(c, "invalid_scope", "Invalid OAuth scope or ID token audience provided.");
  }

  let email = account.client_email;
  if (claims.sub !== undefined) {
    const user = getGoogleStore(store)
      .users.all()
      .find((entry) => entry.email.toLowerCase() === String(claims.sub).toLowerCase());
    if (!user) return error(c, "invalid_grant", "Invalid email or User ID");
    const delegation = store.getData<GoogleDomainWideDelegationSeed[]>(DELEGATION_KEY) ?? [];
    const authorized = delegation.find((entry) => entry.client_id === account.client_id);
    // Google's JWT error table: a client not authorized for domain-wide delegation is `unauthorized_client`, a
    // requested scope missing from its authorization is `access_denied` ("any value" as description). The statuses
    // are not documented.
    if (!authorized) return error(c, "unauthorized_client", "Unauthorized client or scope in request.", 401);
    if (!scopes.every((requested) => authorized.scopes.includes(requested))) {
      return error(c, "access_denied", "Requested client not authorized.", 401);
    }
    email = user.email;
  }

  const token = "google_" + randomBytes(20).toString("base64url");
  // No refresh token is issued for this grant; each access token stands alone when revoked.
  getAccessTokens(store).set(token, {
    email,
    scopes,
    expiresAt: Date.now() + TOKEN_LIFETIME_S * 1000,
    refreshToken: `jwt-bearer:${token}`,
  });
  tokenMap?.set(token, { login: email, id: 0, scopes });

  return c.json({ access_token: token, scope: scopes.join(" "), token_type: "Bearer", expires_in: TOKEN_LIFETIME_S });
}
