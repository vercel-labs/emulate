import { Store, type Collection } from "@emulators/core";
import type {
  GoogleUser,
  GoogleOAuthClient,
  GoogleMessage,
  GoogleDraft,
  GoogleAttachment,
  GoogleHistoryEvent,
  GoogleLabel,
  GoogleFilter,
  GoogleForwardingAddress,
  GoogleSendAs,
  GoogleCalendar,
  GoogleCalendarEvent,
  GoogleDriveItem,
} from "./entities.js";

export interface GoogleStore {
  users: Collection<GoogleUser>;
  oauthClients: Collection<GoogleOAuthClient>;
  messages: Collection<GoogleMessage>;
  drafts: Collection<GoogleDraft>;
  attachments: Collection<GoogleAttachment>;
  history: Collection<GoogleHistoryEvent>;
  labels: Collection<GoogleLabel>;
  filters: Collection<GoogleFilter>;
  forwardingAddresses: Collection<GoogleForwardingAddress>;
  sendAs: Collection<GoogleSendAs>;
  calendars: Collection<GoogleCalendar>;
  calendarEvents: Collection<GoogleCalendarEvent>;
  driveItems: Collection<GoogleDriveItem>;
}

export function getGoogleStore(store: Store): GoogleStore {
  return {
    users: store.collection<GoogleUser>("google.users", ["uid", "email"]),
    oauthClients: store.collection<GoogleOAuthClient>("google.oauth_clients", ["client_id"]),
    messages: store.collection<GoogleMessage>("google.messages", ["gmail_id", "thread_id", "user_email"]),
    drafts: store.collection<GoogleDraft>("google.drafts", ["gmail_id", "message_gmail_id", "user_email"]),
    attachments: store.collection<GoogleAttachment>("google.attachments", ["gmail_id", "message_gmail_id", "user_email"]),
    history: store.collection<GoogleHistoryEvent>("google.history", ["gmail_id", "message_gmail_id", "user_email"]),
    labels: store.collection<GoogleLabel>("google.labels", ["gmail_id", "user_email", "name"]),
    filters: store.collection<GoogleFilter>("google.filters", ["gmail_id", "user_email"]),
    forwardingAddresses: store.collection<GoogleForwardingAddress>("google.forwarding_addresses", ["user_email", "forwarding_email"]),
    sendAs: store.collection<GoogleSendAs>("google.send_as", ["user_email", "send_as_email"]),
    calendars: store.collection<GoogleCalendar>("google.calendars", ["google_id", "user_email"]),
    calendarEvents: store.collection<GoogleCalendarEvent>("google.calendar_events", ["google_id", "calendar_google_id", "user_email"]),
    driveItems: store.collection<GoogleDriveItem>("google.drive_items", ["google_id", "user_email", "mime_type"]),
  };
}
