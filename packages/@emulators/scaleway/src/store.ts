import { Store, type Collection } from "@emulators/core";
import type {
  ScwApiKey,
  ScwBlocklist,
  ScwDomain,
  ScwEmail,
  ScwEventLog,
  ScwProject,
  ScwWebhook,
  ScwWebhookEvent,
} from "./entities.js";

export interface ScwStore {
  raw: Store;
  apiKeys: Collection<ScwApiKey>;
  projects: Collection<ScwProject>;
  domains: Collection<ScwDomain>;
  emails: Collection<ScwEmail>;
  webhooks: Collection<ScwWebhook>;
  webhookEvents: Collection<ScwWebhookEvent>;
  blocklists: Collection<ScwBlocklist>;
  events: Collection<ScwEventLog>;
}

export function getScwStore(store: Store): ScwStore {
  return {
    raw: store,
    apiKeys: store.collection<ScwApiKey>("scaleway.api_keys", ["secret_key", "access_key"]),
    projects: store.collection<ScwProject>("scaleway.projects", ["project_id"]),
    domains: store.collection<ScwDomain>("scaleway.domains", ["domain_id", "name", "project_id"]),
    emails: store.collection<ScwEmail>("scaleway.emails", ["email_id", "message_id", "project_id", "mail_rcpt"]),
    webhooks: store.collection<ScwWebhook>("scaleway.webhooks", ["webhook_id", "domain_id"]),
    webhookEvents: store.collection<ScwWebhookEvent>("scaleway.webhook_events", ["event_id", "webhook_id", "email_id"]),
    blocklists: store.collection<ScwBlocklist>("scaleway.blocklists", ["blocklist_id", "domain_id", "email"]),
    events: store.collection<ScwEventLog>("scaleway.events", ["type"]),
  };
}

export interface ScwSettings {
  delivery_delay_ms: number;
  strict_domains: boolean;
  max_recipients: number;
  max_attachment_bytes: number;
  periodic_report: {
    enabled: boolean;
    frequency: "monthly" | "weekly" | "daily";
    sending_hour: number;
    sending_day: number;
  };
}

const SETTINGS_KEY = "scaleway.settings";

export const DEFAULT_SETTINGS: ScwSettings = {
  delivery_delay_ms: 1500,
  strict_domains: false,
  max_recipients: 100,
  max_attachment_bytes: 2 * 1024 * 1024,
  periodic_report: { enabled: false, frequency: "monthly", sending_hour: 8, sending_day: 1 },
};

export function settings(scw: ScwStore): ScwSettings {
  return { ...DEFAULT_SETTINGS, ...(scw.raw.getData<Partial<ScwSettings>>(SETTINGS_KEY) ?? {}) };
}

export function updateSettings(scw: ScwStore, patch: Partial<ScwSettings>): ScwSettings {
  const next = { ...settings(scw), ...patch };
  scw.raw.setData(SETTINGS_KEY, next);
  return next;
}

export function logEvent(scw: ScwStore, type: string, subject: string, detail: Record<string, unknown>): void {
  scw.events.insert({ type, subject, detail });
  const all = scw.events.all();
  if (all.length > 1000) for (const stale of all.slice(0, all.length - 1000)) scw.events.delete(stale.id);
}
