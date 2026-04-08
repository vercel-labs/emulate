import type { Entity } from "@emulators/core";

export interface TwilioMessage extends Entity {
  sid: string;
  account_sid: string;
  to: string;
  from: string;
  body: string;
  status: "queued" | "sent" | "delivered" | "failed";
  direction: "outbound-api" | "inbound";
  num_segments: number;
  date_sent: string;
}

export interface TwilioCall extends Entity {
  sid: string;
  account_sid: string;
  to: string;
  from: string;
  status: "queued" | "ringing" | "in-progress" | "completed" | "failed";
  direction: "outbound-api" | "inbound";
  duration: number | null;
  start_time: string | null;
  end_time: string | null;
}

export interface TwilioVerifyService extends Entity {
  sid: string;
  friendly_name: string;
  code_length: number;
}

export interface TwilioVerification extends Entity {
  sid: string;
  service_sid: string;
  to: string;
  channel: "sms" | "email" | "call";
  status: "pending" | "approved" | "canceled" | "expired";
  code: string;
  expires_at: string;
}

export interface TwilioPhoneNumber extends Entity {
  sid: string;
  account_sid: string;
  phone_number: string;
  friendly_name: string;
}
