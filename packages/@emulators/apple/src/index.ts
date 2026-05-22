export const serviceName = "apple";
export const serviceLabel = "Apple Sign In and OIDC";
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

export interface AppleUser extends CompatEntity {
  [key: string]: unknown;
}
export interface AppleOAuthClient extends CompatEntity {
  [key: string]: unknown;
}

export interface AppleSeedConfig {
  [key: string]: unknown;
}

export interface AppleStore {
  users: CompatCollection<AppleUser>;
  oauthClients: CompatCollection<AppleOAuthClient>;
}

function compatCollection<T extends CompatEntity>(
  store: CompatStoreSource,
  name: string,
  indexFields: string[],
): CompatCollection<T> {
  return store.collection<T>(name, indexFields);
}

export function getAppleStore(store: CompatStoreSource): AppleStore {
  return {
    users: compatCollection<AppleUser>(store, "apple.users", ["uid", "email"]),
    oauthClients: compatCollection<AppleOAuthClient>(store, "apple.oauth_clients", ["client_id"]),
  };
}

// Legacy public entity type augmentations.
export interface AppleUser extends CompatEntity {
  uid: string;
  email: string;
  name: string;
  given_name: string;
  family_name: string;
  email_verified: boolean;
  is_private_email: boolean;
  private_relay_email: string | null;
  real_user_status: number;
}

export interface AppleOAuthClient extends CompatEntity {
  client_id: string;
  team_id: string;
  key_id: string;
  name: string;
  redirect_uris: string[];
}

// Legacy public seed config type augmentations.
export interface AppleSeedConfig {
  users?: Array<{
    email: string;
    name?: string;
    given_name?: string;
    family_name?: string;
    is_private_email?: boolean;
  }>;
  oauth_clients?: Array<{
    client_id: string;
    team_id: string;
    key_id?: string;
    name: string;
    redirect_uris: string[];
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

export const applePlugin = plugin;

export function seedFromConfig(_store?: unknown, _baseUrl?: string, _config?: AppleSeedConfig): void {
  throw new Error(
    "seedFromConfig is no longer supported by native compatibility facade packages. Pass seed data to createEmulateHandler or createEmulator instead.",
  );
}

export function createAppKeyResolver(): undefined {
  return undefined;
}

export default plugin;
