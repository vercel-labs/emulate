import { createHash, randomBytes } from "node:crypto";
import type { Context } from "hono";
import type { AppEnv, RouteContext, Store } from "@emulators/core";
import { bodyStr, matchesRedirectUri, renderFormPostPage } from "@emulators/core";
import { endpointUrl, getTenant, tenantBaseUrl, tenantFromRequest } from "../helpers.js";
import type { Auth0Application } from "../entities.js";
import { auth0Error, findOrganizationByRef, findUserByRef } from "../route-helpers.js";
import { getAuth0Store } from "../store.js";
import { renderAuth0Error, renderConsent, renderLogin } from "./ui.js";

export const CODE_TTL_MS = 10 * 60 * 1000;

export interface PendingCode {
  userRef: string;
  scope: string;
  redirectUri: string;
  clientId: string;
  nonce: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  audience: string | null;
  organization: string | null;
  issuer: string;
  createdAt: number;
}

export function getPendingCodes(store: Store): Map<string, PendingCode> {
  let map = store.getData<Map<string, PendingCode>>("auth0.oauth.pendingCodes");
  if (!map) {
    map = new Map();
    store.setData("auth0.oauth.pendingCodes", map);
  }
  return map;
}

export function isCodeExpired(code: PendingCode): boolean {
  return Date.now() - code.createdAt > CODE_TTL_MS;
}

function clientsConfigured(clients: Auth0Application[]): boolean {
  return clients.length > 0;
}

function validateAuthorizeRequest(
  c: Context<AppEnv>,
  client: Auth0Application | null,
  clients: Auth0Application[],
  redirectUri: string,
  responseType: string,
  audience: string,
): Response | null {
  if (responseType !== "code") {
    return renderAuth0Error(c, "Unsupported response_type", "Only response_type=code is supported.");
  }
  if (!redirectUri) return renderAuth0Error(c, "Missing redirect URI", "The redirect_uri parameter is required.");
  if (clientsConfigured(clients) && !client) {
    return renderAuth0Error(c, "Application not found", "The client_id is not registered.");
  }
  if (client && !matchesRedirectUri(redirectUri, client.callbacks)) {
    return renderAuth0Error(c, "Redirect URI mismatch", "The redirect_uri is not registered for this application.");
  }
  if (audience) return null;
  return null;
}

function validateAudience(auth0: ReturnType<typeof getAuth0Store>, audience: string): boolean {
  if (!audience) return true;
  const configured = auth0.apis.all();
  if (configured.length === 0) return true;
  return Boolean(auth0.apis.findOneBy("audience", audience));
}

function hiddenFromQuery(c: Context<AppEnv>, issuer: string): Record<string, string> {
  return {
    client_id: c.req.query("client_id") ?? "",
    redirect_uri: c.req.query("redirect_uri") ?? "",
    response_type: c.req.query("response_type") ?? "code",
    response_mode: c.req.query("response_mode") ?? "query",
    scope: c.req.query("scope") ?? "openid profile email",
    state: c.req.query("state") ?? "",
    nonce: c.req.query("nonce") ?? "",
    code_challenge: c.req.query("code_challenge") ?? "",
    code_challenge_method: c.req.query("code_challenge_method") ?? "",
    audience: c.req.query("audience") ?? "",
    organization: c.req.query("organization") ?? "",
    tenant: c.req.query("tenant") ?? "",
    issuer,
  };
}

export function verifyPkce(pending: PendingCode, codeVerifier: string | undefined): boolean {
  if (pending.codeChallenge === null) return true;
  if (!codeVerifier) return false;
  const method = (pending.codeChallengeMethod ?? "plain").toLowerCase();
  if (method === "s256") {
    return createHash("sha256").update(codeVerifier).digest("base64url") === pending.codeChallenge;
  }
  if (method === "plain") return codeVerifier === pending.codeChallenge;
  return false;
}

