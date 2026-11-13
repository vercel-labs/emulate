import type { Hono } from "@emulators/core";
import type { ServicePlugin, Store, WebhookDispatcher, TokenMap, AppEnv, RouteContext } from "@emulators/core";
import { getResendStore } from "./store.js";
import { generateUuid } from "./helpers.js";
import { emailRoutes } from "./routes/emails.js";
import { domainRoutes } from "./routes/domains.js";
import { apiKeyRoutes } from "./routes/api-keys.js";
import { contactRoutes } from "./routes/contacts.js";
import { inboxRoutes } from "./routes/inbox.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { RESEND_WEBHOOK_EVENTS, seededSigningSecret, subscribeWebhook, svixWebhookHeaders } from "./webhooks.js";

export { getResendStore, type ResendStore } from "./store.js";
export * from "./entities.js";

export interface ResendSeedConfig {
  port?: number;
  allowlist?: string[];
  domains?: Array<{
    name: string;
    region?: string;
  }>;
  contacts?: Array<{
    email: string;
    first_name?: string;
    last_name?: string;
    audience?: string;
  }>;
  webhooks?: Array<{
    endpoint: string;
    events?: string[];
    status?: "enabled" | "disabled";
    signing_secret?: string;
  }>;
}

export function seedFromConfig(
  store: Store,
  _baseUrl: string,
  config: ResendSeedConfig,
  webhooks?: WebhookDispatcher,
): void {
  if (config.allowlist !== undefined) {
    if (
      !Array.isArray(config.allowlist) ||
      config.allowlist.some((address) => typeof address !== "string" || !address.trim())
    ) {
      throw new Error("Resend allowlist must be an array of non-empty email addresses");
    }
    store.setData(
      "resend.allowlist",
      config.allowlist.map((address) => address.trim()),
    );
  }
  const rs = getResendStore(store);

  if (config.domains) {
    for (const d of config.domains) {
      const existing = rs.domains.findOneBy("name", d.name);
      if (existing) continue;

      const region = d.region ?? "us-east-1";
      rs.domains.insert({
        uuid: generateUuid(),
        name: d.name,
        status: "verified",
        region,
        records: [
          {
            record: "SPF",
            name: d.name,
            type: "MX",
            ttl: "Auto",
            status: "verified" as const,
            value: `feedback-smtp.${region}.amazonses.com`,
            priority: 10,
          },
          {
            record: "SPF",
            name: d.name,
            type: "TXT",
            ttl: "Auto",
            status: "verified" as const,
            value: "v=spf1 include:amazonses.com ~all",
          },
          {
            record: "DKIM",
            name: `resend._domainkey.${d.name}`,
            type: "CNAME",
            ttl: "Auto",
            status: "verified" as const,
            value: `resend.domainkey.${region}.amazonses.com`,
          },
        ],
      });
    }
  }

  if (config.contacts) {
    // Ensure default audience exists
    let defaultAudience = rs.audiences.findOneBy("name", "Default");
    if (!defaultAudience) {
      defaultAudience = rs.audiences.insert({ uuid: generateUuid(), name: "Default" });
    }

    for (const ct of config.contacts) {
      let audienceId = defaultAudience.uuid;

      if (ct.audience) {
        let audience = rs.audiences.findOneBy("name", ct.audience);
        if (!audience) {
          audience = rs.audiences.insert({ uuid: generateUuid(), name: ct.audience });
        }
        audienceId = audience.uuid;
      }

      rs.contacts.insert({
        uuid: generateUuid(),
        audience_id: audienceId,
        email: ct.email,
        first_name: ct.first_name ?? null,
        last_name: ct.last_name ?? null,
        unsubscribed: false,
      });
    }
  }

  if (config.webhooks && webhooks) {
    webhooks.setHeaderFactory(svixWebhookHeaders);
    for (const wh of config.webhooks) {
      if (rs.webhooks.all().some((existing) => existing.endpoint === wh.endpoint)) continue;
      const webhook = rs.webhooks.insert({
        uuid: generateUuid(),
        endpoint: wh.endpoint,
        events: wh.events ?? [...RESEND_WEBHOOK_EVENTS],
        status: wh.status ?? "enabled",
        signing_secret: wh.signing_secret ?? seededSigningSecret(wh.endpoint),
      });
      subscribeWebhook(webhooks, webhook);
    }
  }
}

export const resendPlugin: ServicePlugin = {
  name: "resend",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    webhooks.setHeaderFactory(svixWebhookHeaders);

    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    emailRoutes(ctx);
    domainRoutes(ctx);
    apiKeyRoutes(ctx);
    contactRoutes(ctx);
    inboxRoutes(ctx);
    webhookRoutes(ctx);
  },
  seed(_store: Store, _baseUrl: string): void {
    // No default seed data - inbox starts empty
  },
};

export default resendPlugin;
