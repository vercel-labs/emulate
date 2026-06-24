import type { Entity } from "@emulators/core";

export type TwilioAccountStatus = "active" | "suspended" | "closed";
export type TwilioMessageDirection = "inbound" | "outbound-api" | "outbound-call" | "outbound-reply";
export type TwilioMessageStatus =
  | "accepted"
  | "scheduled"
  | "canceled"
  | "queued"
  | "sending"
  | "sent"
  | "failed"
  | "delivered"
  | "undelivered"
  | "receiving"
  | "received"
  | "read";
export type TwilioVerificationStatus =
  | "pending"
  | "approved"
  | "canceled"
  | "max_attempts_reached"
  | "deleted"
  | "failed"
  | "expired";
export type TwilioCallStatus =
  | "queued"
  | "ringing"
  | "in-progress"
  | "completed"
  | "busy"
  | "failed"
  | "no-answer"
  | "canceled";
export type TwilioCallDirection = "inbound" | "outbound-api" | "outbound-dial" | "outbound-call";

export interface TwilioAccount extends Entity {
  sid: string;
  friendly_name: string;
  auth_token: string;
  status: TwilioAccountStatus;
  owner_account_sid: string | null;
}

export interface TwilioApiKey extends Entity {
  sid: string;
  account_sid: string;
  secret: string;
  friendly_name: string;
  active: boolean;
}

export interface TwilioApplication extends Entity {
  sid: string;
  account_sid: string;
  friendly_name: string;
  sms_url: string | null;
  sms_method: string;
  voice_url: string | null;
  voice_method: string;
  status_callback: string | null;
}

export interface TwilioIncomingPhoneNumber extends Entity {
  sid: string;
  account_sid: string;
  phone_number: string;
  friendly_name: string;
  capabilities: {
    sms: boolean;
    mms: boolean;
    voice: boolean;
  };
  sms_url: string | null;
  sms_method: string;
  voice_url: string | null;
  voice_method: string;
  status_callback: string | null;
  application_sid: string | null;
}

export interface TwilioMessagingService extends Entity {
  sid: string;
  account_sid: string;
  friendly_name: string;
  inbound_request_url: string | null;
  status_callback: string | null;
}

export interface TwilioMessagingServicePhoneNumber extends Entity {
  sid: string;
  account_sid: string;
  service_sid: string;
  phone_number_sid: string;
}

export interface TwilioMessage extends Entity {
  sid: string;
  account_sid: string;
  to: string;
  from: string | null;
  body: string | null;
  direction: TwilioMessageDirection;
  status: TwilioMessageStatus;
  messaging_service_sid: string | null;
  num_segments: string;
  num_media: string;
  media_urls: string[];
  error_code: number | null;
  error_message: string | null;
  price: string | null;
  price_unit: string;
  api_version: string;
  status_callback: string | null;
  date_sent: string | null;
}

export interface TwilioMedia extends Entity {
  sid: string;
  account_sid: string;
  message_sid: string;
  content_type: string;
  uri: string;
}

export interface TwilioVerifyService extends Entity {
  sid: string;
  account_sid: string;
  friendly_name: string;
  code: string;
  default_channel: string;
}

export interface TwilioVerification extends Entity {
  sid: string;
  service_sid: string;
  account_sid: string;
  to: string;
  channel: string;
  status: TwilioVerificationStatus;
  code: string;
  attempts: number;
  max_attempts: number;
  lookup: Record<string, unknown>;
  send_code_attempts: Array<Record<string, unknown>>;
  tags: string | null;
  valid: boolean;
}

export interface TwilioCall extends Entity {
  sid: string;
  account_sid: string;
  to: string;
  from: string;
  status: TwilioCallStatus;
  direction: TwilioCallDirection;
  api_version: string;
  price: string | null;
  price_unit: string;
  parent_call_sid: string | null;
  phone_number_sid: string | null;
  start_time: string | null;
  end_time: string | null;
  duration: string;
  url: string | null;
  method: string;
  twiml: string | null;
  twiml_steps: string[];
  status_callback: string | null;
  status_callback_event: string[];
}

export interface TwilioWebhookDelivery extends Entity {
  twilio_id: string;
  account_sid: string;
  event: string;
  url: string;
  method: string;
  request_body: Record<string, string>;
  request_headers: Record<string, string>;
  response_status: number | null;
  response_body: string | null;
  success: boolean;
  error: string | null;
}

export interface TwilioConversationService extends Entity {
  sid: string;
  account_sid: string;
  friendly_name: string;
}

export interface TwilioConversation extends Entity {
  sid: string;
  account_sid: string;
  service_sid: string;
  friendly_name: string | null;
  unique_name: string | null;
  state: "active" | "inactive" | "closed";
  attributes: string;
}

export interface TwilioConversationParticipant extends Entity {
  sid: string;
  account_sid: string;
  service_sid: string;
  conversation_sid: string;
  identity: string | null;
  messaging_binding_address: string | null;
  messaging_binding_proxy_address: string | null;
  attributes: string;
}

export interface TwilioConversationMessage extends Entity {
  sid: string;
  account_sid: string;
  service_sid: string;
  conversation_sid: string;
  author: string | null;
  body: string | null;
  index: number;
  attributes: string;
}
