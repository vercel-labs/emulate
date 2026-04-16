import type { Entity } from "@emulators/core";

export interface ResendEmail extends Entity {
  uuid: string;
  from: string;
  to: string[];
  subject: string;
  html: string | null;
  text: string | null;
  cc: string[];
  bcc: string[];
  reply_to: string[];
  headers: Record<string, string>;
  tags: Array<{ name: string; value: string }>;
  status: "sent" | "delivered" | "bounced" | "canceled" | "scheduled";
  scheduled_at: string | null;
  last_event: string;
}

export interface ResendDomain extends Entity {
  uuid: string;
  name: string;
  status: "pending" | "verified";
  region: string;
  records: Array<{
    record: string;
    name: string;
    type: string;
    ttl: string;
    status: "pending" | "verified";
    value: string;
    priority?: number;
  }>;
}

export interface ResendApiKey extends Entity {
  uuid: string;
  name: string;
  token: string;
}

export interface ResendAudience extends Entity {
  uuid: string;
  name: string;
}

export interface ResendContact extends Entity {
  uuid: string;
  audience_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  unsubscribed: boolean;
}
