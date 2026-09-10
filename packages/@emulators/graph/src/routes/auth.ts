import { constantTimeSecretEqual, type AppEnv, type Context, type Hono } from "@emulators/core";
import { ALL_PERMISSIONS, GRAPH_AUDIENCE, guid, issueJwt, str } from "../helpers.js";
import { logEvent, type GStore } from "../store.js";

export const TOKEN_TTL_SECONDS = 3600;

function aadError(c: Context, status: 400 | 401, error: string, description: string, code: number): Response {
  return c.json(
    {
      error,
      error_description: description,
      error_codes: [code],
      timestamp: new Date().toISOString(),
      trace_id: guid(),
      correlation_id: guid(),
    },
    status,
  );
}

async function readBody(c: Context): Promise<Record<string, unknown>> {
  const contentType = c.req.header("content-type") ?? "";
  const text = await c.req.text();
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text || "{}");
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

export function authRoutes(app: Hono<AppEnv>, gs: GStore, baseUrl: string): void {
  const handler = async (c: Context<AppEnv>, tenantParam: string | undefined) => {
    const body = await readBody(c);
    let clientId = str(body.client_id) ?? "";
    let clientSecret = str(body.client_secret) ?? "";
    const header = c.req.header("Authorization") ?? "";
    if (header.startsWith("Basic ")) {
      const decoded = Buffer.from(header.slice(6), "base64").toString();
      const separator = decoded.indexOf(":");
      if (separator > 0) {
        clientId = decodeURIComponent(decoded.slice(0, separator));
        clientSecret = decodeURIComponent(decoded.slice(separator + 1));
      }
    }
    if ((str(body.grant_type) ?? "") !== "client_credentials")
      return aadError(
        c,
        400,
        "unsupported_grant_type",
        "AADSTS70003: The app requested an unsupported grant type. Only client_credentials is supported by the Graph emulator.",
        70003,
      );
    const app_ = clientId ? gs.apps.findOneBy("client_id", clientId) : undefined;
    if (!app_ || !constantTimeSecretEqual(clientSecret, app_.client_secret))
      return aadError(
        c,
        401,
        "invalid_client",
        app_
          ? "AADSTS7000215: Invalid client secret provided."
          : `AADSTS700016: Application with identifier '${clientId}' was not found in the directory.`,
        app_ ? 7000215 : 700016,
      );
    const hint = tenantParam ?? str(body.tenant) ?? "common";
    const tenant = ["common", "organizations"].includes(hint.toLowerCase())
      ? (gs.tenants.all().find((candidate) => !app_.tenant_ids || app_.tenant_ids.includes(candidate.tenant_id)) ??
        gs.tenants.all()[0])
      : (gs.tenants.findOneBy("tenant_id", hint) ??
        gs.tenants.findOneBy("domain", hint.toLowerCase()) ??
        gs.tenants.all().find((candidate) => candidate.verified_domains.includes(hint.toLowerCase())));
    if (!tenant)
      return aadError(
        c,
        400,
        "invalid_request",
        `AADSTS90002: Tenant '${hint}' not found. Check to make sure you have the correct tenant ID and are signing into the correct cloud.`,
        90002,
      );
    if (app_.tenant_ids && !app_.tenant_ids.includes(tenant.tenant_id))
      return aadError(
        c,
        401,
        "unauthorized_client",
        `AADSTS700016: Application with identifier '${clientId}' was not found in the directory '${tenant.display_name}'. The application has not been granted admin consent in this tenant.`,
        700016,
      );
    const now = Math.floor(Date.now() / 1000);
    const roles = app_.permissions.length > 0 ? app_.permissions : ALL_PERMISSIONS;
    const token = issueJwt({
      aud: GRAPH_AUDIENCE,
      iss: `https://sts.windows.net/${tenant.tenant_id}/`,
      iat: now,
      nbf: now,
      exp: now + TOKEN_TTL_SECONDS,
      app_displayname: app_.name,
      appid: app_.client_id,
      appidacr: "1",
      idp: `https://sts.windows.net/${tenant.tenant_id}/`,
      oid: guid(),
      roles,
      sub: guid(),
      tid: tenant.tenant_id,
      ver: "1.0",
      wids: [],
    });
    gs.tokens.insert({
      token,
      tenant_id: tenant.tenant_id,
      client_id: app_.client_id,
      roles,
      expires_at: new Date((now + TOKEN_TTL_SECONDS) * 1000).toISOString(),
    });
    logEvent(gs, tenant.tenant_id, "token.issued", app_.client_id, {
      scope: str(body.scope) ?? `${GRAPH_AUDIENCE}/.default`,
      tenant: tenant.display_name,
    });
    return c.json({
      token_type: "Bearer",
      expires_in: TOKEN_TTL_SECONDS,
      ext_expires_in: TOKEN_TTL_SECONDS,
      access_token: token,
    });
  };

  app.post("/:tenant/oauth2/v2.0/token", (c) => handler(c, c.req.param("tenant")));
  app.post("/:tenant/oauth2/token", (c) => handler(c, c.req.param("tenant")));
  app.post("/oauth2/v2.0/token", (c) => handler(c, undefined));
  app.post("/oauth2/token", (c) => handler(c, undefined));
  app.get("/:tenant/v2.0/.well-known/openid-configuration", (c) =>
    c.json({
      token_endpoint: `${baseUrl}/${c.req.param("tenant")}/oauth2/v2.0/token`,
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
      grant_types_supported: ["client_credentials"],
      issuer: `https://login.microsoftonline.com/${c.req.param("tenant")}/v2.0`,
      cloud_graph_host_name: "graph.windows.net",
      msgraph_host: "graph.microsoft.com",
    }),
  );
}
