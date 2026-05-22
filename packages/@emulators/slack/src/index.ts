export const serviceName = "slack";
export const serviceLabel = "Slack Web API, OAuth, and webhooks";
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

export interface SlackTeam extends CompatEntity {
  [key: string]: unknown;
}
export interface SlackUser extends CompatEntity {
  [key: string]: unknown;
}
export interface SlackChannel extends CompatEntity {
  [key: string]: unknown;
}
export interface SlackMessage extends CompatEntity {
  [key: string]: unknown;
}
export interface SlackBot extends CompatEntity {
  [key: string]: unknown;
}
export interface SlackOAuthApp extends CompatEntity {
  [key: string]: unknown;
}
export interface SlackIncomingWebhook extends CompatEntity {
  [key: string]: unknown;
}

export interface SlackSeedConfig {
  [key: string]: unknown;
}

export interface SlackStore {
  teams: CompatCollection<SlackTeam>;
  users: CompatCollection<SlackUser>;
  channels: CompatCollection<SlackChannel>;
  messages: CompatCollection<SlackMessage>;
  bots: CompatCollection<SlackBot>;
  oauthApps: CompatCollection<SlackOAuthApp>;
  incomingWebhooks: CompatCollection<SlackIncomingWebhook>;
}

function compatCollection<T extends CompatEntity>(
  store: CompatStoreSource,
  name: string,
  indexFields: string[],
): CompatCollection<T> {
  return store.collection<T>(name, indexFields);
}

export function getSlackStore(store: CompatStoreSource): SlackStore {
  return {
    teams: compatCollection<SlackTeam>(store, "slack.teams", ["team_id"]),
    users: compatCollection<SlackUser>(store, "slack.users", ["user_id", "email"]),
    channels: compatCollection<SlackChannel>(store, "slack.channels", ["channel_id", "name"]),
    messages: compatCollection<SlackMessage>(store, "slack.messages", ["ts", "channel_id"]),
    bots: compatCollection<SlackBot>(store, "slack.bots", ["bot_id"]),
    oauthApps: compatCollection<SlackOAuthApp>(store, "slack.oauth_apps", ["client_id"]),
    incomingWebhooks: compatCollection<SlackIncomingWebhook>(store, "slack.incoming_webhooks", ["token"]),
  };
}

// Legacy public entity type augmentations.
export interface SlackTeam extends CompatEntity {
  team_id: string;
  name: string;
  domain: string;
}

export interface SlackUser extends CompatEntity {
  user_id: string;
  team_id: string;
  name: string;
  real_name: string;
  email: string;
  is_admin: boolean;
  is_bot: boolean;
  deleted: boolean;
  profile: {
    display_name: string;
    real_name: string;
    email: string;
    image_48: string;
    image_192: string;
  };
}

export interface SlackChannel extends CompatEntity {
  channel_id: string;
  team_id: string;
  name: string;
  is_channel: boolean;
  is_private: boolean;
  is_archived: boolean;
  topic: { value: string; creator: string; last_set: number };
  purpose: { value: string; creator: string; last_set: number };
  members: string[];
  creator: string;
  num_members: number;
}

export interface SlackMessage extends CompatEntity {
  ts: string;
  channel_id: string;
  user: string;
  text: string;
  type: "message";
  subtype?: string;
  thread_ts?: string;
  reply_count: number;
  reply_users: string[];
  reactions: Array<{ name: string; users: string[]; count: number }>;
}

export interface SlackBot extends CompatEntity {
  bot_id: string;
  name: string;
  deleted: boolean;
  icons: { image_48: string };
}

export interface SlackOAuthApp extends CompatEntity {
  client_id: string;
  client_secret: string;
  name: string;
  redirect_uris: string[];
}

export interface SlackIncomingWebhook extends CompatEntity {
  token: string;
  team_id: string;
  bot_id: string;
  default_channel: string;
  label: string;
  url: string;
}

// Legacy public seed config type augmentations.
export interface SlackSeedConfig {
  port?: number;
  team?: {
    name?: string;
    domain?: string;
  };
  users?: Array<{
    name: string;
    real_name?: string;
    email?: string;
    is_admin?: boolean;
  }>;
  channels?: Array<{
    name: string;
    topic?: string;
    purpose?: string;
    is_private?: boolean;
  }>;
  bots?: Array<{
    name: string;
  }>;
  oauth_apps?: Array<{
    client_id: string;
    client_secret: string;
    name: string;
    redirect_uris: string[];
  }>;
  incoming_webhooks?: Array<{
    channel: string;
    label?: string;
  }>;
  signing_secret?: string;
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

export const slackPlugin = plugin;

export function seedFromConfig(_store?: unknown, _baseUrl?: string, _config?: SlackSeedConfig): void {
  throw new Error(
    "seedFromConfig is no longer supported by native compatibility facade packages. Pass seed data to createEmulateHandler or createEmulator instead.",
  );
}

export function createAppKeyResolver(): undefined {
  return undefined;
}

export default plugin;
