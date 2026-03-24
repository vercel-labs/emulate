import type { Entity } from "@internal/core";

export interface ResendEmail extends Entity {
  from: string;
  to: string[];
  subject: string;
  html: string | null;
  text: string | null;
  cc: string[] | null;
  bcc: string[] | null;
  reply_to: string[] | null;
  headers: Record<string, string> | null;
  tags: Array<{ name: string; value: string }> | null;
  scheduled_at: string | null;
  last_event:
    | "queued"
    | "scheduled"
    | "sent"
    | "delivered"
    | "bounced"
    | "canceled"
    | "clicked"
    | "complained"
    | "delivery_delayed"
    | "failed"
    | "opened";
}

export interface ResendDomain extends Entity {
  name: string;
  status:
    | "not_started"
    | "pending"
    | "verified"
    | "failed"
    | "temporary_failure";
  region: "us-east-1" | "eu-west-1" | "sa-east-1" | "ap-northeast-1";
  click_tracking: boolean;
  open_tracking: boolean;
  tls: "opportunistic" | "enforced";
  records: Array<{
    record: string;
    name: string;
    type: string;
    ttl: string;
    status: string;
    value: string;
    priority?: number;
  }>;
}

export interface ResendApiKey extends Entity {
  name: string;
  token: string;
  permission: "full_access" | "sending_access";
  domain_id: string | null;
  last_used_at: string | null;
}

export interface ResendContact extends Entity {
  email: string;
  first_name: string | null;
  last_name: string | null;
  unsubscribed: boolean;
  properties: Record<string, unknown> | null;
}

export interface ResendAudience extends Entity {
  name: string;
}

export interface ResendWebhook extends Entity {
  endpoint: string;
  events: string[];
  status: "enabled" | "disabled";
  signing_secret: string;
}
