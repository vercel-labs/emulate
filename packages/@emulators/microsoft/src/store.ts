import { Store, type Collection } from "@emulators/core";
import type {
  MicrosoftCalendar,
  MicrosoftCalendarEvent,
  MicrosoftDriveItem,
  MicrosoftMailFolder,
  MicrosoftMasterCategory,
  MicrosoftMessage,
  MicrosoftMessageAttachment,
  MicrosoftMessageRule,
  MicrosoftOAuthClient,
  MicrosoftSubscription,
  MicrosoftUser,
} from "./entities.js";

export interface MicrosoftStore {
  users: Collection<MicrosoftUser>;
  oauthClients: Collection<MicrosoftOAuthClient>;
  mailFolders: Collection<MicrosoftMailFolder>;
  messages: Collection<MicrosoftMessage>;
  attachments: Collection<MicrosoftMessageAttachment>;
  categories: Collection<MicrosoftMasterCategory>;
  messageRules: Collection<MicrosoftMessageRule>;
  subscriptions: Collection<MicrosoftSubscription>;
  calendars: Collection<MicrosoftCalendar>;
  calendarEvents: Collection<MicrosoftCalendarEvent>;
  driveItems: Collection<MicrosoftDriveItem>;
}

export function getMicrosoftStore(store: Store): MicrosoftStore {
  return {
    users: store.collection<MicrosoftUser>("microsoft.users", ["oid", "email"]),
    oauthClients: store.collection<MicrosoftOAuthClient>("microsoft.oauth_clients", ["client_id"]),
    mailFolders: store.collection<MicrosoftMailFolder>("microsoft.mail_folders", [
      "microsoft_id",
      "user_email",
      "well_known_name",
      "parent_folder_id",
    ]),
    messages: store.collection<MicrosoftMessage>("microsoft.messages", [
      "microsoft_id",
      "conversation_id",
      "user_email",
      "parent_folder_id",
      "internet_message_id",
    ]),
    attachments: store.collection<MicrosoftMessageAttachment>("microsoft.attachments", [
      "microsoft_id",
      "message_microsoft_id",
      "user_email",
    ]),
    categories: store.collection<MicrosoftMasterCategory>("microsoft.categories", [
      "microsoft_id",
      "user_email",
      "display_name",
    ]),
    messageRules: store.collection<MicrosoftMessageRule>("microsoft.message_rules", [
      "microsoft_id",
      "user_email",
    ]),
    subscriptions: store.collection<MicrosoftSubscription>("microsoft.subscriptions", [
      "microsoft_id",
      "user_email",
    ]),
    calendars: store.collection<MicrosoftCalendar>("microsoft.calendars", [
      "microsoft_id",
      "user_email",
    ]),
    calendarEvents: store.collection<MicrosoftCalendarEvent>("microsoft.calendar_events", [
      "microsoft_id",
      "calendar_microsoft_id",
      "user_email",
    ]),
    driveItems: store.collection<MicrosoftDriveItem>("microsoft.drive_items", [
      "microsoft_id",
      "user_email",
      "parent_microsoft_id",
    ]),
  };
}
