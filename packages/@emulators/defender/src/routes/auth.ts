import { constantTimeSecretEqual, type AppEnv, type Context } from "@emulators/core";
import { ALL_ROLES, API_AUDIENCE, field, guid, issueJwt, parseFormOrJson, str } from "../helpers.js";
import { logEvent } from "../store.js";
import type { DefRouteContext } from "../route-utils.js";

export const TOKEN_TTL_SECONDS = 3600;

export function authRoutes(rc: DefRouteContext): void {
  const { app, ds, baseUrl } = rc;

  const tokenHandler = async (c: Context<AppEnv>, tenantParam: string | undefined) => {
    const body = await parseFormOrJson(c);
    let clientId = str(field(body, "client_id")) ?? "";
    let clientSecret = str(field(body, "client_secret")) ?? "";
    const authHeader = c.req.header("Authorization") ?? "";
    if (authHeader.startsWith("Basic ")) {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString();
      const separator = decoded.indexOf(":");
      if (separator > 0) {
        clientId = decodeURIComponent(decoded.slice(0, separator));
        clientSecret = decodeURIComponent(decoded.slice(separator + 1));
      }
    }
    const grantType = str(field(body, "grant_type")) ?? "";
    const scope = str(field(body, "scope")) ?? str(field(body, "resource")) ?? `${API_AUDIENCE}/.default`;
    if (grantType !== "client_credentials") {
      return c.json(
        {
          error: "unsupported_grant_type",
          error_description:
            "AADSTS70003: The app requested an unsupported grant type. Only client_credentials is supported by the Defender emulator.",
          error_codes: [70003],
          timestamp: new Date().toISOString(),
          trace_id: guid(),
          correlation_id: guid(),
        },
        400,
      );
    }
    const tenantHint = tenantParam ?? str(field(body, "tenant")) ?? "common";
    const app_ = clientId ? ds.apps.findOneBy("client_id", clientId) : undefined;
    if (!app_ || !constantTimeSecretEqual(clientSecret, app_.client_secret)) {
      return c.json(
        {
          error: "invalid_client",
          error_description: app_
            ? "AADSTS7000215: Invalid client secret provided."
            : `AADSTS700016: Application with identifier '${clientId}' was not found in the directory.`,
          error_codes: [app_ ? 7000215 : 700016],
          timestamp: new Date().toISOString(),
          trace_id: guid(),
          correlation_id: guid(),
        },
        401,
      );
    }
    const tenant = ["common", "organizations"].includes(tenantHint.toLowerCase())
      ? (ds.tenants.all().find((candidate) => !app_.tenant_ids || app_.tenant_ids.includes(candidate.tenant_id)) ??
        ds.tenants.all()[0])
      : (ds.tenants.findOneBy("tenant_id", tenantHint) ??
        ds.tenants.all().find((candidate) => candidate.name.toLowerCase() === tenantHint.toLowerCase()));
    if (!tenant) {
      return c.json(
        {
          error: "invalid_request",
          error_description: `AADSTS90002: Tenant '${tenantHint}' not found. Check to make sure you have the correct tenant ID and are signing into the correct cloud.`,
          error_codes: [90002],
          timestamp: new Date().toISOString(),
          trace_id: guid(),
          correlation_id: guid(),
        },
        400,
      );
    }
    if (app_.tenant_ids && !app_.tenant_ids.includes(tenant.tenant_id)) {
      return c.json(
        {
          error: "unauthorized_client",
          error_description: `AADSTS700016: Application with identifier '${clientId}' was not found in the directory '${tenant.name}'. The application has not been granted consent in this tenant.`,
          error_codes: [700016],
          timestamp: new Date().toISOString(),
          trace_id: guid(),
          correlation_id: guid(),
        },
        401,
      );
    }
    const now = Math.floor(Date.now() / 1000);
    const roles = app_.roles.length > 0 ? app_.roles : ALL_ROLES;
    const token = issueJwt({
      aud: API_AUDIENCE,
      iss: `https://sts.windows.net/${tenant.tenant_id}/`,
      iat: now,
      nbf: now,
      exp: now + TOKEN_TTL_SECONDS,
      appid: app_.client_id,
      appidacr: "1",
      idp: `https://sts.windows.net/${tenant.tenant_id}/`,
      oid: guid(),
      roles,
      sub: guid(),
      tid: tenant.tenant_id,
      uti: guid().replace(/-/g, "").slice(0, 22),
      ver: "1.0",
    });
    ds.tokens.insert({
      token,
      tenant_id: tenant.tenant_id,
      client_id: app_.client_id,
      roles,
      expires_at: new Date((now + TOKEN_TTL_SECONDS) * 1000).toISOString(),
    });
    logEvent(ds, tenant.tenant_id, "token.issued", app_.client_id, { scope, tenant: tenant.name });
    return c.json({
      token_type: "Bearer",
      expires_in: TOKEN_TTL_SECONDS,
      ext_expires_in: TOKEN_TTL_SECONDS,
      access_token: token,
    });
  };

  app.post("/:tenant/oauth2/v2.0/token", (c) => tokenHandler(c, c.req.param("tenant")));
  app.post("/:tenant/oauth2/token", (c) => tokenHandler(c, c.req.param("tenant")));
  app.post("/oauth2/v2.0/token", (c) => tokenHandler(c, undefined));
  app.post("/oauth2/token", (c) => tokenHandler(c, undefined));

  app.get("/:tenant/v2.0/.well-known/openid-configuration", (c) => {
    const tenant = c.req.param("tenant");
    return c.json({
      token_endpoint: `${baseUrl}/${tenant}/oauth2/v2.0/token`,
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
      grant_types_supported: ["client_credentials"],
      issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
      tenant_region_scope: "EU",
      cloud_instance_name: "microsoftonline.com",
    });
  });
}
