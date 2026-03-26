import type { Hono } from "hono";
import type { ServicePlugin, Store, WebhookDispatcher, TokenMap, AppEnv, RouteContext } from "@emulators/core";
import { getMicrosoftStore } from "./store.js";
import {
  createCalendarEventRecord,
  createCalendarRecord,
  createCategoryRecord,
  createDriveItemRecord,
  createMailFolderRecord,
  createMessageRecord,
  DEFAULT_TENANT_ID,
  ensureDefaultFolders,
  generateOid,
  seedDefaultMailbox,
} from "./helpers.js";
import { graphRoutes } from "./routes/graph.js";
import { oauthRoutes } from "./routes/oauth.js";

export { getMicrosoftStore, type MicrosoftStore } from "./store.js";
export * from "./entities.js";


export interface MicrosoftSeedConfig {
  port?: number;
  users?: Array<{
    email: string;
    name?: string;
    given_name?: string;
    family_name?: string;
    tenant_id?: string;
  }>;
  oauth_clients?: Array<{
    client_id: string;
    client_secret: string;
    name: string;
    redirect_uris: string[];
    tenant_id?: string;
  }>;
  categories?: Array<{
    id?: string;
    user_email?: string;
    display_name: string;
    color?: string;
  }>;
  folders?: Array<{
    id?: string;
    user_email?: string;
    display_name: string;
    parent_folder_id?: string | null;
    well_known_name?: string | null;
  }>;
  messages?: Array<{
    id?: string;
    conversation_id?: string;
    user_email?: string;
    subject?: string;
    body_content?: string;
    body_content_type?: "text" | "html";
    from?: { address: string; name?: string };
    to_recipients?: Array<{ address: string; name?: string }>;
    cc_recipients?: Array<{ address: string; name?: string }>;
    bcc_recipients?: Array<{ address: string; name?: string }>;
    reply_to?: Array<{ address: string; name?: string }>;
    received_date_time?: string;
    is_draft?: boolean;
    is_read?: boolean;
    importance?: "low" | "normal" | "high";
    categories?: string[];
    parent_folder_id?: string;
  }>;
  calendars?: Array<{
    id?: string;
    user_email?: string;
    name: string;
    color?: string | null;
    is_default_calendar?: boolean;
    can_edit?: boolean;
  }>;
  calendar_events?: Array<{
    id?: string;
    user_email?: string;
    calendar_id?: string;
    subject: string;
    body_preview?: string;
    start_date_time: string;
    end_date_time: string;
    is_all_day?: boolean;
    show_as?: "free" | "tentative" | "busy" | "oof" | "workingElsewhere" | "unknown";
    location_display_name?: string | null;
    web_link?: string | null;
    online_meeting_join_url?: string | null;
    online_meeting_url?: string | null;
    attendees?: Array<{ address: string; name?: string }>;
  }>;
  drive_items?: Array<{
    id?: string;
    user_email?: string;
    name: string;
    parent_id?: string | null;
    is_folder: boolean;
    mime_type?: string | null;
    content_bytes?: string | null;
  }>;
}

function seedDefaults(store: Store, baseUrl: string): void {
  const ms = getMicrosoftStore(store);
  const email = "testuser@outlook.com";

  if (!ms.users.findOneBy("email", email)) {
    ms.users.insert({
      oid: generateOid(),
      email,
      name: "Test User",
      given_name: "Test",
      family_name: "User",
      email_verified: true,
      tenant_id: DEFAULT_TENANT_ID,
      preferred_username: email,
    });
  }

  seedDefaultMailbox(ms, baseUrl, email);
}

