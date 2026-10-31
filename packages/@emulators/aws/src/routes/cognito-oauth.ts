import { createHash, randomBytes } from "node:crypto";
import {
  constantTimeSecretEqual,
  renderCardPage,
  renderUserButton,
  type Context,
  type RouteContext,
} from "@emulators/core";
import { getCognitoStore } from "../cognito/store.js";
import {
  CognitoError,
  checkUser,
  getClient,
  getPool,
  getUser,
  issueTokens,
  issuer,
  refreshSession,
  signingKey,
  verifyToken,
} from "../cognito/helpers.js";

export function cognitoOAuthRoutes({ app, store, baseUrl }: RouteContext) {
  const cs = () => getCognitoStore(store);
  const root = "/cognito-idp/:poolId";
  const oauthError = (c: Context, error: string, description: string, status: 400 | 401 = 400) =>
    c.json({ error, error_description: description }, status);

  app.get(`${root}/.well-known/openid-configuration`, (c) => {
    const pool = cs().pools.findOneBy("pool_id", c.req.param("poolId"));
    if (!pool) return c.json({ error: "not_found" }, 404);
    const url = issuer(baseUrl, pool.pool_id);
    return c.json({
      issuer: url,
      authorization_endpoint: `${url}/oauth2/authorize`,
      token_endpoint: `${url}/oauth2/token`,
      userinfo_endpoint: `${url}/oauth2/userInfo`,
      jwks_uri: `${url}/.well-known/jwks.json`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
      scopes_supported: ["openid", "email", "profile", "aws.cognito.signin.user.admin"],
      code_challenge_methods_supported: ["S256"],
    });
  });
  app.get(`${root}/.well-known/jwks.json`, (c) => {
    const pool = cs().pools.findOneBy("pool_id", c.req.param("poolId"));
    if (!pool) return c.json({ error: "not_found" }, 404);
    return c.json({ keys: [signingKey(store, pool.pool_id).jwk] });
  });

  for (const method of ["GET", "POST"])
    app.on(method, `${root}/oauth2/authorize`, async (c) => {
      try {
        const pool = getPool(store, c.req.param("poolId"));
        const params = method === "GET" ? new URL(c.req.url).searchParams : new URLSearchParams(await c.req.text());
        const client = getClient(store, params.get("client_id") ?? "");
        if (client.pool_id !== pool.pool_id)
          return oauthError(c, "invalid_client", "Client does not belong to this user pool.");
        const redirect = params.get("redirect_uri") ?? "";
        if (!client.redirect_uris.includes(redirect))
          return oauthError(c, "invalid_request", "redirect_uri must exactly match a registered URI.");
        if (params.get("response_type") !== "code")
          return oauthError(c, "unsupported_response_type", "Only the authorization code flow is simulated.");
        const scopes = [...new Set((params.get("scope") ?? "openid").split(" ").filter(Boolean))];
        if (scopes.some((scope) => !client.scopes.includes(scope)))
          return oauthError(c, "invalid_scope", "A requested scope is not allowed for this client.");
        const challenge = params.get("code_challenge");
        if (
          (challenge && (!/^[A-Za-z0-9_-]{43}$/.test(challenge) || params.get("code_challenge_method") !== "S256")) ||
          (!challenge && params.has("code_challenge_method"))
        ) {
          return oauthError(c, "invalid_request", "PKCE requires an S256 code challenge.");
        }
        if (method === "GET") {
          const users = cs()
            .users.findBy("pool_id", pool.pool_id)
            .filter((user) => user.enabled && user.status === "CONFIRMED");
          const fields = Object.fromEntries([...params].filter(([name]) => name !== "username"));
          const buttons = users
            .map((user) =>
              renderUserButton({
                login: user.username,
                letter: user.username[0].toUpperCase(),
                name: user.attributes.name,
                email: user.attributes.email,
                formAction: `${issuer(baseUrl, pool.pool_id)}/oauth2/authorize`,
                hiddenFields: { ...fields, username: user.username },
              }),
            )
            .join("");
          return c.html(
            renderCardPage(
              "Sign in with Cognito",
              "Choose a local test user",
              buttons || '<p class="empty">Seed a confirmed user or complete sign-up to sign in.</p>',
              "AWS",
            ),
          );
        }
        const user = getUser(store, pool.pool_id, params.get("username") ?? "");
        checkUser(user);
        const code = cs().codes.insert({
          token: randomBytes(32).toString("base64url"),
          pool_id: pool.pool_id,
          client_id: client.client_id,
          username: user.username,
          redirect_uri: redirect,
          scope: scopes.join(" "),
          nonce: params.get("nonce") ?? undefined,
          code_challenge: challenge ?? undefined,
          expires_at: Date.now() + 5 * 60_000,
        });
        const location = new URL(redirect);
        location.searchParams.set("code", code.token);
        if (params.has("state")) location.searchParams.set("state", params.get("state")!);
        return c.redirect(location.toString());
      } catch (error) {
        if (!(error instanceof CognitoError)) throw error;
        return oauthError(c, "invalid_request", error.message);
      }
    });

  app.post(`${root}/oauth2/token`, async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    try {
      const pool = getPool(store, c.req.param("poolId"));
      const params = new URLSearchParams(await c.req.text());
      let clientId = params.get("client_id") ?? "";
      let secret = params.get("client_secret") ?? "";
      const authorization = c.req.header("Authorization");
      if (authorization?.startsWith("Basic ")) {
        const credentials = Buffer.from(authorization.slice(6), "base64").toString();
        const separator = credentials.indexOf(":");
        if (separator < 0) return oauthError(c, "invalid_client", "Invalid client credentials.", 401);
        const basicId = decodeURIComponent(credentials.slice(0, separator));
        if (clientId && clientId !== basicId)
          return oauthError(c, "invalid_client", "Conflicting client credentials.", 401);
        clientId = basicId;
        secret = decodeURIComponent(credentials.slice(separator + 1));
      }
      const client = getClient(store, clientId);
      if (
        client.pool_id !== pool.pool_id ||
        (client.client_secret && !constantTimeSecretEqual(secret, client.client_secret))
      ) {
        return oauthError(c, "invalid_client", "Invalid client credentials.", 401);
      }
      let tokens: Awaited<ReturnType<typeof issueTokens>>;
      let scope: string;
      if (params.get("grant_type") === "authorization_code") {
        const code = cs().codes.findOneBy("token", params.get("code") ?? "");
        if (
          !code ||
          code.client_id !== client.client_id ||
          code.pool_id !== pool.pool_id ||
          code.redirect_uri !== params.get("redirect_uri") ||
          code.expires_at <= Date.now()
        ) {
          return oauthError(c, "invalid_grant", "Invalid or expired authorization code.");
        }
        if (code.code_challenge) {
          const verifier = params.get("code_verifier") ?? "";
          const challenge = createHash("sha256").update(verifier).digest("base64url");
          if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !constantTimeSecretEqual(challenge, code.code_challenge)) {
            return oauthError(c, "invalid_grant", "Invalid PKCE verifier.");
          }
        }
        const user = getUser(store, pool.pool_id, code.username);
        checkUser(user);
        cs().codes.delete(code.id);
        scope = code.scope;
        tokens = await issueTokens(store, baseUrl, client, user, { scope, nonce: code.nonce });
      } else if (params.get("grant_type") === "refresh_token") {
        const session = refreshSession(store, client, params.get("refresh_token") ?? "");
        scope = session.scope;
        tokens = await issueTokens(store, baseUrl, client, getUser(store, pool.pool_id, session.username), { session });
      } else return oauthError(c, "unsupported_grant_type", "Only authorization_code and refresh_token are simulated.");
      return c.json({
        access_token: tokens.AccessToken,
        ...(scope.split(" ").includes("openid") ? { id_token: tokens.IdToken } : {}),
        ...(tokens.RefreshToken ? { refresh_token: tokens.RefreshToken } : {}),
        token_type: tokens.TokenType,
        expires_in: tokens.ExpiresIn,
        scope,
      });
    } catch (error) {
      if (error instanceof URIError) return oauthError(c, "invalid_client", "Invalid client credentials.", 401);
      if (!(error instanceof CognitoError)) throw error;
      return oauthError(
        c,
        error.code === "ResourceNotFoundException" ? "invalid_client" : "invalid_grant",
        error.message,
      );
    }
  });

  app.get(`${root}/oauth2/userInfo`, async (c) => {
    try {
      const pool = getPool(store, c.req.param("poolId"));
      const token = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
      const { user, session } = await verifyToken(store, baseUrl, token, "access", pool.pool_id);
      const scopes = session.scope.split(" ");
      if (!scopes.includes("openid")) return oauthError(c, "invalid_token", "Token requires openid scope.", 401);
      return c.json({
        sub: user.sub,
        username: user.username,
        ...(scopes.includes("email") && user.attributes.email
          ? { email: user.attributes.email, email_verified: user.attributes.email_verified === "true" }
          : {}),
        ...(scopes.includes("profile") && user.attributes.name ? { name: user.attributes.name } : {}),
      });
    } catch (error) {
      if (!(error instanceof CognitoError)) throw error;
      return oauthError(c, "invalid_token", error.message, 401);
    }
  });
}
