import type { Entity } from "@internal/core";

export interface MicrosoftUser extends Entity {
  /** Object ID (oid) — unique per-tenant user identifier */
  oid: string;
  email: string;
  name: string;
  given_name: string;
  family_name: string;
  email_verified: boolean;
  /** Microsoft tenant ID */
  tenant_id: string;
  /** User principal name (usually email) */
  preferred_username: string;
}

export interface MicrosoftOAuthClient extends Entity {
  client_id: string;
  client_secret: string;
  name: string;
  redirect_uris: string[];
  /** Tenant ID this app is registered in */
  tenant_id: string;
}

export interface MicrosoftMailFolder extends Entity {
  microsoft_id: string;
  user_email: string;
  display_name: string;
  parent_folder_id: string | null;
  child_folder_count: number;
  well_known_name: string | null;
  is_hidden: boolean;
}

export interface MicrosoftMessageAttachment extends Entity {
  microsoft_id: string;
  message_microsoft_id: string;
  user_email: string;
  name: string;
  content_type: string;
  size: number;
  content_bytes: string;
  is_inline: boolean;
  content_id: string | null;
}

export interface MicrosoftMessage extends Entity {
  microsoft_id: string;
  conversation_id: string;
  conversation_index: string;
  internet_message_id: string;
  user_email: string;
  subject: string;
  body_preview: string;
  body_content_type: "text" | "html";
  body_content: string;
  from_name: string | null;
  from_address: string | null;
  sender_name: string | null;
  sender_address: string | null;
  to_recipients: Array<{ name?: string | null; address: string }>;
  cc_recipients: Array<{ name?: string | null; address: string }>;
  bcc_recipients: Array<{ name?: string | null; address: string }>;
  reply_to: Array<{ name?: string | null; address: string }>;
  received_date_time: string;
  sent_date_time: string | null;
  created_date_time: string;
  last_modified_date_time: string;
  is_draft: boolean;
  is_read: boolean;
  importance: "low" | "normal" | "high";
  categories: string[];
  parent_folder_id: string;
  has_attachments: boolean;
  web_link: string;
  in_reply_to_microsoft_id: string | null;
}

export interface MicrosoftMasterCategory extends Entity {
  microsoft_id: string;
  user_email: string;
  display_name: string;
  color: string;
}

export interface MicrosoftMessageRule extends Entity {
  microsoft_id: string;
  user_email: string;
  display_name: string;
  sequence: number;
  is_enabled: boolean;
  conditions: {
    senderContains?: string[];
  };
  actions: {
    moveToFolder?: string;
    markAsRead?: boolean;
    assignCategories?: string[];
  };
}

export interface MicrosoftSubscription extends Entity {
  microsoft_id: string;
  user_email: string;
  change_type: string;
  notification_url: string;
  resource: string;
  expiration_date_time: string;
  client_state: string | null;
}

export interface MicrosoftCalendar extends Entity {
  microsoft_id: string;
  user_email: string;
  name: string;
  color: string | null;
  is_default_calendar: boolean;
  can_edit: boolean;
  owner_name: string | null;
  owner_address: string | null;
}

export interface MicrosoftCalendarEvent extends Entity {
  microsoft_id: string;
  calendar_microsoft_id: string;
  user_email: string;
  subject: string;
  body_preview: string;
  start_date_time: string;
  end_date_time: string;
  is_all_day: boolean;
  show_as: "free" | "tentative" | "busy" | "oof" | "workingElsewhere" | "unknown";
  location_display_name: string | null;
  web_link: string | null;
  online_meeting_join_url: string | null;
  online_meeting_url: string | null;
  attendees: Array<{ name?: string | null; address: string }>;
}

export interface MicrosoftDriveItem extends Entity {
  microsoft_id: string;
  user_email: string;
  name: string;
  parent_microsoft_id: string | null;
  is_folder: boolean;
  mime_type: string | null;
  size: number;
  web_url: string;
  created_date_time: string;
  last_modified_date_time: string;
  content_bytes: string | null;
  deleted: boolean;
}
