import type { Entity } from "@emulators/core";

export type EventType =
  | "accepted"
  | "rejected"
  | "delivered"
  | "failed"
  | "opened"
  | "clicked"
  | "unsubscribed"
  | "complained"
  | "stored";

export type WebhookType =
  | "accepted"
  | "delivered"
  | "opened"
  | "clicked"
  | "unsubscribed"
  | "complained"
  | "permanent_fail"
  | "temporary_fail";

export type SuppressionKind = "bounce" | "unsubscribe" | "complaint" | "whitelist";

export interface MailgunApiKey extends Entity {
  key: string;
  kind: "account" | "domain";
  domain: string | null;
  description: string;
}

export interface MailgunDomain extends Entity {
  name: string;
  type: "custom" | "sandbox";
  state: "active" | "unverified" | "disabled";
  smtp_password: string;
  spam_action: "disabled" | "block" | "tag";
  wildcard: boolean;
  web_scheme: "http" | "https";
  web_prefix: string;
  require_tls: boolean;
  skip_verification: boolean;
  is_disabled: boolean;
  tracking: { open: boolean; click: boolean; unsubscribe: boolean };
  authorized_recipients: string[];
  dkim_key_size: number;
}

export interface MailgunAttachment {
  name: string;
  content_type: string;
  size: number;
  content: string;
  inline: boolean;
}

export interface MailgunMessage extends Entity {
  key: string;
  message_id: string;
  domain: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  recipients: string[];
  subject: string;
  text: string | null;
  html: string | null;
  amp_html: string | null;
  headers: Record<string, string>;
  variables: Record<string, unknown>;
  recipient_variables: Record<string, Record<string, unknown>> | null;
  tags: string[];
  template: string | null;
  test_mode: boolean;
  scheduled_for: number | null;
  attachments: MailgunAttachment[];
  size: number;
  direction: "outbound" | "inbound";
  raw_mime: string | null;
}

export interface MailgunEvent extends Entity {
  event_id: string;
  event: EventType;
  timestamp: number;
  domain: string;
  recipient: string;
  message_key: string | null;
  message_id: string;
  from: string;
  to: string;
  subject: string;
  tags: string[];
  severity: "permanent" | "temporary" | null;
  reason: string | null;
  code: number | null;
  description: string | null;
  log_level: "info" | "warn" | "error";
  user_variables: Record<string, unknown>;
  url: string | null;
  ip: string | null;
  client_info: Record<string, string> | null;
  test_mode: boolean;
  size: number;
}

export interface MailgunWebhook extends Entity {
  domain: string;
  type: WebhookType;
  urls: string[];
}

export interface MailgunWebhookDelivery extends Entity {
  domain: string;
  type: WebhookType;
  url: string;
  event_id: string;
  status_code: number | null;
  success: boolean;
  error: string | null;
  body: string;
}

export interface MailgunSuppression extends Entity {
  domain: string;
  kind: SuppressionKind;
  address: string;
  code: string | null;
  error: string | null;
  tags: string[];
  reason: string | null;
  type: "address" | "domain";
}

export interface MailgunList extends Entity {
  address: string;
  name: string;
  description: string;
  access_level: "readonly" | "members" | "everyone";
  reply_preference: "list" | "sender";
}

export interface MailgunMember extends Entity {
  list_address: string;
  address: string;
  name: string;
  subscribed: boolean;
  vars: Record<string, unknown>;
}

export interface MailgunTemplate extends Entity {
  domain: string;
  name: string;
  description: string;
  created_by: string;
}

export interface MailgunTemplateVersion extends Entity {
  domain: string;
  template_name: string;
  version_id: string;
  tag: string;
  engine: "handlebars" | "go";
  comment: string;
  active: boolean;
  content: string;
  headers: Record<string, string>;
}

export interface MailgunTag extends Entity {
  domain: string;
  tag: string;
  description: string;
  first_seen: string;
  last_seen: string;
}

export interface MailgunRoute extends Entity {
  route_id: string;
  priority: number;
  description: string;
  expression: string;
  actions: string[];
}

export interface MailgunCredential extends Entity {
  domain: string;
  login: string;
  password: string;
}

export interface MailgunRouteDelivery extends Entity {
  route_id: string;
  action: string;
  url: string;
  status_code: number | null;
  success: boolean;
  error: string | null;
  recipient: string;
  message_key: string;
}
