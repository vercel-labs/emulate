export const serviceName = "resend";
export const serviceLabel = "Resend email API";
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

export interface ResendEmail extends CompatEntity {
  [key: string]: unknown;
}
export interface ResendDomain extends CompatEntity {
  [key: string]: unknown;
}
export interface ResendApiKey extends CompatEntity {
  [key: string]: unknown;
}
export interface ResendAudience extends CompatEntity {
  [key: string]: unknown;
}
export interface ResendContact extends CompatEntity {
  [key: string]: unknown;
}

export interface ResendSeedConfig {
  [key: string]: unknown;
}

export interface ResendStore {
  emails: CompatCollection<ResendEmail>;
  domains: CompatCollection<ResendDomain>;
  apiKeys: CompatCollection<ResendApiKey>;
  audiences: CompatCollection<ResendAudience>;
  contacts: CompatCollection<ResendContact>;
}

function compatCollection<T extends CompatEntity>(
  store: CompatStoreSource,
  name: string,
  indexFields: string[],
): CompatCollection<T> {
  return store.collection<T>(name, indexFields);
}

export function getResendStore(store: CompatStoreSource): ResendStore {
  return {
    emails: compatCollection<ResendEmail>(store, "resend.emails", ["uuid"]),
    domains: compatCollection<ResendDomain>(store, "resend.domains", ["uuid", "name"]),
    apiKeys: compatCollection<ResendApiKey>(store, "resend.api_keys", ["uuid"]),
    audiences: compatCollection<ResendAudience>(store, "resend.audiences", ["uuid"]),
    contacts: compatCollection<ResendContact>(store, "resend.contacts", ["uuid", "audience_id"]),
  };
}

// Legacy public entity type augmentations.
export interface ResendEmail extends CompatEntity {
  uuid: string;
  from: string;
  to: string[];
  subject: string;
  html: string | null;
  text: string | null;
  cc: string[];
  bcc: string[];
  reply_to: string[];
  headers: Record<string, string>;
  tags: Array<{ name: string; value: string }>;
  status: "sent" | "delivered" | "bounced" | "canceled" | "scheduled";
  scheduled_at: string | null;
  last_event: string;
}

export interface ResendDomain extends CompatEntity {
  uuid: string;
  name: string;
  status: "pending" | "verified";
  region: string;
  records: Array<{
    record: string;
    name: string;
    type: string;
    ttl: string;
    status: "pending" | "verified";
    value: string;
    priority?: number;
  }>;
}

export interface ResendApiKey extends CompatEntity {
  uuid: string;
  name: string;
  token: string;
}

export interface ResendAudience extends CompatEntity {
  uuid: string;
  name: string;
}

export interface ResendContact extends CompatEntity {
  uuid: string;
  audience_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  unsubscribed: boolean;
}

// Legacy public seed config type augmentations.
export interface ResendSeedConfig {
  port?: number;
  domains?: Array<{
    name: string;
    region?: string;
  }>;
  contacts?: Array<{
    email: string;
    first_name?: string;
    last_name?: string;
    audience?: string;
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

export const resendPlugin = plugin;

export function seedFromConfig(_store?: unknown, _baseUrl?: string, _config?: ResendSeedConfig): void {
  throw new Error(
    "seedFromConfig is no longer supported by native compatibility facade packages. Pass seed data to createEmulateHandler or createEmulator instead.",
  );
}

export function createAppKeyResolver(): undefined {
  return undefined;
}

export default plugin;
