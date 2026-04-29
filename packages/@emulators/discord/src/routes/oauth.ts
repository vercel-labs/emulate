import type { Context } from "hono";
import { randomBytes } from "crypto";
import type { Store, RouteContext } from "@emulators/core";
import {
  bodyStr,
  constantTimeSecretEqual,
  escapeHtml,
  matchesRedirectUri,
  renderCardPage,
  renderErrorPage,
  renderUserButton,
} from "@emulators/core";
import { getDiscordStore } from "../store.js";
import { formatUser, installDiscordToken } from "../helpers.js";

interface PendingCode {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  userId: string;
  created_at: number;
}

const PENDING_CODE_TTL_MS = 10 * 60 * 1000;
const SERVICE_LABEL = "Discord";

function pendingCodes(store: Store): Map<string, PendingCode> {
  let map = store.getData<Map<string, PendingCode>>("discord.oauth.pendingCodes");
  if (!map) {
    map = new Map();
    store.setData("discord.oauth.pendingCodes", map);
  }
  return map;
}

function isExpired(code: PendingCode): boolean {
  return Date.now() - code.created_at > PENDING_CODE_TTL_MS;
}

function parseBasicAuth(header: string | undefined): { clientId: string; clientSecret: string } | null {
  if (!header?.startsWith("Basic ")) return null;
  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  const index = decoded.indexOf(":");
  if (index < 0) return null;
  return { clientId: decoded.slice(0, index), clientSecret: decoded.slice(index + 1) };
}

export function oauthRoutes(ctx: RouteContext): void {
  const { app, store, tokenMap } = ctx;
  const ds = () => getDiscordStore(store);

  app.get("/oauth2/authorize", (c) => {
    const clientId = c.req.query("client_id") ?? "";
    const redirectUri = c.req.query("redirect_uri") ?? "";
    const scope = c.req.query("scope") ?? "";
    const state = c.req.query("state") ?? "";

    const appsConfigured = ds().applications.all().length > 0;
    let appName = "Discord Application";
    if (appsConfigured) {
      const application = ds().applications.findOneBy("client_id", clientId);
      if (!application) {
        return c.html(
          renderErrorPage("Application not found", `The client_id '${clientId}' is not registered.`, SERVICE_LABEL),
          400,
        );
      }
      if (redirectUri && !matchesRedirectUri(redirectUri, application.redirect_uris)) {
        return c.html(
          renderErrorPage(
            "Redirect URI mismatch",
            "The redirect_uri is not registered for this application.",
            SERVICE_LABEL,
          ),
          400,
        );
      }
      appName = application.name;
    }

    const users = ds()
      .users.all()
      .filter((u) => !u.bot);
    const buttons = users
      .map((user) =>
        renderUserButton({
          letter: (user.username[0] ?? "?").toUpperCase(),
          login: user.username,
          name: user.global_name ?? user.username,
          email: user.email ?? "",
          formAction: "/oauth2/authorize/callback",
          hiddenFields: {
            user_id: user.user_id,
            client_id: clientId,
            redirect_uri: redirectUri,
            scope,
            state,
          },
        }),
      )
      .join("\n");

    const body = users.length === 0 ? '<p class="empty">No users in the emulator store.</p>' : buttons;
    const subtitle = `Authorize <strong>${escapeHtml(appName)}</strong> to access your Discord account.`;

    return c.html(renderCardPage("Sign in to Discord", subtitle, body, SERVICE_LABEL));
  });

  app.post("/oauth2/authorize/callback", async (c) => {
    const body = await c.req.parseBody();
    const userId = bodyStr(body.user_id);
    const clientId = bodyStr(body.client_id);
    const redirectUri = bodyStr(body.redirect_uri);
    const scope = bodyStr(body.scope);
    const state = bodyStr(body.state);

    const code = randomBytes(20).toString("hex");
    pendingCodes(store).set(code, {
      clientId,
      redirectUri,
      scope,
      state,
      userId,
      created_at: Date.now(),
    });

    const url = new URL(redirectUri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    return c.redirect(url.toString(), 302);
  });

  const tokenHandler = async (c: Context) => {
    const contentType = c.req.header("Content-Type") ?? "";
    const raw = await c.req.text();
    let body: Record<string, unknown>;
    if (contentType.includes("application/json")) {
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        body = {};
      }
    } else {
      body = Object.fromEntries(new URLSearchParams(raw));
    }

    const basic = parseBasicAuth(c.req.header("Authorization"));
    const clientId = basic?.clientId ?? (typeof body.client_id === "string" ? body.client_id : "");
    const clientSecret = basic?.clientSecret ?? (typeof body.client_secret === "string" ? body.client_secret : "");
    const code = typeof body.code === "string" ? body.code : "";
    const grantType = typeof body.grant_type === "string" ? body.grant_type : "authorization_code";

    if (grantType !== "authorization_code") {
      return c.json({ error: "unsupported_grant_type" }, 400);
    }

    const appsConfigured = ds().applications.all().length > 0;
    const application = ds().applications.findOneBy("client_id", clientId);
    if (appsConfigured) {
      if (!application || !constantTimeSecretEqual(clientSecret, application.client_secret)) {
        return c.json({ error: "invalid_client" }, 401);
      }
    }

    const pending = pendingCodes(store).get(code);
    if (!pending || isExpired(pending) || pending.clientId !== clientId) {
      if (pending) pendingCodes(store).delete(code);
      return c.json({ error: "invalid_grant" }, 400);
    }

    pendingCodes(store).delete(code);

    const user = ds().users.findOneBy("user_id", pending.userId);
    if (!user) return c.json({ error: "invalid_grant" }, 400);

    const accessToken = "discord_" + randomBytes(20).toString("base64url");
    installDiscordToken(tokenMap, accessToken, user.user_id, user.id);

    return c.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 604800,
      refresh_token: "discord_refresh_" + randomBytes(20).toString("base64url"),
      scope: pending.scope || "identify guilds",
      user: formatUser(user),
    });
  };

  app.post("/oauth2/token", tokenHandler);
  app.post("/api/oauth2/token", tokenHandler);
  app.post("/api/v10/oauth2/token", tokenHandler);
}
