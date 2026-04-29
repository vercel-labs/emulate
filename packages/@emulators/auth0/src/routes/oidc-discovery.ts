import type { Context } from "hono";
import type { AppEnv, RouteContext } from "@emulators/core";
import { endpointUrl, getTenant, jwks, tenantBaseUrl } from "../helpers.js";

function configuration(c: Context<AppEnv>, baseUrl: string, tenant: string): Record<string, unknown> {
  const issuer = tenantBaseUrl(c, baseUrl, tenant);
  return {
    issuer,
    authorization_endpoint: endpointUrl(c, baseUrl, tenant, "/authorize"),
    token_endpoint: endpointUrl(c, baseUrl, tenant, "/oauth/token"),
    userinfo_endpoint: endpointUrl(c, baseUrl, tenant, "/userinfo"),
    jwks_uri: endpointUrl(c, baseUrl, tenant, "/.well-known/jwks.json"),
    end_session_endpoint: endpointUrl(c, baseUrl, tenant, "/v2/logout"),
    response_types_supported: ["code"],
    response_modes_supported: ["query", "form_post"],
    grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic", "none"],
    scopes_supported: ["openid", "profile", "email", "offline_access"],
    claims_supported: [
      "sub",
      "iss",
      "aud",
      "exp",
      "iat",
      "auth_time",
      "nonce",
      "name",
      "nickname",
      "picture",
      "email",
      "email_verified",
      "org_id",
    ],
    code_challenge_methods_supported: ["plain", "S256"],
  };
}

export function oidcDiscoveryRoutes({ app, store, baseUrl }: RouteContext): void {
  app.get("/.well-known/openid-configuration", (c) => c.json(configuration(c, baseUrl, getTenant(store))));
  app.get("/.well-known/jwks.json", async (c) => c.json(await jwks()));
}
