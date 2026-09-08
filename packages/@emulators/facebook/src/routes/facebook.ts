import { randomBytes } from "node:crypto";
import type { Context, RouteContext, Store } from "@emulators/core";
import {
  bodyStr,
  constantTimeSecretEqual,
  escapeHtml,
  matchesRedirectUri,
  renderCardPage,
  renderErrorPage,
  renderUserButton,
} from "@emulators/core";
import { getFacebookStore } from "../store.js";

type Code = { userId: string; appId: string; redirectUri: string; scopes: string[]; createdAt: number };
type Token = { kind: "user" | "page"; subjectId: string; appId: string; scopes: string[]; issuedAt: number };
type AuthorizationTransaction = {
  appId: string;
  redirectUri: string;
  state: string;
  scopes: string[];
  createdAt: number;
};

const DEFAULT_SCOPES = ["public_profile", "pages_show_list", "pages_read_engagement"];
const GRANTABLE_SCOPES = [...DEFAULT_SCOPES, "email"];
const SERVICE_LABEL = "Facebook";
const AUTHORIZATION_TRANSACTION_TTL_MS = 5 * 60_000;

function authorizationTransactions(store: Store): Map<string, AuthorizationTransaction> {
  let value = store.getData<Map<string, AuthorizationTransaction>>("facebook.oauth.authorization_transactions");
  if (!value) {
    value = new Map();
    store.setData("facebook.oauth.authorization_transactions", value);
  }
  return value;
}

function codes(store: Store): Map<string, Code> {
  let value = store.getData<Map<string, Code>>("facebook.oauth.codes");
  if (!value) {
    value = new Map();
    store.setData("facebook.oauth.codes", value);
  }
  return value;
}

function tokens(store: Store): Map<string, Token> {
  let value = store.getData<Map<string, Token>>("facebook.oauth.tokens");
  if (!value) {
    value = new Map();
    store.setData("facebook.oauth.tokens", value);
  }
  return value;
}

function graphError(
  c: Context,
  message: string,
  type: string,
  code: number,
  status: 400 | 401 | 403 | 404 = 400,
  subcode?: number,
) {
  return c.json(
    {
      error: {
        message,
        type,
        code,
        ...(subcode === undefined ? {} : { error_subcode: subcode }),
        fbtrace_id: "EMULATE_FACEBOOK",
      },
    },
    status,
  );
}

async function requestParams(c: Context): Promise<Record<string, string>> {
  const query = Object.fromEntries(new URL(c.req.url).searchParams);
  if (c.req.method === "GET") return query;
  const body = await c.req.parseBody();
  return { ...query, ...Object.fromEntries(Object.entries(body).map(([key, value]) => [key, bodyStr(value)])) };
}

function accessToken(c: Context): string {
  return c.req.query("access_token") ?? (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
}

function requireToken(c: Context, resolveToken: (value: string) => Token | undefined): Token | Response {
  const token = resolveToken(accessToken(c));
  return (
    token ??
    graphError(
      c,
      "An active access token must be used to query information about the current user.",
      "OAuthException",
      190,
      401,
    )
  );
}

function fieldName(raw: string): string {
  return raw.split(".")[0]?.split("{")[0] ?? raw;
}

function requestedFields(c: Context, defaults: string[], supported: string[]): string[] | Response {
  const requested = (c.req.query("fields") ?? defaults.join(","))
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);
  const unsupported = requested.find((field) => !supported.includes(fieldName(field)));
  if (unsupported) {
    return graphError(
      c,
      "Tried accessing nonexisting field (" + fieldName(unsupported) + ") on node type (FacebookObject)",
      "GraphMethodException",
      100,
    );
  }
  return requested;
}

function pick(source: Record<string, unknown>, requested: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const raw of requested) {
    const field = raw.split(".")[0]?.split("{")[0] ?? raw;
    if (field in source) result[field] = source[field];
  }
  return result;
}

