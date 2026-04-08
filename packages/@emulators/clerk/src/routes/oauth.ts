import { randomBytes } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type { Context } from "hono";
import type { AppEnv, RouteContext, Store } from "@emulators/core";
import {
  bodyStr,
  constantTimeSecretEqual,
  escapeAttr,
  escapeHtml,
  matchesRedirectUri,
  renderCardPage,
  renderErrorPage,
  renderUserButton,
} from "@emulators/core";
import type { ClerkUser } from "../entities.js";
import { userDisplayName } from "../helpers.js";
import { clerkError } from "../route-helpers.js";
import { getClerkStore } from "../store.js";

const keyPairPromise = generateKeyPair("RS256");
const KID = "emulate-clerk-1";

const CODE_TTL_MS = 10 * 60 * 1000;

type PendingCode = {
  userClerkId: string;
  scope: string;
  redirectUri: string;
  clientId: string;
  nonce: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  createdAt: number;
};

function getPendingCodes(store: Store): Map<string, PendingCode> {
  let map = store.getData<Map<string, PendingCode>>("clerk.oauth.pendingCodes");
  if (!map) {
    map = new Map();
    store.setData("clerk.oauth.pendingCodes", map);
  }
  return map;
}

function isCodeExpired(code: PendingCode): boolean {
  return Date.now() - code.createdAt > CODE_TTL_MS;
}

export async function createSessionToken(
  store: Store,
  user: ClerkUser,
  sessionId: string,
  baseUrl: string,
  orgId?: string,
  orgRole?: string,
  orgSlug?: string,
  orgPermissions?: string[],
): Promise<string> {
  const { privateKey } = await keyPairPromise;
  const now = Math.floor(Date.now() / 1000);

  const claims: Record<string, unknown> = {
    sid: sessionId,
  };

  if (orgId) {
    claims.org_id = orgId;
    claims.org_role = orgRole ?? "org:member";
    claims.org_slug = orgSlug;
    claims.org_permissions = orgPermissions ?? [];
  }

  if (Object.keys(user.public_metadata).length > 0) {
    claims.metadata = user.public_metadata;
  }

  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KID, typ: "JWT" })
    .setIssuer(baseUrl)
    .setSubject(user.clerk_id)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime("1h")
    .sign(privateKey);
}

