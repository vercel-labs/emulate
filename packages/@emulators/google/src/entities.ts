import type { Entity } from "@emulators/core";

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

export interface GoogleDraft extends Entity {
  gmail_id: string;
  user_email: string;
  message_gmail_id: string;
}

export interface GoogleAttachment extends Entity {
  gmail_id: string;
  user_email: string;
  message_gmail_id: string;
  filename: string;
  mime_type: string;
  disposition: string | null;
  content_id: string | null;
  transfer_encoding: string | null;
  data: string;
  size: number;
}

export interface GoogleHistoryEvent extends Entity {
  gmail_id: string;
  user_email: string;
  change_type: "messageAdded" | "messageDeleted" | "labelAdded" | "labelRemoved";
  message_gmail_id: string;
  thread_id: string;
  label_ids: string[];
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

export interface GoogleFilter extends Entity {
  gmail_id: string;
  user_email: string;
  criteria_from: string | null;
  add_label_ids: string[];
  remove_label_ids: string[];
}

export interface GoogleForwardingAddress extends Entity {
  user_email: string;
  forwarding_email: string;
  verification_status: string;
}

export interface GoogleSendAs extends Entity {
  user_email: string;
  send_as_email: string;
  display_name: string | null;
  is_default: boolean;
  signature: string;
}

export interface GoogleCalendar extends Entity {
  google_id: string;
  user_email: string;
  summary: string;
  description: string | null;
  time_zone: string;
  primary: boolean;
  selected: boolean;
  access_role: string;
  background_color: string | null;
  foreground_color: string | null;
}

export interface GoogleCalendarEventAttendee {
  email: string;
  display_name: string | null;
  response_status: string | null;
  organizer: boolean;
  self: boolean;
}

export interface GoogleCalendarConferenceEntryPoint {
  entry_point_type: string;
  uri: string;
  label: string | null;
}

export interface GoogleCalendarEvent extends Entity {
  google_id: string;
  user_email: string;
  calendar_google_id: string;
  status: string;
  summary: string;
  description: string | null;
  location: string | null;
  html_link: string | null;
  hangout_link: string | null;
  start_date_time: string | null;
  start_date: string | null;
  end_date_time: string | null;
  end_date: string | null;
  attendees: GoogleCalendarEventAttendee[];
  conference_entry_points: GoogleCalendarConferenceEntryPoint[];
  transparency: string | null;
}

export interface GoogleDriveItem extends Entity {
  google_id: string;
  user_email: string;
  name: string;
  mime_type: string;
  parent_google_ids: string[];
  web_view_link: string | null;
  size: number | null;
  trashed: boolean;
  data: string | null;
}
