import { randomBytes } from "crypto";
import { SignJWT, exportJWK, generateKeyPair, type KeyLike } from "jose";
import type { RouteContext, Store } from "@internal/core";
import { escapeHtml, renderCardPage, renderUserButton, bodyStr, debug } from "@internal/core";
import { getDescopeStore } from "../store.js";
import type { DescopeUser, AuthenticationInfo, PendingOAuthAuthorization } from "../entities.js";

// ES256 key pair for JWT signing. Generated once at module load.
// The public key is served via /v2/keys/:projectId so the Descope SDK can
// validate tokens issued by the emulator.
let ES256_PRIVATE_KEY: KeyLike;
let ES256_PUBLIC_JWK: Record<string, unknown>;

const keyPairReady = generateKeyPair("ES256").then(async ({ privateKey, publicKey }) => {
  ES256_PRIVATE_KEY = privateKey;
  const pubJwk = await exportJWK(publicKey);
  pubJwk.alg = "ES256";
  pubJwk.use = "sig";
  pubJwk.kid = "emulate-descope-key-1";
  ES256_PUBLIC_JWK = pubJwk;
});

const PENDING_AUTH_TTL_MS = 10 * 60 * 1000;
const SERVICE_LABEL = "Descope";

function getPendingAuthorizations(store: Store): Map<string, PendingOAuthAuthorization> {
  let map = store.getData<Map<string, PendingOAuthAuthorization>>("descope.oauth.pendingAuth");
  if (!map) {
    map = new Map();
    store.setData("descope.oauth.pendingAuth", map);
  }
  return map;
}

function isPendingAuthExpired(p: PendingOAuthAuthorization): boolean {
  return Date.now() - p.createdAt > PENDING_AUTH_TTL_MS;
}

// Create a session JWT with the `drn` claim set to "DS" (Descope Session).
// The Descope Go SDK uses the `drn` claim to identify session vs refresh tokens.
async function createSessionToken(
  user: DescopeUser,
  projectId: string,
): Promise<{ jwt: string; expiration: number }> {
  await keyPairReady;
  const now = Math.floor(Date.now() / 1000);
  const expiration = now + 3600; // 1 hour

  const jwt = await new SignJWT({
    drn: "DS", // Descope Session — SDK uses this to identify the session token
    sub: user.uid,
    email: user.email,
    name: user.name,
    permissions: user.permissions || [],
    roles: user.roles || [],
    tenants: user.tenants || [],
  })
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: "emulate-descope-key-1" })
    .setIssuer(projectId)
    .setAudience(projectId)
    .setIssuedAt(now)
    .setExpirationTime(expiration)
    .setSubject(user.uid)
    .sign(ES256_PRIVATE_KEY);

  return { jwt, expiration: expiration * 1000 };
}

// Create a refresh JWT with the `drn` claim set to "DSR" (Descope Session Refresh).
async function createRefreshToken(
  user: DescopeUser,
  projectId: string,
): Promise<{ jwt: string; expiration: number }> {
  await keyPairReady;
  const now = Math.floor(Date.now() / 1000);
  const expiration = now + (30 * 24 * 60 * 60); // 30 days

  const jwt = await new SignJWT({
    drn: "DSR", // Descope Session Refresh — SDK uses this to identify the refresh token
    sub: user.uid,
  })
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: "emulate-descope-key-1" })
    .setIssuer(projectId)
    .setAudience(projectId)
    .setIssuedAt(now)
    .setExpirationTime(expiration)
    .setSubject(user.uid)
    .sign(ES256_PRIVATE_KEY);

  return { jwt, expiration: expiration * 1000 };
}

