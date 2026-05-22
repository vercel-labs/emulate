export const serviceName = "okta";
export const serviceLabel = "Okta identity provider and management API";
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

export type OktaUserStatus = "STAGED" | "PROVISIONED" | "ACTIVE" | "SUSPENDED" | "DEPROVISIONED";
export type OktaGroupType = "OKTA_GROUP" | "BUILT_IN";
export type OktaAppStatus = "ACTIVE" | "INACTIVE";
export type OktaAuthorizationServerStatus = "ACTIVE" | "INACTIVE";

export interface OktaUser extends CompatEntity {
  [key: string]: unknown;
}
export interface OktaGroup extends CompatEntity {
  [key: string]: unknown;
}
export interface OktaApp extends CompatEntity {
  [key: string]: unknown;
}
export interface OktaOAuthClient extends CompatEntity {
  [key: string]: unknown;
}
export interface OktaAuthorizationServer extends CompatEntity {
  [key: string]: unknown;
}
export interface OktaGroupMembership extends CompatEntity {
  [key: string]: unknown;
}
export interface OktaAppAssignment extends CompatEntity {
  [key: string]: unknown;
}

export interface OktaSeedConfig {
  [key: string]: unknown;
}

export interface OktaStore {
  users: CompatCollection<OktaUser>;
  groups: CompatCollection<OktaGroup>;
  apps: CompatCollection<OktaApp>;
  oauthClients: CompatCollection<OktaOAuthClient>;
  authorizationServers: CompatCollection<OktaAuthorizationServer>;
  groupMemberships: CompatCollection<OktaGroupMembership>;
  appAssignments: CompatCollection<OktaAppAssignment>;
}

function compatCollection<T extends CompatEntity>(
  store: CompatStoreSource,
  name: string,
  indexFields: string[],
): CompatCollection<T> {
  return store.collection<T>(name, indexFields);
}

export function getOktaStore(store: CompatStoreSource): OktaStore {
  return {
    users: compatCollection<OktaUser>(store, "okta.users", ["okta_id", "login", "email"]),
    groups: compatCollection<OktaGroup>(store, "okta.groups", ["okta_id", "name"]),
    apps: compatCollection<OktaApp>(store, "okta.apps", ["okta_id", "name"]),
    oauthClients: compatCollection<OktaOAuthClient>(store, "okta.oauth_clients", ["client_id", "auth_server_id"]),
    authorizationServers: compatCollection<OktaAuthorizationServer>(store, "okta.auth_servers", ["server_id"]),
    groupMemberships: compatCollection<OktaGroupMembership>(store, "okta.group_memberships", [
      "group_okta_id",
      "user_okta_id",
    ]),
    appAssignments: compatCollection<OktaAppAssignment>(store, "okta.app_assignments", ["app_okta_id", "user_okta_id"]),
  };
}

// Legacy public entity type augmentations.
export interface OktaUser extends CompatEntity {
  okta_id: string;
  status: OktaUserStatus;
  activated_at: string | null;
  status_changed_at: string;
  last_login_at: string | null;
  password_changed_at: string | null;
  transitioning_to_status: OktaUserStatus | null;
  login: string;
  email: string;
  first_name: string;
  last_name: string;
  display_name: string;
  locale: string;
  time_zone: string;
}

export interface OktaGroup extends CompatEntity {
  okta_id: string;
  type: OktaGroupType;
  name: string;
  description: string | null;
}

export interface OktaApp extends CompatEntity {
  okta_id: string;
  name: string;
  label: string;
  status: OktaAppStatus;
  sign_on_mode: string;
  settings: Record<string, unknown>;
  credentials: Record<string, unknown>;
}

export interface OktaOAuthClient extends CompatEntity {
  client_id: string;
  client_secret?: string;
  name: string;
  redirect_uris: string[];
  response_types: string[];
  grant_types: string[];
  token_endpoint_auth_method: "client_secret_post" | "client_secret_basic" | "none";
  auth_server_id: string;
}

export interface OktaAuthorizationServer extends CompatEntity {
  server_id: string;
  name: string;
  description: string;
  audiences: string[];
  status: OktaAuthorizationServerStatus;
}

export interface OktaGroupMembership extends CompatEntity {
  group_okta_id: string;
  user_okta_id: string;
}

export interface OktaAppAssignment extends CompatEntity {
  app_okta_id: string;
  user_okta_id: string;
}

// Legacy public seed config type augmentations.
export interface OktaSeedConfig {
  users?: Array<{
    okta_id?: string;
    status?: OktaUserStatus;
    login: string;
    email?: string;
    first_name?: string;
    last_name?: string;
    display_name?: string;
    locale?: string;
    time_zone?: string;
  }>;
  groups?: Array<{
    okta_id?: string;
    type?: OktaGroupType;
    name: string;
    description?: string;
  }>;
  apps?: Array<{
    okta_id?: string;
    name: string;
    label?: string;
    status?: "ACTIVE" | "INACTIVE";
    sign_on_mode?: string;
    settings?: Record<string, unknown>;
    credentials?: Record<string, unknown>;
  }>;
  oauth_clients?: Array<{
    client_id: string;
    client_secret?: string;
    name: string;
    redirect_uris: string[];
    response_types?: string[];
    grant_types?: string[];
    token_endpoint_auth_method?: "client_secret_post" | "client_secret_basic" | "none";
    auth_server_id?: string;
  }>;
  authorization_servers?: Array<{
    id: string;
    name: string;
    description?: string;
    audiences?: string[];
    status?: OktaAuthorizationServerStatus;
  }>;
  group_memberships?: Array<{
    group_okta_id: string;
    user_okta_id: string;
  }>;
  app_assignments?: Array<{
    app_okta_id: string;
    user_okta_id: string;
  }>;
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

export const oktaPlugin = plugin;

export function seedFromConfig(_store?: unknown, _baseUrl?: string, _config?: OktaSeedConfig): void {
  throw new Error(
    "seedFromConfig is no longer supported by native compatibility facade packages. Pass seed data to createEmulateHandler or createEmulator instead.",
  );
}

export function createAppKeyResolver(): undefined {
  return undefined;
}

export default plugin;
