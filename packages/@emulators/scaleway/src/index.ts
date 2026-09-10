import type { AppEnv, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import {
  REGIONS,
  type BlocklistType,
  type DomainStatus,
  type EmailFlag,
  type EmailStatus,
  type Region,
  type WebhookEventType,
} from "./entities.js";
import { guid } from "./helpers.js";
import { createDomain, domainRoutes } from "./routes/domains.js";
import { createEmails, emailRoutes } from "./routes/emails.js";
import { inspectorRoutes } from "./routes/inspector.js";
import { miscRoutes } from "./routes/misc.js";
import { getScwStore, logEvent, updateSettings, type ScwSettings, type ScwStore } from "./store.js";

export { getScwStore, settings, updateSettings, type ScwStore, type ScwSettings } from "./store.js";
export * from "./entities.js";
export { createEmails, formatEmail, resolveEmail, setEmailStatus, type CreateEmailInput } from "./routes/emails.js";
export { createDomain, formatDomain } from "./routes/domains.js";

export interface ScalewaySeedConfig {
  port?: number;
  baseUrl?: string;
  organization_id?: string;
  projects?: Array<{ id: string; name?: string; organization_id?: string }>;
  api_keys?: Array<{ secret_key: string; access_key?: string; name?: string; project_ids?: string[] | null }>;
  domains?: Array<{
    id?: string;
    name: string;
    project_id?: string;
    status?: DomainStatus;
    region?: Region;
    autoconfig?: boolean;
  }>;
  webhooks?: Array<{ id?: string; domain: string; name: string; event_types?: WebhookEventType[]; sns_arn?: string }>;
  blocklists?: Array<{ domain: string; email: string; type?: BlocklistType; reason?: string }>;
  emails?: Array<{
    project_id?: string;
    from: { email: string; name?: string };
    to: Array<{ email: string; name?: string }>;
    subject: string;
    text?: string;
    html?: string;
    status?: EmailStatus;
    flags?: EmailFlag[];
    status_details?: string;
    created_at?: string;
    region?: Region;
  }>;
  settings?: Partial<
    Pick<ScwSettings, "delivery_delay_ms" | "strict_domains" | "max_recipients" | "max_attachment_bytes">
  >;
}

export const DEFAULT_SECRET_KEY = "00000000-0000-4000-8000-00000000ca1e";
export const DEFAULT_ACCESS_KEY = "SCWEMULATE0000000000";
export const DEFAULT_PROJECT_ID = "00000000-0000-4000-8000-00000000c0fe";
export const DEFAULT_ORGANIZATION_ID = "00000000-0000-4000-8000-00000000c0ff";
export const DEFAULT_DOMAIN = "emulate.example";
export const DEFAULT_DOMAIN_ID = "00000000-0000-4000-8000-00000000d0ac";
export const DEFAULT_PENDING_DOMAIN = "pending.example";
export const DEFAULT_PENDING_DOMAIN_ID = "00000000-0000-4000-8000-00000000d0ad";
export const DEFAULT_WEBHOOK_ID = "00000000-0000-4000-8000-00000000eb00";
export const DEFAULT_REGION: Region = "fr-par";

const daysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString();

export const DEFAULT_SEED: ScalewaySeedConfig = {
  organization_id: DEFAULT_ORGANIZATION_ID,
  projects: [{ id: DEFAULT_PROJECT_ID, name: "default" }],
  api_keys: [{ secret_key: DEFAULT_SECRET_KEY, access_key: DEFAULT_ACCESS_KEY, name: "emulate", project_ids: null }],
  domains: [
    { id: DEFAULT_DOMAIN_ID, name: DEFAULT_DOMAIN, status: "checked" },
    { id: DEFAULT_PENDING_DOMAIN_ID, name: DEFAULT_PENDING_DOMAIN, status: "unchecked" },
  ],
  webhooks: [
    {
      id: DEFAULT_WEBHOOK_ID,
      domain: DEFAULT_DOMAIN,
      name: "delivery-events",
      event_types: [
        "email_queued",
        "email_delivered",
        "email_dropped",
        "email_mailbox_not_found",
        "email_blocklisted",
        "email_spam",
      ],
      sns_arn: "arn:scw:sns:fr-par:project-00000000-0000-4000-8000-00000000c0fe:emulate-email-events",
    },
  ],
  blocklists: [
    {
      domain: DEFAULT_DOMAIN,
      email: "bounce@blocked.example",
      type: "mailbox_not_found",
      reason: "hard bounce on 2026-08-30",
    },
  ],
  emails: [
    {
      from: { email: `noreply@${DEFAULT_DOMAIN}`, name: "Emulate Platform" },
      to: [{ email: "alice@customer.example", name: "alice@customer.example" }],
      subject: "Welcome to the platform",
      text: "Welcome aboard.",
      html: "<p>Welcome aboard.</p>",
      status: "sent",
      created_at: daysAgo(3),
    },
    {
      from: { email: `noreply@${DEFAULT_DOMAIN}`, name: "Emulate Platform" },
      to: [{ email: "bob@customer.example", name: "bob@customer.example" }],
      subject: "Your monthly security report is ready",
      text: "The report is attached.",
      html: "<p>The report is attached.</p>",
      status: "sent",
      created_at: daysAgo(2),
    },
    {
      from: { email: `noreply@${DEFAULT_DOMAIN}`, name: "Emulate Platform" },
      to: [{ email: "gone@customer.example", name: "gone@customer.example" }],
      subject: "Password reset",
      text: "Reset your password.",
      status: "failed",
      flags: ["hard_bounce", "mailbox_not_found"],
      status_details: "550 5.1.1 The email account that you tried to reach does not exist",
      created_at: daysAgo(1),
    },
  ],
};

export function seedFromConfig(
  store: Store,
  _baseUrl: string,
  config: ScalewaySeedConfig,
  _webhooks?: WebhookDispatcher,
): void {
  const scw = getScwStore(store);
  if (config.settings) updateSettings(scw, config.settings);
  const organizationId = config.organization_id ?? scw.projects.all()[0]?.organization_id ?? DEFAULT_ORGANIZATION_ID;
  for (const entry of config.projects ?? []) {
    if (scw.projects.findOneBy("project_id", entry.id)) continue;
    scw.projects.insert({
      project_id: entry.id,
      organization_id: entry.organization_id ?? organizationId,
      name: entry.name ?? "default",
    });
  }
  if (scw.projects.count() === 0)
    scw.projects.insert({ project_id: DEFAULT_PROJECT_ID, organization_id: organizationId, name: "default" });
  const defaultProject = scw.projects.all()[0];
  for (const entry of config.api_keys ?? []) {
    if (!entry.secret_key || scw.apiKeys.findOneBy("secret_key", entry.secret_key)) continue;
    scw.apiKeys.insert({
      secret_key: entry.secret_key,
      access_key: entry.access_key ?? `SCW${guid().replace(/-/g, "").slice(0, 17).toUpperCase()}`,
      name: entry.name ?? "scaleway",
      project_ids: entry.project_ids ?? null,
    });
  }
  if (scw.apiKeys.count() === 0)
    scw.apiKeys.insert({
      secret_key: DEFAULT_SECRET_KEY,
      access_key: DEFAULT_ACCESS_KEY,
      name: "emulate",
      project_ids: null,
    });
  for (const entry of config.domains ?? []) {
    if (
      (entry.id && scw.domains.findOneBy("domain_id", entry.id)) ||
      scw.domains.all().some((domain) => domain.name === entry.name.toLowerCase() && domain.status !== "revoked")
    )
      continue;
    const projectId = entry.project_id ?? defaultProject.project_id;
    const project = scw.projects.findOneBy("project_id", projectId) ?? defaultProject;
    createDomain(scw, {
      id: entry.id,
      name: entry.name,
      projectId: project.project_id,
      organizationId: project.organization_id,
      region: entry.region && REGIONS.includes(entry.region) ? entry.region : DEFAULT_REGION,
      autoconfig: entry.autoconfig,
      status: entry.status ?? "checked",
      createdAt: daysAgo(30),
    });
  }
  for (const entry of config.webhooks ?? []) {
    const domain = scw.domains.all().find((candidate) => candidate.name === entry.domain.toLowerCase());
    if (
      !domain ||
      (entry.id && scw.webhooks.findOneBy("webhook_id", entry.id)) ||
      scw.webhooks.findBy("domain_id", domain.domain_id).some((webhook) => webhook.name === entry.name)
    )
      continue;
    scw.webhooks.insert({
      webhook_id: entry.id ?? guid(),
      domain_id: domain.domain_id,
      organization_id: domain.organization_id,
      project_id: domain.project_id,
      name: entry.name,
      event_types: entry.event_types ?? ["email_queued", "email_delivered", "email_dropped"],
      sns_arn: entry.sns_arn ?? `arn:scw:sns:fr-par:project-${domain.project_id}:${entry.name}`,
    });
  }
  for (const entry of config.blocklists ?? []) {
    const domain = scw.domains.all().find((candidate) => candidate.name === entry.domain.toLowerCase());
    if (
      !domain ||
      scw.blocklists
        .findBy("domain_id", domain.domain_id)
        .some((existing) => existing.email === entry.email.toLowerCase())
    )
      continue;
    scw.blocklists.insert({
      blocklist_id: guid(),
      domain_id: domain.domain_id,
      email: entry.email.toLowerCase(),
      type: entry.type ?? "mailbox_not_found",
      reason: entry.reason ?? "seeded",
      custom: false,
      ends_at: new Date(Date.now() + 30 * 86400000).toISOString(),
    });
  }
  for (const entry of config.emails ?? []) {
    createEmails(scw, {
      projectId: entry.project_id ?? defaultProject.project_id,
      region: entry.region ?? DEFAULT_REGION,
      from: { email: entry.from.email, name: entry.from.name ?? null },
      to: entry.to.map((address) => ({ email: address.email, name: address.name ?? null })),
      subject: entry.subject,
      text: entry.text,
      html: entry.html,
      createdAt: entry.created_at,
      status: entry.status,
      flags: entry.flags,
      statusDetails: entry.status_details,
    });
  }
  logEvent(scw, "seed.applied", "config", {
    projects: scw.projects.count(),
    domains: scw.domains.count(),
    webhooks: scw.webhooks.count(),
    emails: scw.emails.count(),
  });
}

export const scalewayPlugin: ServicePlugin = {
  name: "scaleway",
  register(app: Hono<AppEnv>, store: Store, _webhooks: WebhookDispatcher, baseUrl: string, _tokenMap?: TokenMap): void {
    const scw: ScwStore = getScwStore(store);
    inspectorRoutes(app, scw, baseUrl);
    miscRoutes(app, scw);
    emailRoutes(app, scw);
    domainRoutes(app, scw);
  },
  seed(store: Store, baseUrl: string): void {
    seedFromConfig(store, baseUrl, DEFAULT_SEED);
  },
};

export default scalewayPlugin;