export function authorizeRoutes({ app, store, baseUrl }: RouteContext): void {
  const auth0 = getAuth0Store(store);

  const renderAuthorize = (c: Context<AppEnv>): Response => {
    const tenant = tenantFromRequest(c, getTenant(store));
    const issuer = tenantBaseUrl(c, baseUrl, tenant);
    const clientId = c.req.query("client_id") ?? "";
    const redirectUri = c.req.query("redirect_uri") ?? "";
    const responseType = c.req.query("response_type") ?? "code";
    const audience = c.req.query("audience") ?? "";
    const organizationRef = c.req.query("organization") ?? "";
    const clients = auth0.applications.all();
    const client = auth0.applications.findOneBy("client_id", clientId) ?? null;

    const error = validateAuthorizeRequest(c, client, clients, redirectUri, responseType, audience);
    if (error) return error;
    if (!validateAudience(auth0, audience)) {
      return renderAuth0Error(c, "Unknown audience", "The requested audience is not configured for this tenant.");
    }

    const organization = organizationRef ? (findOrganizationByRef(auth0, organizationRef) ?? null) : null;
    if (organizationRef && !organization) {
      return renderAuth0Error(c, "Unknown organization", "The requested organization is not configured.");
    }

    const users = auth0.users.all().filter((user) => !user.blocked);
    return renderLogin(c, {
      users,
      application: client,
      organization,
      hiddenFields: hiddenFromQuery(c, issuer),
    });
  };

  const handleCallback = async (c: Context<AppEnv>): Promise<Response> => {
    const body = await c.req.parseBody();
    const userRef = bodyStr(body.user_ref);
    const redirectUri = bodyStr(body.redirect_uri);
    const clientId = bodyStr(body.client_id);
    const responseMode = bodyStr(body.response_mode) || "query";
    const state = bodyStr(body.state);
    const audience = bodyStr(body.audience);
    const organization = bodyStr(body.organization);
    const issuer = bodyStr(body.issuer) || endpointUrl(c, baseUrl, getTenant(store), "");

    if (!redirectUri) return renderAuth0Error(c, "Missing redirect URI", "The redirect_uri parameter is required.");
    const user = findUserByRef(auth0, userRef);
    if (!user) return renderAuth0Error(c, "Unknown user", "The selected user is not available.");

    const client = auth0.applications.findOneBy("client_id", clientId);
    if (auth0.applications.all().length > 0 && !client) {
      return renderAuth0Error(c, "Application not found", "The client_id is not registered.");
    }
    if (client && !matchesRedirectUri(redirectUri, client.callbacks)) {
      return renderAuth0Error(c, "Redirect URI mismatch", "The redirect_uri is not registered for this application.");
    }
    if (!validateAudience(auth0, audience)) {
      return renderAuth0Error(c, "Unknown audience", "The requested audience is not configured for this tenant.");
    }

    const code = randomBytes(20).toString("hex");
    getPendingCodes(store).set(code, {
      userRef: user.auth0_id,
      scope: bodyStr(body.scope) || "openid profile email",
      redirectUri,
      clientId,
      nonce: bodyStr(body.nonce) || null,
      codeChallenge: bodyStr(body.code_challenge) || null,
      codeChallengeMethod: bodyStr(body.code_challenge_method) || null,
      audience: audience || null,
      organization: organization || null,
      issuer,
      createdAt: Date.now(),
    });

    auth0.users.update(user.id, { last_login: new Date().toISOString(), logins_count: user.logins_count + 1 });

    if (responseMode === "form_post") {
      return c.html(renderFormPostPage(redirectUri, { code, state }, "Auth0"));
    }

    const url = new URL(redirectUri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    return c.redirect(url.toString(), 302);
  };

  app.get("/authorize", renderAuthorize);
  app.get("/u/login", renderAuthorize);
  app.post("/u/login/callback", handleCallback);
  app.get("/u/consent", (c) => {
    const client = auth0.applications.findOneBy("client_id", c.req.query("client_id") ?? "");
    return renderConsent(
      c,
      client?.name ?? "Application",
      hiddenFromQuery(c, tenantBaseUrl(c, baseUrl, getTenant(store))),
    );
  });
  app.post("/u/consent/callback", handleCallback);

  app.get("/oauth/authorize", (c) => c.redirect(`/authorize?${new URL(c.req.url).searchParams.toString()}`, 302));

  app.get("/authorize/callback", (c) =>
    auth0Error(c, 405, "Method Not Allowed", "Use POST from the Universal Login page."),
  );
}
