import type { Entity } from "@emulators/core";

export const REGIONS = ["fr-par", "nl-ams", "pl-waw"] as const;
export type Region = (typeof REGIONS)[number];

export const EMAIL_STATUSES = ["new", "sending", "sent", "failed", "canceled"] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

export const RCPT_TYPES = ["to", "cc", "bcc"] as const;
export type RcptType = (typeof RCPT_TYPES)[number];

export const EMAIL_FLAGS = [
  "soft_bounce",
  "hard_bounce",
  "spam",
  "mailbox_full",
  "mailbox_not_found",
  "greylisted",
  "send_before_expiration",
  "blocklisted",
] as const;
export type EmailFlag = (typeof EMAIL_FLAGS)[number];

export const DOMAIN_STATUSES = [
  "unchecked",
  "checked",
  "invalid",
  "locked",
  "revoked",
  "pending",
  "autoconfiguring",
] as const;
export type DomainStatus = (typeof DOMAIN_STATUSES)[number];

export const WEBHOOK_EVENT_TYPES = [
  "email_queued",
  "email_dropped",
  "email_deferred",
  "email_delivered",
  "email_spam",
  "email_mailbox_not_found",
  "email_blocklisted",
  "blocklist_created",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const BLOCKLIST_TYPES = ["mailbox_full", "mailbox_not_found"] as const;
export type BlocklistType = (typeof BLOCKLIST_TYPES)[number];

export interface ScwApiKey extends Entity {
  secret_key: string;
  access_key: string;
  name: string;
  project_ids: string[] | null;
}

export interface ScwProject extends Entity {
  project_id: string;
  organization_id: string;
  name: string;
}

export interface ScwDomain extends Entity {
  domain_id: string;
  organization_id: string;
  project_id: string;
  name: string;
  status: DomainStatus;
  region: Region;
  created_at_iso: string;
  next_check_at: string;
  last_valid_at: string | null;
  revoked_at: string | null;
  last_error: string | null;
  spf_config: string;
  dkim_config: string;
  dkim_selector: string;
  autoconfig: boolean;
  reputation_score: number;
}

export interface EmailTry {
  rank: number;
  tried_at: string;
  code: number;
  message: string;
}

export interface ScwEmail extends Entity {
  email_id: string;
  message_id: string;
  project_id: string;
  domain_id: string | null;
  region: Region;
  mail_from: string;
  from_name: string | null;
  mail_rcpt: string;
  rcpt_name: string | null;
  rcpt_type: RcptType;
  subject: string;
  text: string;
  html: string;
  attachments: Array<{ name: string; type: string; size: number }>;
  additional_headers: Array<{ key: string; value: string }>;
  send_before: string | null;
  created_at_iso: string;
  status_override: EmailStatus | null;
  status_override_at: string | null;
  status_details: string | null;
  flags: EmailFlag[];
  tries: EmailTry[];
  delivered_event_sent: boolean;
  delivery_delay_ms: number;
}

export interface ScwWebhook extends Entity {
  webhook_id: string;
  domain_id: string;
  organization_id: string;
  project_id: string;
  name: string;
  event_types: WebhookEventType[];
  sns_arn: string;
}

export interface ScwWebhookEvent extends Entity {
  event_id: string;
  webhook_id: string;
  organization_id: string;
  project_id: string;
  domain_id: string;
  type: WebhookEventType;
  status: "sending" | "sent" | "failed";
  data: string;
  email_id: string | null;
}

export interface ScwBlocklist extends Entity {
  blocklist_id: string;
  domain_id: string;
  email: string;
  type: BlocklistType;
  reason: string;
  custom: boolean;
  ends_at: string;
}

export interface ScwEventLog extends Entity {
  type: string;
  subject: string;
  detail: Record<string, unknown>;
}
