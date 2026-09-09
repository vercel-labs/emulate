import type { Hono } from "@emulators/core";
import type { AppEnv, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import type { MailgunDomain, MailgunTemplateVersion, WebhookType } from "./entities.js";
import type { Fmt } from "./formatters.js";
import { WEBHOOK_TYPES } from "./formatters.js";
import { routeId, templateVersionId, token } from "./ids.js";
import { domainRoutes } from "./routes/domains.js";
import { eventRoutes } from "./routes/events.js";
import { inboundRoutes } from "./routes/inbound.js";
import { inspectorRoutes } from "./routes/inspector.js";
import { listRoutes } from "./routes/lists.js";
import { messageRoutes } from "./routes/messages.js";
import { miscRoutes } from "./routes/misc.js";
import { suppressionRoutes } from "./routes/suppressions.js";
import { tagRoutes } from "./routes/tags.js";
import { templateRoutes } from "./routes/templates.js";
import { validateRoutes } from "./routes/validate.js";
import { webhookRoutes } from "./routes/webhooks.js";
import type { MailgunRouteContext } from "./route-utils.js";
import { getMailgunStore, setAccountId, setWebhookSigningKey, type MailgunStore } from "./store.js";
import type { MailgunCtx } from "./webhooks.js";

export { getMailgunStore, type MailgunStore } from "./store.js";
export * from "./entities.js";
export { signWebhook } from "./webhooks.js";
export { renderTemplate } from "./sending.js";

export interface MailgunSeedConfig {
  port?: number;
  baseUrl?: string;
  account_id?: string;
  webhook_signing_key?: string;
  api_keys?: Array<{ key: string; domain?: string; description?: string }>;
  domains?: Array<{
    name: string;
    type?: "custom" | "sandbox";
    state?: "active" | "unverified" | "disabled";
    smtp_password?: string;
    sending_key?: string;
    spam_action?: "disabled" | "block" | "tag";
    web_scheme?: "http" | "https";
    tracking?: { open?: boolean; click?: boolean; unsubscribe?: boolean };
    authorized_recipients?: string[];
  }>;
  lists?: Array<{
    address: string;
    name?: string;
    description?: string;
    access_level?: "readonly" | "members" | "everyone";
    reply_preference?: "list" | "sender";
    members?: Array<{ address: string; name?: string; vars?: Record<string, unknown>; subscribed?: boolean }>;
  }>;
  templates?: Array<{
    domain: string;
    name: string;
    description?: string;
    template: string;
    tag?: string;
    engine?: "handlebars" | "go";
    subject?: string;
  }>;
  routes?: Array<{ id?: string; priority?: number; description?: string; expression: string; actions: string[] }>;
  webhooks?: Array<{ domain: string; type?: WebhookType; types?: WebhookType[]; url: string | string[] }>;
  suppressions?: {
    bounces?: Array<{ domain: string; address: string; code?: string; error?: string }>;
    unsubscribes?: Array<{ domain: string; address: string; tags?: string[] }>;
    complaints?: Array<{ domain: string; address: string }>;
    whitelists?: Array<{ domain: string; address?: string; domain_name?: string; reason?: string }>;
  };
  credentials?: Array<{ domain: string; login: string; password: string }>;
}

export const DEFAULT_API_KEY = "key-emulate-mailgun-test";
export const DEFAULT_WEBHOOK_SIGNING_KEY = "emulate-mailgun-webhook-key";
export const DEFAULT_DOMAIN = "mail.example.com";
export const DEFAULT_SANDBOX_DOMAIN = "sandbox0000000000000000000000000000.mailgun.org";
export const DEFAULT_SANDBOX_RECIPIENT = "test@example.com";
export const DEFAULT_LIST_ADDRESS = "team@mail.example.com";
export const DEFAULT_TEMPLATE_NAME = "welcome";

export const DEFAULT_SEED: MailgunSeedConfig = {
  account_id: "emulate-account",
  webhook_signing_key: DEFAULT_WEBHOOK_SIGNING_KEY,
  api_keys: [{ key: DEFAULT_API_KEY, description: "Local API key" }],
  domains: [
    {
      name: DEFAULT_DOMAIN,
      type: "custom",
      state: "active",
      tracking: { open: true, click: true, unsubscribe: false },
    },
    {
      name: DEFAULT_SANDBOX_DOMAIN,
      type: "sandbox",
      state: "active",
      authorized_recipients: [DEFAULT_SANDBOX_RECIPIENT],
    },
  ],
  lists: [
    {
      address: DEFAULT_LIST_ADDRESS,
      name: "Team",
      description: "Local team list",
      access_level: "everyone",
      members: [
        { address: "alice@example.com", name: "Alice", vars: { role: "admin" } },
        { address: "bob@example.com", name: "Bob", vars: { role: "member" } },
      ],
    },
  ],
  templates: [
    {
      domain: DEFAULT_DOMAIN,
      name: DEFAULT_TEMPLATE_NAME,
      description: "Welcome email",
      template: "<p>Hello {{name}}, welcome to {{company}}.</p>",
      subject: "Welcome to {{company}}",
    },
  ],
};

function seedDomain(ms: MailgunStore, entry: NonNullable<MailgunSeedConfig["domains"]>[number]): MailgunDomain {
  const name = entry.name.toLowerCase();
  const existing = ms.domains.findOneBy("name", name);
  if (existing) return existing;
  return ms.domains.insert({
    name,
    type: entry.type ?? (name.endsWith(".mailgun.org") ? "sandbox" : "custom"),
    state: entry.state ?? "active",
    smtp_password: entry.smtp_password ?? token(32),
    spam_action: entry.spam_action ?? "disabled",
    wildcard: false,
    web_scheme: entry.web_scheme ?? "http",
    web_prefix: "email",
    require_tls: false,
    skip_verification: false,
    is_disabled: entry.state === "disabled",
    tracking: {
      open: entry.tracking?.open ?? false,
      click: entry.tracking?.click ?? false,
      unsubscribe: entry.tracking?.unsubscribe ?? false,
    },
    authorized_recipients: (entry.authorized_recipients ?? []).map((address) => address.toLowerCase()),
    dkim_key_size: 1024,
  });
}

export function seedFromConfig(
  store: Store,
  _baseUrl: string,
  config: MailgunSeedConfig,
  _webhooks?: WebhookDispatcher,
): void {
  const ms = getMailgunStore(store);
  if (config.account_id) setAccountId(ms, config.account_id);
  if (config.webhook_signing_key) setWebhookSigningKey(ms, config.webhook_signing_key);

  for (const entry of config.api_keys ?? []) {
    if (!entry.key || ms.apiKeys.findOneBy("key", entry.key)) continue;
    ms.apiKeys.insert({
      key: entry.key,
      kind: entry.domain ? "domain" : "account",
      domain: entry.domain?.toLowerCase() ?? null,
      description: entry.description ?? (entry.domain ? "Domain sending key" : "API key"),
    });
  }
  if (ms.apiKeys.count() === 0)
    ms.apiKeys.insert({ key: DEFAULT_API_KEY, kind: "account", domain: null, description: "Local API key" });

  for (const entry of config.domains ?? []) {
    const domain = seedDomain(ms, entry);
    if (entry.sending_key && !ms.apiKeys.findOneBy("key", entry.sending_key)) {
      ms.apiKeys.insert({
        key: entry.sending_key,
        kind: "domain",
        domain: domain.name,
        description: `Sending key for ${domain.name}`,
      });
    }
  }
  if (ms.domains.count() === 0) seedDomain(ms, { name: DEFAULT_DOMAIN });

  for (const entry of config.lists ?? []) {
    const address = entry.address.toLowerCase();
    let list = ms.lists.findOneBy("address", address);
    if (!list) {
      list = ms.lists.insert({
        address,
        name: entry.name ?? "",
        description: entry.description ?? "",
        access_level: entry.access_level ?? "readonly",
        reply_preference: entry.reply_preference ?? "list",
      });
    }
    for (const member of entry.members ?? []) {
      const memberAddress = member.address.toLowerCase();
      if (ms.members.findBy("list_address", list.address).some((candidate) => candidate.address === memberAddress))
        continue;
      ms.members.insert({
        list_address: list.address,
        address: memberAddress,
        name: member.name ?? "",
        subscribed: member.subscribed ?? true,
        vars: member.vars ?? {},
      });
    }
  }

  for (const entry of config.templates ?? []) {
    const domain = seedDomain(ms, { name: entry.domain });
    const name = entry.name.toLowerCase();
    if (ms.templates.findBy("domain", domain.name).some((template) => template.name === name)) continue;
    ms.templates.insert({ domain: domain.name, name, description: entry.description ?? "", created_by: "seed" });
    const version: Omit<MailgunTemplateVersion, "id" | "created_at" | "updated_at"> = {
      domain: domain.name,
      template_name: name,
      version_id: templateVersionId(),
      tag: entry.tag ?? "initial",
      engine: entry.engine ?? "handlebars",
      comment: "",
      active: true,
      content: entry.template,
      headers: entry.subject ? { subject: entry.subject } : {},
    };
    ms.templateVersions.insert(version);
  }

  for (const entry of config.routes ?? []) {
    if (entry.id && ms.routes.findOneBy("route_id", entry.id)) continue;
    if (
      ms.routes
        .all()
        .some(
          (candidate) =>
            candidate.expression === entry.expression && candidate.actions.join("|") === entry.actions.join("|"),
        )
    )
      continue;
    ms.routes.insert({
      route_id: entry.id ?? routeId(),
      priority: entry.priority ?? 0,
      description: entry.description ?? "",
      expression: entry.expression,
      actions: entry.actions,
    });
  }

  for (const entry of config.webhooks ?? []) {
    const domain = seedDomain(ms, { name: entry.domain });
    const types = entry.types ?? (entry.type ? [entry.type] : WEBHOOK_TYPES);
    const urls = Array.isArray(entry.url) ? entry.url : [entry.url];
    for (const type of types) {
      const existing = ms.webhooks.findBy("domain", domain.name).find((webhook) => webhook.type === type);
      if (existing) {
        ms.webhooks.update(existing.id, { urls: [...new Set([...existing.urls, ...urls])].slice(0, 3) });
        continue;
      }
      ms.webhooks.insert({ domain: domain.name, type, urls: urls.slice(0, 3) });
    }
  }

  const suppressions = config.suppressions ?? {};
  const addSuppression = (
    kind: "bounce" | "unsubscribe" | "complaint" | "whitelist",
    domainName: string,
    address: string,
    extra: Partial<{ code: string; error: string; tags: string[]; reason: string; type: "address" | "domain" }>,
  ) => {
    const domain = seedDomain(ms, { name: domainName });
    const lowered = address.toLowerCase();
    if (ms.suppressions.findBy("domain", domain.name).some((item) => item.kind === kind && item.address === lowered))
      return;
    ms.suppressions.insert({
      domain: domain.name,
      kind,
      address: lowered,
      code: extra.code ?? null,
      error: extra.error ?? null,
      tags: extra.tags ?? [],
      reason: extra.reason ?? null,
      type: extra.type ?? "address",
    });
  };
  for (const item of suppressions.bounces ?? [])
    addSuppression("bounce", item.domain, item.address, { code: item.code ?? "550", error: item.error ?? "" });
  for (const item of suppressions.unsubscribes ?? [])
    addSuppression("unsubscribe", item.domain, item.address, { tags: item.tags ?? ["*"] });
  for (const item of suppressions.complaints ?? []) addSuppression("complaint", item.domain, item.address, {});
  for (const item of suppressions.whitelists ?? []) {
    const value = item.address ?? item.domain_name;
    if (!value) continue;
    addSuppression("whitelist", item.domain, value, {
      reason: item.reason ?? "",
      type: item.address ? "address" : "domain",
    });
  }

  for (const entry of config.credentials ?? []) {
    const domain = seedDomain(ms, { name: entry.domain });
    const login = entry.login.includes("@") ? entry.login.toLowerCase() : `${entry.login.toLowerCase()}@${domain.name}`;
    if (ms.credentials.findBy("domain", domain.name).some((credential) => credential.login === login)) continue;
    ms.credentials.insert({ domain: domain.name, login, password: entry.password });
  }
}

function seedDefaults(store: Store, baseUrl: string): void {
  seedFromConfig(store, baseUrl, DEFAULT_SEED);
}

export const mailgunPlugin: ServicePlugin = {
  name: "mailgun",
  register(app: Hono<AppEnv>, store: Store, _webhooks: WebhookDispatcher, baseUrl: string, _tokenMap?: TokenMap): void {
    const ms = getMailgunStore(store);
    const ctx: MailgunCtx = { ms, baseUrl };
    const fmt: Fmt = { ms, baseUrl };
    const rc: MailgunRouteContext = { app, ms, ctx, fmt, baseUrl };
    domainRoutes(rc);
    messageRoutes(rc);
    eventRoutes(rc);
    webhookRoutes(rc);
    suppressionRoutes(rc);
    listRoutes(rc);
    templateRoutes(rc);
    tagRoutes(rc);
    validateRoutes(rc);
    inboundRoutes(rc);
    miscRoutes(rc);
    inspectorRoutes(rc);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default mailgunPlugin;
