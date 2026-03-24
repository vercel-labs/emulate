import type { Entity } from "@internal/core";

export interface GoogleUser extends Entity {
  uid: string;
  email: string;
  name: string;
  given_name: string;
  family_name: string;
  picture: string | null;
  email_verified: boolean;
  locale: string;
}

export interface GoogleOAuthClient extends Entity {
  client_id: string;
  client_secret: string;
  name: string;
  redirect_uris: string[];
}

export interface GoogleMessage extends Entity {
  gmail_id: string;
  thread_id: string;
  user_email: string;
  history_id: string;
  internal_date: string;
  raw: string | null;
  label_ids: string[];
  snippet: string;
  subject: string;
  from: string;
  to: string;
  cc: string | null;
  bcc: string | null;
  reply_to: string | null;
  message_id: string;
  references: string | null;
  in_reply_to: string | null;
  date_header: string;
  body_text: string | null;
  body_html: string | null;
}

export interface GoogleLabel extends Entity {
  gmail_id: string;
  user_email: string;
  name: string;
  type: "system" | "user";
  message_list_visibility: string | null;
  label_list_visibility: string | null;
  color_background: string | null;
  color_text: string | null;
}
