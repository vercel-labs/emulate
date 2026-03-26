import { createHash, randomBytes } from "crypto";
import type { RouteContext } from "@emulators/core";
import {
  escapeHtml,
  escapeAttr,
  renderCardPage,
  renderErrorPage,
  renderUserButton,
  matchesRedirectUri,
  constantTimeSecretEqual,
  bodyStr,
  debug,
} from "@emulators/core";
import { getVercelStore } from "../store.js";
import { formatUser } from "../helpers.js";
import type { VercelUser } from "../entities.js";

type PendingCode = {
  username: string;
  scope: string;
  redirectUri: string;
  clientId: string;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  created_at: number;
};

const PENDING_CODE_TTL_MS = 10 * 60 * 1000;

function getPendingCodes(store: Store): Map<string, PendingCode> {
  let map = store.getData<Map<string, PendingCode>>("vercel.oauth.pendingCodes");
  if (!map) {
    map = new Map();
    store.setData("vercel.oauth.pendingCodes", map);
  }
  return map;
}

function isPendingCodeExpired(p: PendingCode): boolean {
  return Date.now() - p.created_at > PENDING_CODE_TTL_MS;
}

const SERVICE_LABEL = "Vercel";

export function oauthRoutes({ app, store, tokenMap }: RouteContext): void {
  const vs = getVercelStore(store);

  // ---------- OAuth authorize page ----------

  app.get("/oauth/authorize", (c) => {
    const client_id = c.req.query("client_id") ?? "";
    const redirect_uri = c.req.query("redirect_uri") ?? "";
    const scope = c.req.query("scope") ?? "";
    const state = c.req.query("state") ?? "";
    const code_challenge = c.req.query("code_challenge") ?? "";
    const code_challenge_method = c.req.query("code_challenge_method") ?? "";

    const integrationsConfigured = vs.integrations.all().length > 0;
    let integrationName = "";
    if (integrationsConfigured) {
      const integration = vs.integrations.findOneBy("client_id", client_id);
      if (!integration) {
        return c.html(renderErrorPage("Application not found", `The client_id '${client_id}' is not registered.`, SERVICE_LABEL), 400);
      }
      if (redirect_uri && !matchesRedirectUri(redirect_uri, integration.redirect_uris)) {
        console.warn(`[OAuth] redirect_uri mismatch: got "${redirect_uri}", registered: ${JSON.stringify(integration.redirect_uris)}`);
        return c.html(renderErrorPage("Redirect URI mismatch", "The redirect_uri is not registered for this application.", SERVICE_LABEL), 400);
      }
      integrationName = integration.name;
    }

    const subtitleText = integrationName
      ? `Authorize <strong>${escapeHtml(integrationName)}</strong> to access your account.`
      : "Choose a seeded user to continue.";

    const users = vs.users.all();
    const userButtons = users
      .map((user) => {
        const u = formatUser(user);
        return renderUserButton({
          letter: (u.username[0] ?? "?").toUpperCase(),
          login: u.username,
          name: u.name ?? undefined,
          email: u.email,
          formAction: "/oauth/authorize/callback",
          hiddenFields: {
            username: u.username,
            redirect_uri,
            scope,
            state,
            client_id,
            code_challenge,
            code_challenge_method,
          },
        });
      })
      .join("\n");

    const body = users.length === 0
      ? '<p class="empty">No users in the emulator store.</p>'
      : userButtons;

    return c.html(renderCardPage("Sign in to Vercel", subtitleText, body, SERVICE_LABEL));
  });

  // ---------- OAuth callback ----------

  app.post("/oauth/authorize/callback", async (c) => {
    const body = await c.req.parseBody();
    const username = bodyStr(body.username);
    const redirect_uri = bodyStr(body.redirect_uri);
    const scope = bodyStr(body.scope);
    const state = bodyStr(body.state);
    const client_id = bodyStr(body.client_id);

    const code = randomBytes(20).toString("hex");
    const code_challenge = bodyStr(body.code_challenge);
    const code_challenge_method = bodyStr(body.code_challenge_method);

    const pendingCodes = getPendingCodes(store);
    pendingCodes.set(code, {
      username,
      scope,
      redirectUri: redirect_uri,
      clientId: client_id,
      codeChallenge: code_challenge || null,
      codeChallengeMethod: code_challenge_method || null,
      created_at: Date.now(),
    });

    debug("vercel.oauth", `[Vercel callback] generated code: ${code.slice(0, 8)}... for username=${username}, challenge=${code_challenge ? "present" : "none"}, pendingCodes size: ${pendingCodes.size}`);

    const url = new URL(redirect_uri);
    url.searchParams.set("code", code);
    if (state !== "") url.searchParams.set("state", state);

    debug("vercel.oauth", `[Vercel callback] redirecting to: ${url.toString().slice(0, 120)}...`);
    return c.redirect(url.toString(), 302);
  });

  // ---------- Token exchange ----------

  app.post("/login/oauth/token", async (c) => {
    const contentType = c.req.header("Content-Type") ?? "";
    const pendingCodes = getPendingCodes(store);
    debug("vercel.oauth", `[Vercel token] Content-Type: ${contentType}`);
    debug("vercel.oauth", `[Vercel token] pendingCodes size: ${pendingCodes.size}`);
    debug("vercel.oauth", `[Vercel token] pendingCodes keys: ${[...pendingCodes.keys()].map(k => k.slice(0, 8) + "...").join(", ")}`);

    const rawText = await c.req.text();
    debug("vercel.oauth", `[Vercel token] raw body: ${rawText.slice(0, 500)}`);

    let body: Record<string, unknown>;
    if (contentType.includes("application/json")) {
      try { body = JSON.parse(rawText); } catch { body = {}; }
    } else {
      body = Object.fromEntries(new URLSearchParams(rawText));
    }

    debug("vercel.oauth", `[Vercel token] parsed keys: ${Object.keys(body).join(", ")}`);

    const code = typeof body.code === "string" ? body.code : "";
    const redirect_uri = typeof body.redirect_uri === "string" ? body.redirect_uri : "";
    const code_verifier = typeof body.code_verifier === "string" ? body.code_verifier : undefined;
    const bodyClientId = typeof body.client_id === "string" ? body.client_id : "";
    const bodyClientSecret = typeof body.client_secret === "string" ? body.client_secret : "";

    debug("vercel.oauth", `[Vercel token] code: ${code.slice(0, 8)}... (len=${code.length})`);
    debug("vercel.oauth", `[Vercel token] client_id: ${bodyClientId}`);
    debug("vercel.oauth", `[Vercel token] client_secret: ${bodyClientSecret.slice(0, 4)}****`);
    debug("vercel.oauth", `[Vercel token] code_verifier: ${code_verifier ? code_verifier.slice(0, 8) + "..." : "undefined"}`);

    const integrationsConfigured = vs.integrations.all().length > 0;
    if (integrationsConfigured) {
      const integration = vs.integrations.findOneBy("client_id", bodyClientId);
      if (!integration) {
        debug("vercel.oauth", `[Vercel token] REJECTED: client_id not found`);
        return c.json({ error: "invalid_client", error_description: "The client_id and/or client_secret passed are incorrect." }, 401);
      }
      if (!constantTimeSecretEqual(bodyClientSecret, integration.client_secret)) {
        debug("vercel.oauth", `[Vercel token] REJECTED: client_secret mismatch`);
        return c.json({ error: "invalid_client", error_description: "The client_id and/or client_secret passed are incorrect." }, 401);
      }
      debug("vercel.oauth", `[Vercel token] client credentials OK (${integration.name})`);
    }

    const pending = pendingCodes.get(code);
    if (!pending) {
      debug("vercel.oauth", `[Vercel token] REJECTED: code not found in pendingCodes`);
      return c.json(
        { error: "invalid_grant", error_description: "The code passed is incorrect or expired." },
        400
      );
    }
    if (isPendingCodeExpired(pending)) {
      debug("vercel.oauth", `[Vercel token] REJECTED: code expired`);
      pendingCodes.delete(code);
      return c.json(
        { error: "invalid_grant", error_description: "The code passed is incorrect or expired." },
        400
      );
    }
    debug("vercel.oauth", `[Vercel token] code valid, username=${pending.username}, scope=${pending.scope}`);

    if (redirect_uri && pending.redirectUri && redirect_uri !== pending.redirectUri) {
      debug("vercel.oauth", `[Vercel token] REJECTED: redirect_uri mismatch (got "${redirect_uri}", expected "${pending.redirectUri}")`);
      pendingCodes.delete(code);
      return c.json(
        { error: "invalid_grant", error_description: "The redirect_uri does not match the one used during authorization." },
        400
      );
    }

    if (pending.codeChallenge != null) {
      if (code_verifier === undefined) {
        return c.json(
          { error: "invalid_grant", error_description: "PKCE verification failed." },
          400
        );
      }
      const method = (pending.codeChallengeMethod ?? "plain").toLowerCase();
      if (method === "s256") {
        const expected = createHash("sha256").update(code_verifier).digest("base64url");
        if (expected !== pending.codeChallenge) {
          return c.json(
            { error: "invalid_grant", error_description: "PKCE verification failed." },
            400
          );
        }
      } else if (method === "plain") {
        if (code_verifier !== pending.codeChallenge) {
          return c.json(
            { error: "invalid_grant", error_description: "PKCE verification failed." },
            400
          );
        }
      } else {
        return c.json(
          { error: "invalid_grant", error_description: "PKCE verification failed." },
          400
        );
      }
    }

    debug("vercel.oauth", `[Vercel token] PKCE OK (challenge=${pending.codeChallenge ? "present" : "none"})`);
    pendingCodes.delete(code);

    const user = vs.users.findOneBy("username", pending.username as VercelUser["username"]);
    if (!user) {
      debug("vercel.oauth", `[Vercel token] REJECTED: user "${pending.username}" not found`);
      return c.json(
        { error: "invalid_grant", error_description: "The user associated with this code was not found." },
        400
      );
    }

    const token = "vercel_" + randomBytes(20).toString("base64url");
    const scopes = pending.scope ? pending.scope.split(/[,\s]+/).filter(Boolean) : [];

    if (tokenMap) {
      tokenMap.set(token, { login: user.username, id: user.id, scopes });
    }

    debug("vercel.oauth", `[Vercel token] SUCCESS: issued token for ${user.username} (scopes: ${scopes.join(",") || "none"})`);

    return c.json({
      access_token: token,
      token_type: "Bearer",
      scope: pending.scope || "",
    });
  });

  // ---------- User info ----------

  app.get("/login/oauth/userinfo", (c) => {
    const authUser = c.get("authUser");
    if (!authUser) {
      return c.json({ error: { code: "unauthorized", message: "Authentication required" } }, 401);
    }

    const user = vs.users.findOneBy("username", authUser.login as VercelUser["username"]);
    if (!user) {
      return c.json({ error: { code: "unauthorized", message: "Authentication required" } }, 401);
    }

    return c.json({
      sub: user.uid,
      email: user.email,
      name: user.name,
      preferred_username: user.username,
      email_verified: true,
      picture: user.avatar,
    });
  });
}
