export const serviceName = "microsoft";
export const serviceLabel = "Microsoft Entra ID and Graph API";
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

export interface MicrosoftUser extends CompatEntity {
  [key: string]: unknown;
}
export interface MicrosoftOAuthClient extends CompatEntity {
  [key: string]: unknown;
}

export interface MicrosoftSeedConfig {
  [key: string]: unknown;
}

export interface MicrosoftStore {
  users: CompatCollection<MicrosoftUser>;
  oauthClients: CompatCollection<MicrosoftOAuthClient>;
}

function compatCollection<T extends CompatEntity>(
  store: CompatStoreSource,
  name: string,
  indexFields: string[],
): CompatCollection<T> {
  return store.collection<T>(name, indexFields);
}

export function getMicrosoftStore(store: CompatStoreSource): MicrosoftStore {
  return {
    users: compatCollection<MicrosoftUser>(store, "microsoft.users", ["oid", "email"]),
    oauthClients: compatCollection<MicrosoftOAuthClient>(store, "microsoft.oauth_clients", ["client_id"]),
  };
}

// Legacy public entity type augmentations.
export interface MicrosoftUser extends CompatEntity {
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

export interface MicrosoftOAuthClient extends CompatEntity {
  client_id: string;
  client_secret: string;
  name: string;
  redirect_uris: string[];
  /** Tenant ID this app is registered in */
  tenant_id: string;
}

// Legacy public seed config type augmentations.
export interface MicrosoftSeedConfig {
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

export const microsoftPlugin = plugin;

export function seedFromConfig(_store?: unknown, _baseUrl?: string, _config?: MicrosoftSeedConfig): void {
  throw new Error(
    "seedFromConfig is no longer supported by native compatibility facade packages. Pass seed data to createEmulateHandler or createEmulator instead.",
  );
}

export function createAppKeyResolver(): undefined {
  return undefined;
}

export default plugin;
