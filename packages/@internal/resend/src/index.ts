import type { Hono } from "hono";
import type { ServicePlugin, Store, WebhookDispatcher, TokenMap, AppEnv, RouteContext } from "@internal/core";
import { getResendStore } from "./store.js";
import { generateApiKeyToken } from "./helpers.js";
import { emailRoutes } from "./routes/emails.js";
import { domainRoutes } from "./routes/domains.js";
import { apiKeyRoutes } from "./routes/api-keys.js";
import { contactRoutes } from "./routes/contacts.js";
import { audienceRoutes } from "./routes/audiences.js";
import { webhookRoutes } from "./routes/webhooks.js";

export { getResendStore, type ResendStore } from "./store.js";
export * from "./entities.js";

export interface ResendSeedConfig {
  domains?: Array<{
    name: string;
    region?: string;
  }>;
  api_keys?: Array<{
    name: string;
    permission?: "full_access" | "sending_access";
  }>;
  contacts?: Array<{
    email: string;
    first_name?: string;
    last_name?: string;
  }>;
}

function seedDefaults(store: Store, _baseUrl: string): void {
  const rs = getResendStore(store);

  rs.domains.insert({
    name: "test.example.com",
    status: "verified",
    region: "us-east-1",
    click_tracking: false,
    open_tracking: false,
    tls: "opportunistic",
    records: [
      {
        record: "SPF",
        name: "send.test.example.com",
        type: "MX",
        ttl: "Auto",
        status: "verified",
        value: "feedback-smtp.us-east-1.amazonses.com",
        priority: 10,
      },
      {
        record: "SPF",
        name: "send.test.example.com",
        type: "TXT",
        ttl: "Auto",
        status: "verified",
        value: `"v=spf1 include:amazonses.com ~all"`,
      },
      {
        record: "DKIM",
        name: "resend._domainkey.test.example.com",
        type: "CNAME",
        ttl: "Auto",
        status: "verified",
        value: "test.example.com.dkim.resend.dev",
      },
    ],
  });

  rs.apiKeys.insert({
    name: "Default API Key",
    token: generateApiKeyToken(),
    permission: "full_access",
    domain_id: null,
    last_used_at: null,
  });
}

export function seedFromConfig(store: Store, _baseUrl: string, config: ResendSeedConfig): void {
  const rs = getResendStore(store);

  if (config.domains) {
    for (const d of config.domains) {
      const existing = rs.domains.findOneBy("name", d.name);
      if (existing) continue;

      const region = (d.region ?? "us-east-1") as "us-east-1" | "eu-west-1" | "sa-east-1" | "ap-northeast-1";
      rs.domains.insert({
        name: d.name,
        status: "not_started",
        region,
        click_tracking: false,
        open_tracking: false,
        tls: "opportunistic",
        records: [
          {
            record: "SPF",
            name: `send.${d.name}`,
            type: "MX",
            ttl: "Auto",
            status: "not_started",
            value: `feedback-smtp.${region}.amazonses.com`,
            priority: 10,
          },
          {
            record: "SPF",
            name: `send.${d.name}`,
            type: "TXT",
            ttl: "Auto",
            status: "not_started",
            value: `"v=spf1 include:amazonses.com ~all"`,
          },
          {
            record: "DKIM",
            name: `resend._domainkey.${d.name}`,
            type: "CNAME",
            ttl: "Auto",
            status: "not_started",
            value: `${d.name}.dkim.resend.dev`,
          },
        ],
      });
    }
  }

  if (config.api_keys) {
    for (const k of config.api_keys) {
      rs.apiKeys.insert({
        name: k.name,
        token: generateApiKeyToken(),
        permission: k.permission ?? "full_access",
        domain_id: null,
        last_used_at: null,
      });
    }
  }

  if (config.contacts) {
    for (const ct of config.contacts) {
      const existing = rs.contacts.findOneBy("email", ct.email);
      if (existing) continue;

      rs.contacts.insert({
        email: ct.email,
        first_name: ct.first_name ?? null,
        last_name: ct.last_name ?? null,
        unsubscribed: false,
        properties: null,
      });
    }
  }
}

export const resendPlugin: ServicePlugin = {
  name: "resend",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    emailRoutes(ctx);
    domainRoutes(ctx);
    apiKeyRoutes(ctx);
    contactRoutes(ctx);
    audienceRoutes(ctx);
    webhookRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default resendPlugin;