export function seedFromConfig(store: Store, baseUrl: string, config: MicrosoftSeedConfig): void {
  const ms = getMicrosoftStore(store);
  const defaultEmail = config.users?.[0]?.email ?? "testuser@outlook.com";

  if (config.users) {
    for (const u of config.users) {
      const existing = ms.users.findOneBy("email", u.email);
      if (existing) continue;

      const nameParts = (u.name ?? "").split(/\s+/);
      ms.users.insert({
        oid: generateOid(),
        email: u.email,
        name: u.name ?? u.email.split("@")[0],
        given_name: u.given_name ?? nameParts[0] ?? "",
        family_name: u.family_name ?? nameParts.slice(1).join(" ") ?? "",
        email_verified: true,
        tenant_id: u.tenant_id ?? DEFAULT_TENANT_ID,
        preferred_username: u.email,
      });

      seedDefaultMailbox(ms, baseUrl, u.email);
    }
  }

  if (config.oauth_clients) {
    for (const client of config.oauth_clients) {
      const existing = ms.oauthClients.findOneBy("client_id", client.client_id);
      if (existing) continue;
      ms.oauthClients.insert({
        client_id: client.client_id,
        client_secret: client.client_secret,
        name: client.name,
        redirect_uris: client.redirect_uris,
        tenant_id: client.tenant_id ?? DEFAULT_TENANT_ID,
      });
    }
  }

  if (config.categories) {
    for (const category of config.categories) {
      createCategoryRecord(ms, {
        user_email: category.user_email ?? defaultEmail,
        display_name: category.display_name,
        color: category.color,
        microsoft_id: category.id,
      });
    }
  }

  if (config.folders) {
    for (const folder of config.folders) {
      createMailFolderRecord(ms, {
        user_email: folder.user_email ?? defaultEmail,
        display_name: folder.display_name,
        parent_folder_id: folder.parent_folder_id ?? null,
        well_known_name: folder.well_known_name ?? null,
        microsoft_id: folder.id,
      });
    }
  }

  if (config.messages) {
    for (const message of config.messages) {
      const userEmail = message.user_email ?? defaultEmail;
      const folders = ensureDefaultFolders(ms, userEmail);
      createMessageRecord(ms, {
        microsoft_id: message.id,
        conversation_id: message.conversation_id,
        user_email: userEmail,
        subject: message.subject,
        body_content: message.body_content,
        body_content_type: message.body_content_type,
        from: message.from,
        sender: message.from,
        to_recipients: message.to_recipients,
        cc_recipients: message.cc_recipients,
        bcc_recipients: message.bcc_recipients,
        reply_to: message.reply_to,
        received_date_time: message.received_date_time,
        is_draft: message.is_draft,
        is_read: message.is_read,
        importance: message.importance,
        categories: message.categories,
        parent_folder_id: message.parent_folder_id ?? (message.is_draft ? folders.drafts.microsoft_id : folders.inbox.microsoft_id),
        web_link_base: baseUrl,
      });
    }
  }

  if (config.calendars) {
    for (const calendar of config.calendars) {
      createCalendarRecord(ms, {
        microsoft_id: calendar.id,
        user_email: calendar.user_email ?? defaultEmail,
        name: calendar.name,
        color: calendar.color,
        is_default_calendar: calendar.is_default_calendar,
        can_edit: calendar.can_edit,
        owner_address: calendar.user_email ?? defaultEmail,
      });
    }
  }

  if (config.calendar_events) {
    for (const event of config.calendar_events) {
      createCalendarEventRecord(ms, {
        microsoft_id: event.id,
        user_email: event.user_email ?? defaultEmail,
        calendar_microsoft_id: event.calendar_id ?? "primary",
        subject: event.subject,
        body_preview: event.body_preview,
        start_date_time: event.start_date_time,
        end_date_time: event.end_date_time,
        is_all_day: event.is_all_day,
        show_as: event.show_as,
        location_display_name: event.location_display_name,
        web_link: event.web_link,
        online_meeting_join_url: event.online_meeting_join_url,
        online_meeting_url: event.online_meeting_url,
        attendees: event.attendees,
      });
    }
  }

  if (config.drive_items) {
    for (const item of config.drive_items) {
      createDriveItemRecord(ms, {
        microsoft_id: item.id,
        user_email: item.user_email ?? defaultEmail,
        name: item.name,
        parent_microsoft_id: item.parent_id ?? null,
        is_folder: item.is_folder,
        mime_type: item.mime_type,
        content_bytes: item.content_bytes,
        web_url_base: baseUrl,
      });
    }
  }
}

export const microsoftPlugin: ServicePlugin = {
  name: "microsoft",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    oauthRoutes(ctx);
    graphRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default microsoftPlugin;