export function facebookRoutes({ app, store, tokenMap }: RouteContext): void {
  const fs = () => getFacebookStore(store);
  const resolveToken = (value: string): Token | undefined => {
    const privateToken = tokens(store).get(value);
    if (privateToken) return privateToken;
    const sharedToken = tokenMap?.get(value);
    if (!sharedToken) return undefined;
    const users = fs().users.all();
    const user = users.find(
      (candidate) =>
        candidate.user_id === sharedToken.login ||
        candidate.name === sharedToken.login ||
        candidate.email === sharedToken.login,
    );
    if (!user) return undefined;
    return {
      kind: "user",
      subjectId: user.user_id,
      appId: fs().oauthApps.all()[0]?.app_id ?? "",
      scopes: sharedToken.scopes,
      issuedAt: Date.now(),
    };
  };
  const shareToken = (value: string, token: Token): void => {
    if (!tokenMap) return;
    if (token.kind === "user") {
      const users = fs().users.all();
      const user = users.find((candidate) => candidate.user_id === token.subjectId);
      tokenMap.set(value, {
        login: user?.email ?? user?.name ?? token.subjectId,
        id: Math.max(1, user ? users.indexOf(user) + 1 : 1),
        scopes: token.scopes,
      });
      return;
    }
    const pages = fs().pages.all();
    const page = pages.find((candidate) => candidate.page_id === token.subjectId);
    tokenMap.set(value, {
      login: page?.name ?? token.subjectId,
      id: Math.max(1, page ? pages.indexOf(page) + 1 : 1),
      scopes: token.scopes,
    });
  };

  const authorize = (c: Context) => {
    const appId = c.req.query("client_id") ?? "";
    const redirectUri = c.req.query("redirect_uri") ?? "";
    const oauthApp = fs().oauthApps.findOneBy("app_id", appId);
    if (!oauthApp) {
      return c.html(renderErrorPage("Application not found", "The app ID is not registered.", SERVICE_LABEL), 400);
    }
    if (!matchesRedirectUri(redirectUri, oauthApp.redirect_uris)) {
      return c.html(
        renderErrorPage(
          "Redirect URI mismatch",
          "The redirect URI is not registered for this application.",
          SERVICE_LABEL,
        ),
        400,
      );
    }
    if ((c.req.query("response_type") ?? "code") !== "code") {
      return c.html(
        renderErrorPage("Unsupported response type", "Only the authorization code flow is supported.", SERVICE_LABEL),
        400,
      );
    }
    const requestedScopes = (c.req.query("scope") ?? DEFAULT_SCOPES.join(",")).split(/[ ,]+/).filter(Boolean);
    const transactionId = randomBytes(32).toString("base64url");
    authorizationTransactions(store).set(transactionId, {
      appId,
      redirectUri,
      state: c.req.query("state") ?? "",
      scopes: requestedScopes.filter((scope) => GRANTABLE_SCOPES.includes(scope)),
      createdAt: Date.now(),
    });
    const users = fs().users.all();
    const body = users.length
      ? users
          .map((user) =>
            renderUserButton({
              letter: (user.name[0] ?? "?").toUpperCase(),
              login: user.name,
              name: user.email,
              formAction: "/dialog/oauth/callback",
              hiddenFields: { transaction_id: transactionId, user_id: user.user_id },
            }),
          )
          .join("\n")
      : '<p class="empty">No users in the emulator store.</p>';
    return c.html(
      renderCardPage(
        "Log in with Facebook",
        "Continue to <strong>" + escapeHtml(oauthApp.name) + "</strong>.",
        body,
        SERVICE_LABEL,
      ),
    );
  };

  app.get("/dialog/oauth", authorize);

  app.post("/dialog/oauth/callback", async (c) => {
    const p = await requestParams(c);
    const transaction = authorizationTransactions(store).get(p.transaction_id ?? "");
    authorizationTransactions(store).delete(p.transaction_id ?? "");
    const user = fs().users.findOneBy("user_id", p.user_id ?? "");
    if (!transaction || Date.now() - transaction.createdAt > AUTHORIZATION_TRANSACTION_TTL_MS || !user) {
      return c.html(
        renderErrorPage(
          "Invalid authorization request",
          "The authorization transaction or selected user is invalid.",
          SERVICE_LABEL,
        ),
        400,
      );
    }
    const code = "AQ" + randomBytes(24).toString("base64url");
    codes(store).set(code, {
      userId: user.user_id,
      appId: transaction.appId,
      redirectUri: transaction.redirectUri,
      scopes: transaction.scopes,
      createdAt: Date.now(),
    });
    const target = new URL(transaction.redirectUri);
    target.searchParams.set("code", code);
    if (transaction.state) target.searchParams.set("state", transaction.state);
    return c.redirect(target.toString(), 302);
  });

  const exchange = async (c: Context) => {
    const p = await requestParams(c);
    const oauthApp = fs().oauthApps.findOneBy("app_id", p.client_id ?? "");
    if (!oauthApp || !constantTimeSecretEqual(p.client_secret ?? "", oauthApp.app_secret)) {
      return graphError(c, "Error validating client secret.", "OAuthException", 101);
    }
    const grantType = p.grant_type ?? "authorization_code";
    if (grantType === "fb_exchange_token") {
      const existing = tokens(store).get(p.fb_exchange_token ?? "");
      if (!existing || existing.appId !== oauthApp.app_id) {
        return graphError(c, "Error validating access token.", "OAuthException", 190, 401);
      }
      const token = "EAA" + randomBytes(32).toString("base64url");
      const longLivedToken: Token = {
        kind: existing.kind,
        subjectId: existing.subjectId,
        appId: existing.appId,
        scopes: existing.scopes,
        issuedAt: Date.now(),
      };
      tokens(store).set(token, longLivedToken);
      shareToken(token, longLivedToken);
      return c.json({ access_token: token, token_type: "bearer", expires_in: 5184000 });
    }
    if (grantType !== "authorization_code") {
      return graphError(c, "Unsupported grant_type: " + grantType + ".", "OAuthException", 100);
    }
    const pending = codes(store).get(p.code ?? "");
    if (
      !pending ||
      pending.appId !== oauthApp.app_id ||
      pending.redirectUri !== (p.redirect_uri ?? "") ||
      Date.now() - pending.createdAt > 600_000
    ) {
      return graphError(c, "This authorization code has been used or is invalid.", "OAuthException", 100);
    }
    codes(store).delete(p.code ?? "");
    const token = "EAA" + randomBytes(32).toString("base64url");
    const userToken: Token = {
      kind: "user",
      subjectId: pending.userId,
      appId: pending.appId,
      scopes: pending.scopes,
      issuedAt: Date.now(),
    };
    tokens(store).set(token, userToken);
    shareToken(token, userToken);
    return c.json({ access_token: token, token_type: "bearer", expires_in: 5184000 });
  };
  app.get("/oauth/access_token", exchange);
  app.post("/oauth/access_token", exchange);

  const debugToken = async (c: Context) => {
    const p = await requestParams(c);
    const [appId, appSecret] = (p.access_token ?? "").split("|");
    const oauthApp = fs().oauthApps.findOneBy("app_id", appId ?? "");
    if (!oauthApp || !constantTimeSecretEqual(appSecret ?? "", oauthApp.app_secret)) {
      return graphError(c, "Invalid app access token.", "OAuthException", 190, 401);
    }
    const token = resolveToken(p.input_token ?? "");
    const validToken = token?.appId === oauthApp.app_id ? token : undefined;
    return c.json({
      data: validToken
        ? {
            app_id: validToken.appId,
            type: validToken.kind === "user" ? "USER" : "PAGE",
            application: oauthApp.name,
            is_valid: true,
            issued_at: Math.floor(validToken.issuedAt / 1000),
            scopes: validToken.scopes,
            user_id: validToken.subjectId,
          }
        : { is_valid: false },
    });
  };
  app.get("/debug_token", debugToken);

  const me = (c: Context) => {
    const auth = requireToken(c, resolveToken);
    if (auth instanceof Response) return auth;
    if (auth.kind === "user") {
      const user = fs().users.findOneBy("user_id", auth.subjectId);
      if (!user)
        return graphError(c, "Unsupported get request. Object does not exist.", "GraphMethodException", 100, 404);
      const fields = requestedFields(c, ["id", "name"], ["id", "name", "email"]);
      if (fields instanceof Response) return fields;
      const source: Record<string, unknown> = { id: user.user_id, name: user.name };
      if (auth.scopes.includes("email")) source.email = user.email;
      return c.json(pick(source, fields));
    }
    const page = fs().pages.findOneBy("page_id", auth.subjectId);
    if (!page)
      return graphError(c, "Unsupported get request. Object does not exist.", "GraphMethodException", 100, 404);
    const fields = requestedFields(c, ["id", "name"], ["id", "name", "category"]);
    if (fields instanceof Response) return fields;
    return c.json(pick({ id: page.page_id, name: page.name, category: page.category }, fields));
  };
  app.get("/me", me);

  const accounts = (c: Context) => {
    const auth = requireToken(c, resolveToken);
    if (auth instanceof Response) return auth;
    if (auth.kind !== "user" || !auth.scopes.includes("pages_show_list")) {
      return graphError(c, "Permissions error", "OAuthException", 200, 403);
    }
    const data = fs()
      .pages.all()
      .filter((page) => page.owner_user_ids.includes(auth.subjectId))
      .map((page) => {
        const token = "EAA" + randomBytes(32).toString("base64url");
        const pageToken: Token = {
          kind: "page",
          subjectId: page.page_id,
          appId: auth.appId,
          scopes: auth.scopes,
          issuedAt: Date.now(),
        };
        tokens(store).set(token, pageToken);
        shareToken(token, pageToken);
        return {
          id: page.page_id,
          name: page.name,
          category: page.category,
          access_token: token,
          tasks: ["ANALYZE", "CREATE_CONTENT", "MODERATE"],
        };
      });
    return c.json({ data, paging: { cursors: { before: "", after: "" } } });
  };
  app.get("/me/accounts", accounts);

  const object = (c: Context, explicitObjectId?: string) => {
    const auth = requireToken(c, resolveToken);
    if (auth instanceof Response) return auth;
    const objectId = explicitObjectId ?? c.req.param("objectId") ?? "";
    const page = fs().pages.findOneBy("page_id", objectId);
    if (page) {
      const allowed =
        auth.kind === "page" ? auth.subjectId === page.page_id : page.owner_user_ids.includes(auth.subjectId);
      if (!allowed || !auth.scopes.includes("pages_read_engagement")) {
        return graphError(c, "Permissions error", "OAuthException", 200, 403);
      }
      const fields = requestedFields(c, ["id", "name"], ["id", "name", "category"]);
      if (fields instanceof Response) return fields;
      return c.json(pick({ id: page.page_id, name: page.name, category: page.category }, fields));
    }
    const video = fs().videos.findOneBy("video_id", objectId);
    if (video) {
      const videoPage = fs().pages.findOneBy("page_id", video.page_id);
      const allowed =
        auth.kind === "page" ? auth.subjectId === video.page_id : videoPage?.owner_user_ids.includes(auth.subjectId);
      if (!allowed || !auth.scopes.includes("pages_read_engagement")) {
        return graphError(c, "Permissions error", "OAuthException", 200, 403);
      }
      const fields = requestedFields(
        c,
        ["id", "title", "views", "likes", "comments"],
        ["id", "title", "description", "permalink_url", "created_time", "views", "likes", "comments"],
      );
      if (fields instanceof Response) return fields;
      return c.json(
        pick(
          {
            id: video.video_id,
            title: video.title,
            description: video.description,
            permalink_url: video.permalink_url,
            created_time: video.created_time,
            views: video.views,
            likes: { summary: { total_count: video.likes } },
            comments: { summary: { total_count: video.comments } },
          },
          fields,
        ),
      );
    }
    return graphError(
      c,
      "Unsupported get request. Object does not exist, cannot be loaded due to missing permissions, or does not support this operation.",
      "GraphMethodException",
      100,
      404,
      33,
    );
  };
  app.get("/:objectId", (c) => object(c));
  app.get("/:version{v\\d+\\.\\d+}/dialog/oauth", authorize);
  app.get("/:version{v\\d+\\.\\d+}/oauth/access_token", exchange);
  app.post("/:version{v\\d+\\.\\d+}/oauth/access_token", exchange);
  app.get("/:version{v\\d+\\.\\d+}/debug_token", debugToken);
  app.get("/:version{v\\d+\\.\\d+}/me", me);
  app.get("/:version{v\\d+\\.\\d+}/me/accounts", accounts);
  app.get("/:version{v\\d+\\.\\d+}/:objectId", (c) => object(c));
}