export function oauthRoutes({ app, store, baseUrl, tokenMap }: RouteContext): void {
  const clerkStore = getClerkStore(store);
  const SERVICE_LABEL = "Clerk";

  app.get("/.well-known/openid-configuration", (c) => {
    return c.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      userinfo_endpoint: `${baseUrl}/oauth/userinfo`,
      jwks_uri: `${baseUrl}/v1/jwks`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: ["openid", "profile", "email"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
      claims_supported: [
        "sub",
        "iss",
        "aud",
        "exp",
        "iat",
        "nbf",
        "azp",
        "sid",
        "org_id",
        "org_role",
        "org_slug",
        "org_permissions",
      ],
      code_challenge_methods_supported: ["plain", "S256"],
    });
  });

  app.get("/v1/jwks", async (c) => {
    const { publicKey } = await keyPairPromise;
    const jwk = await exportJWK(publicKey);
    return c.json({
      keys: [{ ...jwk, kid: KID, use: "sig", alg: "RS256" }],
    });
  });

  app.get("/oauth/authorize", (c) => {
    const clientId = c.req.query("client_id") ?? "";
    const redirectUri = c.req.query("redirect_uri") ?? "";
    const scope = c.req.query("scope") ?? "openid profile email";
    const state = c.req.query("state") ?? "";
    const nonce = c.req.query("nonce") ?? "";
    const responseType = c.req.query("response_type") ?? "code";
    const codeChallenge = c.req.query("code_challenge") ?? "";
    const codeChallengeMethod = c.req.query("code_challenge_method") ?? "";

    if (responseType !== "code") {
      return c.html(
        renderErrorPage("Unsupported response_type", "Only response_type=code is supported.", SERVICE_LABEL),
        400,
      );
    }

    if (!redirectUri) {
      return c.html(
        renderErrorPage("Missing redirect URI", "The redirect_uri parameter is required.", SERVICE_LABEL),
        400,
      );
    }

    const oauthApps = clerkStore.oauthApps.all();
    let appName = "";
    if (oauthApps.length > 0) {
      const oauthApp = oauthApps.find((a) => a.client_id === clientId);
      if (!oauthApp) {
        return c.html(
          renderErrorPage("Application not found", `The client_id '${clientId}' is not registered.`, SERVICE_LABEL),
          400,
        );
      }
      if (!matchesRedirectUri(redirectUri, oauthApp.redirect_uris)) {
        return c.html(
          renderErrorPage("Redirect URI mismatch", "The redirect_uri is not registered for this application.", SERVICE_LABEL),
          400,
        );
      }
      appName = oauthApp.name;
    }

    const users = clerkStore.users.all();
    const buttons = users
      .map((user) => {
        const emails = clerkStore.emailAddresses.findBy("user_id", user.clerk_id);
        const primaryEmail = emails.find((e) => e.is_primary) ?? emails[0];
        return renderUserButton({
          letter: ((user.first_name ?? user.username ?? "?")[0] ?? "?").toUpperCase(),
          login: primaryEmail?.email_address ?? user.username ?? user.clerk_id,
          name: userDisplayName(user),
          email: primaryEmail?.email_address ?? "",
          formAction: "/oauth/authorize/callback",
          hiddenFields: {
            user_ref: user.clerk_id,
            redirect_uri: redirectUri,
            scope,
            state,
            nonce,
            client_id: clientId,
            code_challenge: codeChallenge,
            code_challenge_method: codeChallengeMethod,
          },
        });
      })
      .join("\n");

    const subtitle = appName
      ? `Sign in to <strong>${escapeHtml(appName)}</strong> with your Clerk account.`
      : "Choose a seeded user to continue.";

    return c.html(
      renderCardPage(
        "Sign in with Clerk",
        subtitle,
        users.length > 0 ? buttons : '<p class="empty">No users in the emulator store.</p>',
        SERVICE_LABEL,
      ),
    );
  });

  app.post("/oauth/authorize/callback", async (c) => {
    const body = await c.req.parseBody();
    const userRef = bodyStr(body.user_ref);
    const redirectUri = bodyStr(body.redirect_uri);
    const scope = bodyStr(body.scope) || "openid profile email";
    const state = bodyStr(body.state);
    const nonce = bodyStr(body.nonce);
    const clientId = bodyStr(body.client_id);
    const codeChallenge = bodyStr(body.code_challenge);
    const codeChallengeMethod = bodyStr(body.code_challenge_method);

    if (!redirectUri) {
      return c.html(
        renderErrorPage("Missing redirect URI", "The redirect_uri parameter is required.", SERVICE_LABEL),
        400,
      );
    }

    const user = clerkStore.users.findOneBy("clerk_id", userRef);
    if (!user) {
      return c.html(
        renderErrorPage("Unknown user", "The selected user is not available.", SERVICE_LABEL),
        400,
      );
    }

    const oauthApps = clerkStore.oauthApps.all();
    if (oauthApps.length > 0) {
      const oauthApp = oauthApps.find((a) => a.client_id === clientId);
      if (!oauthApp) {
        return c.html(
          renderErrorPage("Application not found", `The client_id '${clientId}' is not registered.`, SERVICE_LABEL),
          400,
        );
      }
      if (!matchesRedirectUri(redirectUri, oauthApp.redirect_uris)) {
        return c.html(
          renderErrorPage("Redirect URI mismatch", "The redirect_uri is not registered for this application.", SERVICE_LABEL),
          400,
        );
      }
    }

    const code = randomBytes(20).toString("hex");
    getPendingCodes(store).set(code, {
      userClerkId: user.clerk_id,
      scope,
      redirectUri,
      clientId,
      nonce: nonce || null,
      codeChallenge: codeChallenge || null,
      codeChallengeMethod: codeChallengeMethod || null,
      createdAt: Date.now(),
    });

    const url = new URL(redirectUri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    return c.redirect(url.toString(), 302);
  });

  app.post("/oauth/token", async (c) => {
    const contentType = c.req.header("Content-Type") ?? "";
    let body: Record<string, string> = {};

    if (contentType.includes("application/json")) {
      try {
        const parsed = await c.req.json() as Record<string, unknown>;
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "string") body[key] = value;
        }
      } catch {
        body = {};
      }
    } else {
      const raw = await c.req.text();
      body = Object.fromEntries(new URLSearchParams(raw));
    }

    const grantType = body.grant_type ?? "";
    const code = body.code ?? "";
    const redirectUri = body.redirect_uri ?? "";
    const codeVerifier = body.code_verifier;

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

    if (grantType !== "authorization_code") {
      return c.json({ error: "unsupported_grant_type", error_description: "Only authorization_code is supported." }, 400);
    }

    const pending = getPendingCodes(store).get(code);
    if (!pending || isCodeExpired(pending)) {
      if (pending) getPendingCodes(store).delete(code);
      return c.json({ error: "invalid_grant", error_description: "Authorization code is invalid or expired." }, 400);
    }

    if (redirectUri && redirectUri !== pending.redirectUri) {
      return c.json({ error: "invalid_grant", error_description: "redirect_uri does not match." }, 400);
    }

    const oauthApps = clerkStore.oauthApps.all();
    if (oauthApps.length > 0) {
      const oauthApp = oauthApps.find((a) => a.client_id === clientId);
      if (!oauthApp) {
        return c.json({ error: "invalid_client", error_description: "Unknown client." }, 401);
      }
      if (!oauthApp.is_public && !constantTimeSecretEqual(oauthApp.client_secret, clientSecret)) {
        return c.json({ error: "invalid_client", error_description: "Invalid client credentials." }, 401);
      }
    }

    if (pending.codeChallenge !== null) {
      if (!codeVerifier) {
        return c.json({ error: "invalid_grant", error_description: "PKCE verification failed." }, 400);
      }
      const method = (pending.codeChallengeMethod ?? "plain").toLowerCase();
      if (method === "s256") {
        const { createHash } = await import("node:crypto");
        const expected = createHash("sha256").update(codeVerifier).digest("base64url");
        if (expected !== pending.codeChallenge) {
          return c.json({ error: "invalid_grant", error_description: "PKCE verification failed." }, 400);
        }
      } else if (method === "plain") {
        if (codeVerifier !== pending.codeChallenge) {
          return c.json({ error: "invalid_grant", error_description: "PKCE verification failed." }, 400);
        }
      }
    }

    const user = clerkStore.users.findOneBy("clerk_id", pending.userClerkId);
    if (!user) return c.json({ error: "invalid_grant", error_description: "Unknown user." }, 400);
    getPendingCodes(store).delete(code);

    const { generateClerkId, nowUnix } = await import("../helpers.js");
    const sessionId = generateClerkId("sess_");
    const now = nowUnix();

    clerkStore.sessions.insert({
      clerk_id: sessionId,
      user_id: user.clerk_id,
      client_id: clientId || "default",
      status: "active",
      last_active_at: now,
      expire_at: now + 86400,
      abandon_at: now + 604800,
      created_at_unix: now,
      updated_at_unix: now,
    });

    const accessToken = `clerk_${randomBytes(20).toString("base64url")}`;

    tokenMap?.set(accessToken, {
      login: user.clerk_id,
      id: user.id,
      scopes: pending.scope.split(/\s+/).filter(Boolean),
    });

    const { privateKey } = await keyPairPromise;
    const nowSec = Math.floor(Date.now() / 1000);
    const emails = clerkStore.emailAddresses.findBy("user_id", user.clerk_id);
    const primaryEmail = emails.find((e) => e.is_primary) ?? emails[0];

    const idToken = await new SignJWT({
      sid: sessionId,
      email: primaryEmail?.email_address,
      email_verified: primaryEmail?.verification_status === "verified",
      name: [user.first_name, user.last_name].filter(Boolean).join(" ") || undefined,
    })
      .setProtectedHeader({ alg: "RS256", kid: KID, typ: "JWT" })
      .setIssuer(baseUrl)
      .setSubject(user.clerk_id)
      .setAudience(clientId || "default")
      .setIssuedAt(nowSec)
      .setExpirationTime("1h")
      .sign(privateKey);

    return c.json({
      token_type: "Bearer",
      expires_in: 3600,
      access_token: accessToken,
      id_token: idToken,
      scope: pending.scope,
    });
  });

  app.get("/oauth/userinfo", (c) => {
    const authUser = c.get("authUser");
    if (!authUser) {
      return c.json({ error: "invalid_token", error_description: "The access token is invalid." }, 401);
    }

    const user = clerkStore.users.findOneBy("clerk_id", authUser.login) ?? clerkStore.users.all()[0];
    if (!user) {
      return c.json({ error: "invalid_token", error_description: "User not found." }, 401);
    }

    const emails = clerkStore.emailAddresses.findBy("user_id", user.clerk_id);
    const primaryEmail = emails.find((e) => e.is_primary) ?? emails[0];

    return c.json({
      sub: user.clerk_id,
      name: [user.first_name, user.last_name].filter(Boolean).join(" ") || undefined,
      email: primaryEmail?.email_address,
      email_verified: primaryEmail?.verification_status === "verified",
      picture: user.image_url,
    });
  });
}

export { keyPairPromise, KID };
