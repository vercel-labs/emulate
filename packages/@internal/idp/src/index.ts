import type { Hono } from "hono";
import type { ServicePlugin, Store, WebhookDispatcher, TokenMap, AppEnv, RouteContext } from "@internal/core";
import { getIdpStore } from "./store.js";
import { generateUid } from "./helpers.js";
import { generateSigningKeySync, importSigningKey } from "./crypto.js";
import { oidcRoutes } from "./routes/oidc.js";
import { samlRoutes } from "./routes/saml.js";
import { ENTRA_ID_ATTRIBUTE_MAPPINGS } from "./saml-constants.js";

export { getIdpStore, type IdpStore } from "./store.js";
export * from "./entities.js";

export interface IdpSeedConfig {
  port?: number;
  strict?: boolean;
  users?: Array<{
    id?: string;
    email: string;
    name?: string;
    given_name?: string;
    family_name?: string;
    picture?: string;
    locale?: string;
    email_verified?: boolean;
    groups?: string[];
    roles?: string[];
    attributes?: Record<string, unknown>;
  }>;
  groups?: Array<{
    name: string;
    display_name?: string;
  }>;
  oidc?: {
    issuer?: string;
    signing_keys?: Array<{
      kid?: string;
      alg?: string;
      private_key_pem: string;
    }>;
    clients?: Array<{
      client_id: string;
      client_secret: string;
      name?: string;
      redirect_uris: string[];
      post_logout_redirect_uris?: string[];
      scopes?: string[];
      claim_mappings?: Record<string, string>;
      access_token_ttl?: number;
      id_token_ttl?: number;
      refresh_token_ttl?: number;
    }>;
  };
  saml?: {
    entity_id?: string;
    certificate_pem?: string;
    service_providers?: Array<{
      entity_id: string;
      acs_url: string;
      name_id_format?: string;
      attribute_mappings?: Record<string, string>;
    }>;
  };
}

function seedDefaults(store: Store, _baseUrl: string): void {
  const idp = getIdpStore(store);

  idp.users.insert({
    uid: generateUid("idp"),
    email: "testuser@example.com",
    email_verified: true,
    name: "Test User",
    given_name: "Test",
    family_name: "User",
    picture: null,
    locale: "en",
    groups: [],
    roles: [],
    attributes: {},
  });

  const key = generateSigningKeySync();
  idp.signingKeys.insert({
    kid: key.kid,
    alg: key.alg,
    private_key_pem: key.private_key_pem,
    public_key_jwk: key.public_key_jwk,
    active: key.active,
  });
}

export function seedFromConfig(store: Store, _baseUrl: string, config: IdpSeedConfig): void {
  const idp = getIdpStore(store);

  if (config.strict != null) {
    store.setData("idp.strict", config.strict);
  }

  if (config.oidc?.issuer) {
    store.setData("idp.issuer", config.oidc.issuer);
  }

  if (config.users) {
    for (const u of config.users) {
      const existing = idp.users.findOneBy("email", u.email);
      if (existing) continue;

      const nameParts = (u.name ?? "").split(/\s+/);
      idp.users.insert({
        uid: u.id ?? generateUid("idp"),
        email: u.email,
        email_verified: u.email_verified ?? true,
        name: u.name ?? u.email.split("@")[0],
        given_name: u.given_name ?? nameParts[0] ?? "",
        family_name: u.family_name ?? nameParts.slice(1).join(" ") ?? "",
        picture: u.picture ?? null,
        locale: u.locale ?? "en",
        groups: u.groups ?? [],
        roles: u.roles ?? [],
        attributes: u.attributes ?? {},
      });
    }
  }

  if (config.groups) {
    for (const g of config.groups) {
      const existing = idp.groups.findOneBy("name", g.name);
      if (existing) continue;
      idp.groups.insert({
        name: g.name,
        display_name: g.display_name ?? g.name,
      });
    }
  }

  if (config.oidc?.clients) {
    for (const c of config.oidc.clients) {
      const existing = idp.clients.findOneBy("client_id", c.client_id);
      if (existing) continue;
      idp.clients.insert({
        client_id: c.client_id,
        client_secret: c.client_secret,
        name: c.name ?? c.client_id,
        redirect_uris: c.redirect_uris,
        post_logout_redirect_uris: c.post_logout_redirect_uris ?? [],
        scopes: c.scopes ?? ["openid", "email", "profile"],
        claim_mappings: c.claim_mappings ?? {},
        access_token_ttl: c.access_token_ttl ?? 3600,
        id_token_ttl: c.id_token_ttl ?? 3600,
        refresh_token_ttl: c.refresh_token_ttl ?? 86400,
      });
    }
  }

  // Signing keys: use provided or auto-generate
  if (config.oidc?.signing_keys && config.oidc.signing_keys.length > 0) {
    for (const sk of config.oidc.signing_keys) {
      const existing = sk.kid ? idp.signingKeys.findOneBy("kid", sk.kid) : null;
      if (existing) continue;
      const imported = importSigningKey(sk.private_key_pem, sk.kid, sk.alg);
      idp.signingKeys.insert({
        kid: imported.kid,
        alg: imported.alg,
        private_key_pem: imported.private_key_pem,
        public_key_jwk: imported.public_key_jwk,
        active: imported.active,
      });
    }
  } else if (idp.signingKeys.all().length === 0) {
    const key = generateSigningKeySync();
    idp.signingKeys.insert({
      kid: key.kid,
      alg: key.alg,
      private_key_pem: key.private_key_pem,
      public_key_jwk: key.public_key_jwk,
      active: key.active,
    });
  }

  // SAML configuration
  if (config.saml?.entity_id) {
    store.setData("idp.saml.entityId", config.saml.entity_id);
  }

  if (config.saml?.certificate_pem) {
    store.setData("idp.saml.certificatePem", config.saml.certificate_pem);
  }

  if (config.saml?.service_providers) {
    for (const sp of config.saml.service_providers) {
      const existing = idp.serviceProviders.findOneBy("entity_id", sp.entity_id);
      if (existing) continue;
      idp.serviceProviders.insert({
        entity_id: sp.entity_id,
        acs_url: sp.acs_url,
        name_id_format: sp.name_id_format ?? "emailAddress",
        attribute_mappings: sp.attribute_mappings ?? ENTRA_ID_ATTRIBUTE_MAPPINGS,
      });
    }
  }
}

export const idpPlugin: ServicePlugin = {
  name: "idp",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    oidcRoutes(ctx);
    samlRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default idpPlugin;
