import { Store, type Collection } from "@emulators/core";
import type {
  MailgunApiKey,
  MailgunCredential,
  MailgunDomain,
  MailgunEvent,
  MailgunList,
  MailgunMember,
  MailgunMessage,
  MailgunRoute,
  MailgunRouteDelivery,
  MailgunSuppression,
  MailgunTag,
  MailgunTemplate,
  MailgunTemplateVersion,
  MailgunWebhook,
  MailgunWebhookDelivery,
} from "./entities.js";

export interface MailgunStore {
  raw: Store;
  apiKeys: Collection<MailgunApiKey>;
  domains: Collection<MailgunDomain>;
  messages: Collection<MailgunMessage>;
  events: Collection<MailgunEvent>;
  webhooks: Collection<MailgunWebhook>;
  webhookDeliveries: Collection<MailgunWebhookDelivery>;
  suppressions: Collection<MailgunSuppression>;
  lists: Collection<MailgunList>;
  members: Collection<MailgunMember>;
  templates: Collection<MailgunTemplate>;
  templateVersions: Collection<MailgunTemplateVersion>;
  tags: Collection<MailgunTag>;
  routes: Collection<MailgunRoute>;
  routeDeliveries: Collection<MailgunRouteDelivery>;
  credentials: Collection<MailgunCredential>;
}

export function getMailgunStore(store: Store): MailgunStore {
  return {
    raw: store,
    apiKeys: store.collection<MailgunApiKey>("mailgun.api_keys", ["key", "domain"]),
    domains: store.collection<MailgunDomain>("mailgun.domains", ["name"]),
    messages: store.collection<MailgunMessage>("mailgun.messages", ["key", "message_id", "domain"]),
    events: store.collection<MailgunEvent>("mailgun.events", ["event_id", "domain", "message_key", "recipient"]),
    webhooks: store.collection<MailgunWebhook>("mailgun.webhooks", ["domain"]),
    webhookDeliveries: store.collection<MailgunWebhookDelivery>("mailgun.webhook_deliveries", ["domain", "event_id"]),
    suppressions: store.collection<MailgunSuppression>("mailgun.suppressions", ["domain", "kind", "address"]),
    lists: store.collection<MailgunList>("mailgun.lists", ["address"]),
    members: store.collection<MailgunMember>("mailgun.members", ["list_address", "address"]),
    templates: store.collection<MailgunTemplate>("mailgun.templates", ["domain", "name"]),
    templateVersions: store.collection<MailgunTemplateVersion>("mailgun.template_versions", [
      "domain",
      "template_name",
    ]),
    tags: store.collection<MailgunTag>("mailgun.tags", ["domain", "tag"]),
    routes: store.collection<MailgunRoute>("mailgun.routes", ["route_id"]),
    routeDeliveries: store.collection<MailgunRouteDelivery>("mailgun.route_deliveries", ["route_id"]),
    credentials: store.collection<MailgunCredential>("mailgun.credentials", ["domain", "login"]),
  };
}

const SIGNING_KEY = "mailgun.webhook_signing_key";
const ACCOUNT_ID = "mailgun.account_id";

export function webhookSigningKey(ms: MailgunStore): string {
  return ms.raw.getData<string>(SIGNING_KEY) ?? "emulate-mailgun-webhook-key";
}

export function setWebhookSigningKey(ms: MailgunStore, value: string): void {
  ms.raw.setData(SIGNING_KEY, value);
}

export function accountId(ms: MailgunStore): string {
  return ms.raw.getData<string>(ACCOUNT_ID) ?? "emulate-account";
}

export function setAccountId(ms: MailgunStore, value: string): void {
  ms.raw.setData(ACCOUNT_ID, value);
}
