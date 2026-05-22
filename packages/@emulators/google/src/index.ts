export const serviceName = "google";
export const serviceLabel = "Google OAuth, Gmail, Calendar, and Drive";
export const runtime = "native-go";

export interface CompatEntity {
  id: number;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export type CompatInsertInput<T extends CompatEntity> = Omit<T, "id" | "created_at" | "updated_at"> & { id?: number };

export interface CompatQueryOptions<T> {
  filter?: (item: T) => boolean;
  sort?: (a: T, b: T) => number;
  page?: number;
  per_page?: number;
}

export interface CompatPaginatedResult<T> {
  items: T[];
  total_count: number;
  page: number;
  per_page: number;
  has_next: boolean;
  has_prev: boolean;
}

export interface CompatCollection<T extends CompatEntity = CompatEntity> {
  readonly fieldNames?: string[];
  insert(data: CompatInsertInput<T>): T;
  get(id: number): T | undefined;
  findBy(field: keyof T, value: T[keyof T] | string | number): T[];
  findOneBy(field: keyof T, value: T[keyof T] | string | number): T | undefined;
  update(id: number, data: Partial<T>): T | undefined;
  delete(id: number): boolean;
  all(): T[];
  query(options?: CompatQueryOptions<T>): CompatPaginatedResult<T>;
  count(filter?: (item: T) => boolean): number;
  clear(): void;
  snapshot(): unknown;
  restore(snapshot: unknown): void;
}

export interface CompatStoreSource {
  collection<T extends CompatEntity>(name: string, indexFields?: string[]): CompatCollection<T>;
}

export interface GoogleUser extends CompatEntity {
  [key: string]: unknown;
}
export interface GoogleOAuthClient extends CompatEntity {
  [key: string]: unknown;
}
export interface GoogleMessage extends CompatEntity {
  [key: string]: unknown;
}
export interface GoogleDraft extends CompatEntity {
  [key: string]: unknown;
}
export interface GoogleAttachment extends CompatEntity {
  [key: string]: unknown;
}
export interface GoogleHistoryEvent extends CompatEntity {
  [key: string]: unknown;
}
export interface GoogleLabel extends CompatEntity {
  [key: string]: unknown;
}
export interface GoogleFilter extends CompatEntity {
  [key: string]: unknown;
}
export interface GoogleForwardingAddress extends CompatEntity {
  [key: string]: unknown;
}
export interface GoogleSendAs extends CompatEntity {
  [key: string]: unknown;
}
export interface GoogleCalendar extends CompatEntity {
  [key: string]: unknown;
}
export interface GoogleCalendarEventAttendee {
  [key: string]: unknown;
}
export interface GoogleCalendarConferenceEntryPoint {
  [key: string]: unknown;
}
export interface GoogleCalendarEvent extends CompatEntity {
  [key: string]: unknown;
}
export interface GoogleDriveItem extends CompatEntity {
  [key: string]: unknown;
}

export interface GoogleSeedUser {
  [key: string]: unknown;
}

export interface GoogleSeedLabel {
  [key: string]: unknown;
}

export interface GoogleSeedMessage {
  [key: string]: unknown;
}

export interface GoogleSeedCalendar {
  [key: string]: unknown;
}

export interface GoogleSeedCalendarEvent {
  [key: string]: unknown;
}

export interface GoogleSeedDriveItem {
  [key: string]: unknown;
}

export interface GoogleSeedConfig {
  [key: string]: unknown;
}

export interface GoogleStore {
  users: CompatCollection<GoogleUser>;
  oauthClients: CompatCollection<GoogleOAuthClient>;
  messages: CompatCollection<GoogleMessage>;
  drafts: CompatCollection<GoogleDraft>;
  attachments: CompatCollection<GoogleAttachment>;
  history: CompatCollection<GoogleHistoryEvent>;
  labels: CompatCollection<GoogleLabel>;
  filters: CompatCollection<GoogleFilter>;
  forwardingAddresses: CompatCollection<GoogleForwardingAddress>;
  sendAs: CompatCollection<GoogleSendAs>;
  calendars: CompatCollection<GoogleCalendar>;
  calendarEvents: CompatCollection<GoogleCalendarEvent>;
  driveItems: CompatCollection<GoogleDriveItem>;
}

function compatCollection<T extends CompatEntity>(
  store: CompatStoreSource,
  name: string,
  indexFields: string[],
): CompatCollection<T> {
  return store.collection<T>(name, indexFields);
}

export function getGoogleStore(store: CompatStoreSource): GoogleStore {
  return {
    users: compatCollection<GoogleUser>(store, "google.users", ["uid", "email"]),
    oauthClients: compatCollection<GoogleOAuthClient>(store, "google.oauth_clients", ["client_id"]),
    messages: compatCollection<GoogleMessage>(store, "google.messages", ["gmail_id", "thread_id", "user_email"]),
    drafts: compatCollection<GoogleDraft>(store, "google.drafts", ["gmail_id", "message_gmail_id", "user_email"]),
    attachments: compatCollection<GoogleAttachment>(store, "google.attachments", [
      "gmail_id",
      "message_gmail_id",
      "user_email",
    ]),
    history: compatCollection<GoogleHistoryEvent>(store, "google.history", [
      "gmail_id",
      "message_gmail_id",
      "user_email",
    ]),
    labels: compatCollection<GoogleLabel>(store, "google.labels", ["gmail_id", "user_email", "name"]),
    filters: compatCollection<GoogleFilter>(store, "google.filters", ["gmail_id", "user_email"]),
    forwardingAddresses: compatCollection<GoogleForwardingAddress>(store, "google.forwarding_addresses", [
      "user_email",
      "forwarding_email",
    ]),
    sendAs: compatCollection<GoogleSendAs>(store, "google.send_as", ["user_email", "send_as_email"]),
    calendars: compatCollection<GoogleCalendar>(store, "google.calendars", ["google_id", "user_email"]),
    calendarEvents: compatCollection<GoogleCalendarEvent>(store, "google.calendar_events", [
      "google_id",
      "calendar_google_id",
      "user_email",
    ]),
    driveItems: compatCollection<GoogleDriveItem>(store, "google.drive_items", [
      "google_id",
      "user_email",
      "mime_type",
    ]),
  };
}

// Legacy public entity type augmentations.
export interface GoogleUser extends CompatEntity {
  uid: string;
  email: string;
  name: string;
  given_name: string;
  family_name: string;
  picture: string | null;
  email_verified: boolean;
  locale: string;
  hd: string | null;
}

export interface GoogleOAuthClient extends CompatEntity {
  client_id: string;
  client_secret: string;
  name: string;
  redirect_uris: string[];
}

export interface GoogleMessage extends CompatEntity {
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

export interface GoogleDraft extends CompatEntity {
  gmail_id: string;
  user_email: string;
  message_gmail_id: string;
}

export interface GoogleAttachment extends CompatEntity {
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

export interface GoogleHistoryEvent extends CompatEntity {
  gmail_id: string;
  user_email: string;
  change_type: "messageAdded" | "messageDeleted" | "labelAdded" | "labelRemoved";
  message_gmail_id: string;
  thread_id: string;
  label_ids: string[];
}

export interface GoogleLabel extends CompatEntity {
  gmail_id: string;
  user_email: string;
  name: string;
  type: "system" | "user";
  message_list_visibility: string | null;
  label_list_visibility: string | null;
  color_background: string | null;
  color_text: string | null;
}

export interface GoogleFilter extends CompatEntity {
  gmail_id: string;
  user_email: string;
  criteria_from: string | null;
  add_label_ids: string[];
  remove_label_ids: string[];
}

export interface GoogleForwardingAddress extends CompatEntity {
  user_email: string;
  forwarding_email: string;
  verification_status: string;
}

export interface GoogleSendAs extends CompatEntity {
  user_email: string;
  send_as_email: string;
  display_name: string | null;
  is_default: boolean;
  signature: string;
}

export interface GoogleCalendar extends CompatEntity {
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

export interface GoogleCalendarEvent extends CompatEntity {
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

export interface GoogleDriveItem extends CompatEntity {
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

// Legacy public seed config type augmentations.
export interface GoogleSeedUser {
  email: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  locale?: string;
  email_verified?: boolean;
  hd?: string;
}

export interface GoogleSeedLabel {
  id?: string;
  user_email?: string;
  name: string;
  type?: "system" | "user";
  message_list_visibility?: string;
  label_list_visibility?: string;
  color_background?: string;
  color_text?: string;
}

export interface GoogleSeedMessage {
  id?: string;
  thread_id?: string;
  user_email?: string;
  raw?: string;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  reply_to?: string;
  subject?: string;
  snippet?: string;
  body_text?: string;
  body_html?: string;
  label_ids?: string[];
  date?: string;
  internal_date?: string;
  message_id?: string;
  references?: string;
  in_reply_to?: string;
}

export interface GoogleSeedCalendar {
  id?: string;
  user_email?: string;
  summary: string;
  description?: string;
  time_zone?: string;
  primary?: boolean;
  selected?: boolean;
  access_role?: string;
}

export interface GoogleSeedCalendarEvent {
  id?: string;
  user_email?: string;
  calendar_id?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start_date_time?: string;
  start_date?: string;
  end_date_time?: string;
  end_date?: string;
  attendees?: Array<{
    email: string;
    display_name?: string;
  }>;
  conference_entry_points?: Array<{
    entry_point_type: string;
    uri: string;
    label?: string;
  }>;
  hangout_link?: string;
}

export interface GoogleSeedDriveItem {
  id?: string;
  user_email?: string;
  name: string;
  mime_type: string;
  parent_ids?: string[];
  data?: string;
}

export interface GoogleSeedConfig {
  port?: number;
  users?: GoogleSeedUser[];
  oauth_clients?: Array<{
    client_id: string;
    client_secret: string;
    name?: string;
    redirect_uris: string[];
  }>;
  labels?: GoogleSeedLabel[];
  messages?: GoogleSeedMessage[];
  calendars?: GoogleSeedCalendar[];
  calendar_events?: GoogleSeedCalendarEvent[];
  drive_items?: GoogleSeedDriveItem[];
}
export const service = {
  name: serviceName,
  label: serviceLabel,
  runtime,
} as const;

export const plugin = {
  ...service,
  register(): void {
    return undefined;
  },
  seed(): void {
    return undefined;
  },
} as const;

export const googlePlugin = plugin;

export function seedFromConfig(_store?: unknown, _baseUrl?: string, _config?: GoogleSeedConfig): void {
  throw new Error(
    "seedFromConfig is no longer supported by native compatibility facade packages. Pass seed data to createEmulateHandler or createEmulator instead.",
  );
}

export function createAppKeyResolver(): undefined {
  return undefined;
}

export default plugin;