export function descopeApiRoutes({ app, store, baseUrl }: RouteContext): void {
  const ds = getDescopeStore(store);

  // ============================================
  // Descope Proprietary OAuth API Endpoints
  // ============================================

  // POST /v1/auth/oauth/authorize
  // Descope SDK OAuth().Start() calls this
  app.post("/v1/auth/oauth/authorize", async (c) => {
    try {
      // The Descope SDK sends provider and redirectURL as query params,
      // with loginOptions as the JSON body (which may be null/empty).
      let body: Record<string, unknown> = {};
      try {
        body = await c.req.json();
      } catch {
        // Body is empty/null — SDK sends nil when loginOptions is nil.
      }

      const provider = (c.req.query("provider") ?? body.provider ?? "google") as string;
      const redirectUrl = (c.req.query("redirectURL") ?? body.redirectUrl ?? "") as string;
      const { loginHint } = body as Record<string, unknown>;

      // Parse and validate projectId from Authorization header
      const authHeader = c.req.header("Authorization") || "";
      if (!authHeader.startsWith("Bearer ")) {
        return c.json({ error: "invalid_project", error_description: "Project ID required" }, 400);
      }
      const token = authHeader.replace("Bearer ", "");
      if (!token) {
        return c.json({ error: "invalid_project", error_description: "Project ID required" }, 400);
      }
      const [projectId] = token.split(":");
      if (!projectId || projectId.length < 3) {
        return c.json({ error: "invalid_project", error_description: "Project ID required" }, 400);
      }

      // Generate authorization code
      const code = randomBytes(20).toString("hex");
      
      // Store pending authorization (without user yet - user will be selected)
      const pendingAuth: PendingOAuthAuthorization = {
        code,
        projectId,
        provider,
        redirectUrl: redirectUrl || "",
        loginHint,
        email: "", // Will be set when user selects
        createdAt: Date.now(),
      };
      
      getPendingAuthorizations(store).set(code, pendingAuth);

      // Return URL to internal picker
      const pickerUrl = `${baseUrl}/v1/auth/oauth/authorize/picker?code=${code}&project_id=${projectId}`;
      
      debug("descope.api", `[Authorize] projectId=${projectId} provider=${provider} code=${code.slice(0, 8)}...`);

      return c.json({ url: pickerUrl });
    } catch (error) {
      console.error("Authorize error:", error);
      return c.json({ error: "server_error", error_description: "Internal server error" }, 500);
    }
  });

  // GET /v1/auth/oauth/authorize/picker
  // Internal endpoint: Shows user picker UI
  app.get("/v1/auth/oauth/authorize/picker", (c) => {
    const code = c.req.query("code") || "";
    const projectId = c.req.query("project_id") || "";

    const pendingAuth = getPendingAuthorizations(store).get(code);
    if (!pendingAuth || isPendingAuthExpired(pendingAuth)) {
      return c.html(
        renderCardPage(
          "Error",
          "Invalid or expired authorization request.",
          '<p class="empty">Please try again.</p>',
          SERVICE_LABEL
        ),
        400
      );
    }

    const users = ds.users.all();
    const subtitleText = `Sign in to <strong>${escapeHtml(pendingAuth.provider)}</strong> via Descope.`;

    const userButtons = users
      .map((user) => {
        return renderUserButton({
          letter: (user.email[0] ?? "?").toUpperCase(),
          login: user.email,
          name: user.name,
          email: user.email,
          formAction: "/v1/auth/oauth/authorize/complete",
          hiddenFields: {
            code,
            email: user.email,
          },
        });
      })
      .join("\n");

    const body = users.length === 0
      ? '<p class="empty">No users in the emulator store.</p>'
      : userButtons;

    return c.html(renderCardPage("Sign in to Descope", subtitleText, body, SERVICE_LABEL));
  });

  // POST /v1/auth/oauth/authorize/complete
  // Internal endpoint: Completes user selection
  app.post("/v1/auth/oauth/authorize/complete", async (c) => {
    const body = await c.req.parseBody();
    const code = bodyStr(body.code);
    const email = bodyStr(body.email);

    const pendingMap = getPendingAuthorizations(store);
    const pendingAuth = pendingMap.get(code);
    
    if (!pendingAuth || isPendingAuthExpired(pendingAuth)) {
      return c.html(
        renderCardPage(
          "Error",
          "Invalid or expired authorization request.",
          '<p class="empty">Please try again.</p>',
          SERVICE_LABEL
        ),
        400
      );
    }

    // Update pending auth with selected user
    pendingAuth.email = email;
    pendingMap.set(code, pendingAuth);

    debug("descope.api", `[Authorize Complete] code=${code.slice(0, 8)}... email=${email}`);

    // Redirect back to the original redirectUrl with the code
    const redirectUrl = pendingAuth.redirectUrl || "http://localhost:3000";
    const finalUrl = new URL(redirectUrl);
    finalUrl.searchParams.set("code", code);

    return c.redirect(finalUrl.toString(), 302);
  });

  // POST /v1/auth/oauth/exchange
  // Descope SDK OAuth().ExchangeToken() calls this
  app.post("/v1/auth/oauth/exchange", async (c) => {
    try {
      const body = await c.req.json();
      const { code } = body;

      // Parse and validate projectId from Authorization header
      const authHeader = c.req.header("Authorization") || "";
      if (!authHeader.startsWith("Bearer ")) {
        return c.json({ error: "invalid_project", error_description: "Project ID required" }, 400);
      }
      const token = authHeader.replace("Bearer ", "");
      if (!token) {
        return c.json({ error: "invalid_project", error_description: "Project ID required" }, 400);
      }
      const [projectId] = token.split(":");
      if (!projectId || projectId.length < 3) {
        return c.json({ error: "invalid_project", error_description: "Project ID required" }, 400);
      }

      const pendingMap = getPendingAuthorizations(store);
      const pendingAuth = pendingMap.get(code);

      if (!pendingAuth || isPendingAuthExpired(pendingAuth)) {
        return c.json({ error: "invalid_grant", error_description: "Invalid or expired code" }, 400);
      }

      // Find the user
      const user = ds.users.findOneBy("email", pendingAuth.email);
      if (!user) {
        return c.json({ error: "invalid_grant", error_description: "User not found" }, 400);
      }

      // Clean up pending auth
      pendingMap.delete(code);

      // Generate tokens
      const sessionToken = await createSessionToken(user, projectId);
      const refreshToken = await createRefreshToken(user, projectId);

      // Return JWTResponse format — the Descope Go SDK parses this with
      // extractJWTResponse() and expects flat sessionJwt/refreshJwt strings,
      // plus a user object matching the UserResponse struct.
      const jwtResponse = {
        sessionJwt: sessionToken.jwt,
        refreshJwt: refreshToken.jwt,
        cookieDomain: "",
        cookiePath: "/",
        cookieMaxAge: 3600,
        cookieExpiration: 0,
        user: {
          userId: user.uid,
          loginIds: [user.email],
          name: user.name,
          email: user.email,
          verifiedEmail: user.email_verified,
          status: "enabled",
          oauth: { [pendingAuth.provider]: true },
        },
        firstSeen: false,
      };

      debug("descope.api", `[Exchange] projectId=${projectId} user=${user.email}`);

      return c.json(jwtResponse);
    } catch (error) {
      console.error("Exchange error:", error);
      return c.json({ error: "server_error", error_description: "Internal server error" }, 500);
    }
  });

  // ============================================
  // Public Key Endpoint
  // ============================================
  // The Descope SDK fetches /v2/keys/{projectId} to get JWKs for token
  // validation. We serve the HS256 symmetric key so the SDK can verify
  // the emulator-issued JWTs.
  app.get("/v2/keys/:projectId", async (c) => {
    await keyPairReady;
    return c.json({ keys: [ES256_PUBLIC_JWK] });
  });
}
