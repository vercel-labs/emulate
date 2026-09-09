import { Store, type Collection } from "@emulators/core";
import type {
  ZendeskApiToken,
  ZendeskAttachment,
  ZendeskAudit,
  ZendeskBrand,
  ZendeskComment,
  ZendeskCustomField,
  ZendeskCustomStatus,
  ZendeskEventLog,
  ZendeskGroup,
  ZendeskGroupMembership,
  ZendeskJobStatus,
  ZendeskMacro,
  ZendeskOAuthToken,
  ZendeskOrganization,
  ZendeskOrganizationMembership,
  ZendeskSatisfactionRating,
  ZendeskTicket,
  ZendeskTicketField,
  ZendeskTicketForm,
  ZendeskTrigger,
  ZendeskUser,
  ZendeskView,
  ZendeskWebhook,
  ZendeskWebhookInvocation,
} from "./entities.js";

export interface ZendeskStore {
  raw: Store;
  apiTokens: Collection<ZendeskApiToken>;
  oauthTokens: Collection<ZendeskOAuthToken>;
  users: Collection<ZendeskUser>;
  organizations: Collection<ZendeskOrganization>;
  organizationMemberships: Collection<ZendeskOrganizationMembership>;
  groups: Collection<ZendeskGroup>;
  groupMemberships: Collection<ZendeskGroupMembership>;
  tickets: Collection<ZendeskTicket>;
  comments: Collection<ZendeskComment>;
  audits: Collection<ZendeskAudit>;
  attachments: Collection<ZendeskAttachment>;
  ticketFields: Collection<ZendeskTicketField>;
  customFields: Collection<ZendeskCustomField>;
  macros: Collection<ZendeskMacro>;
  triggers: Collection<ZendeskTrigger>;
  views: Collection<ZendeskView>;
  webhooks: Collection<ZendeskWebhook>;
  webhookInvocations: Collection<ZendeskWebhookInvocation>;
  jobStatuses: Collection<ZendeskJobStatus>;
  satisfactionRatings: Collection<ZendeskSatisfactionRating>;
  customStatuses: Collection<ZendeskCustomStatus>;
  brands: Collection<ZendeskBrand>;
  ticketForms: Collection<ZendeskTicketForm>;
  events: Collection<ZendeskEventLog>;
}

export function getZendeskStore(store: Store): ZendeskStore {
  return {
    raw: store,
    apiTokens: store.collection<ZendeskApiToken>("zendesk.api_tokens", ["token"]),
    oauthTokens: store.collection<ZendeskOAuthToken>("zendesk.oauth_tokens", ["token"]),
    users: store.collection<ZendeskUser>("zendesk.users", ["zd_id", "email", "organization_id", "external_id"]),
    organizations: store.collection<ZendeskOrganization>("zendesk.organizations", ["zd_id", "external_id"]),
    organizationMemberships: store.collection<ZendeskOrganizationMembership>("zendesk.organization_memberships", [
      "zd_id",
      "user_id",
      "organization_id",
    ]),
    groups: store.collection<ZendeskGroup>("zendesk.groups", ["zd_id"]),
    groupMemberships: store.collection<ZendeskGroupMembership>("zendesk.group_memberships", [
      "zd_id",
      "user_id",
      "group_id",
    ]),
    tickets: store.collection<ZendeskTicket>("zendesk.tickets", [
      "zd_id",
      "requester_id",
      "assignee_id",
      "organization_id",
      "external_id",
    ]),
    comments: store.collection<ZendeskComment>("zendesk.comments", ["zd_id", "ticket_id", "audit_id"]),
    audits: store.collection<ZendeskAudit>("zendesk.audits", ["zd_id", "ticket_id"]),
    attachments: store.collection<ZendeskAttachment>("zendesk.attachments", ["zd_id", "token", "comment_id"]),
    ticketFields: store.collection<ZendeskTicketField>("zendesk.ticket_fields", ["zd_id", "type"]),
    customFields: store.collection<ZendeskCustomField>("zendesk.custom_fields", ["zd_id", "kind", "key"]),
    macros: store.collection<ZendeskMacro>("zendesk.macros", ["zd_id"]),
    triggers: store.collection<ZendeskTrigger>("zendesk.triggers", ["zd_id"]),
    views: store.collection<ZendeskView>("zendesk.views", ["zd_id"]),
    webhooks: store.collection<ZendeskWebhook>("zendesk.webhooks", ["zd_id"]),
    webhookInvocations: store.collection<ZendeskWebhookInvocation>("zendesk.webhook_invocations", [
      "zd_id",
      "webhook_id",
    ]),
    jobStatuses: store.collection<ZendeskJobStatus>("zendesk.job_statuses", ["zd_id"]),
    satisfactionRatings: store.collection<ZendeskSatisfactionRating>("zendesk.satisfaction_ratings", [
      "zd_id",
      "ticket_id",
    ]),
    customStatuses: store.collection<ZendeskCustomStatus>("zendesk.custom_statuses", ["zd_id", "status_category"]),
    brands: store.collection<ZendeskBrand>("zendesk.brands", ["zd_id"]),
    ticketForms: store.collection<ZendeskTicketForm>("zendesk.ticket_forms", ["zd_id"]),
    events: store.collection<ZendeskEventLog>("zendesk.events", ["zd_id", "type"]),
  };
}

const SUBDOMAIN_KEY = "zendesk.subdomain";
const ACCOUNT_ID_KEY = "zendesk.account_id";

export function subdomain(zs: ZendeskStore): string {
  return zs.raw.getData<string>(SUBDOMAIN_KEY) ?? "emulate-support";
}

export function setSubdomain(zs: ZendeskStore, value: string): void {
  zs.raw.setData(SUBDOMAIN_KEY, value);
}

export function accountId(zs: ZendeskStore): number {
  return zs.raw.getData<number>(ACCOUNT_ID_KEY) ?? 1;
}

export function setAccountId(zs: ZendeskStore, value: number): void {
  zs.raw.setData(ACCOUNT_ID_KEY, value);
}
