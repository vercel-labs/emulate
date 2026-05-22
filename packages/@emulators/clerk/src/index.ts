export const serviceName = "clerk";
export const serviceLabel = "Clerk authentication and user management";
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

export interface ClerkUser extends CompatEntity {
  [key: string]: unknown;
}
export interface ClerkEmailAddress extends CompatEntity {
  [key: string]: unknown;
}
export interface ClerkOrganization extends CompatEntity {
  [key: string]: unknown;
}
export interface ClerkOrganizationMembership extends CompatEntity {
  [key: string]: unknown;
}
export interface ClerkOrganizationInvitation extends CompatEntity {
  [key: string]: unknown;
}
export interface ClerkSession extends CompatEntity {
  [key: string]: unknown;
}
export interface ClerkOAuthApplication extends CompatEntity {
  [key: string]: unknown;
}

export interface ClerkSeedConfig {
  [key: string]: unknown;
}

export interface ClerkStore {
  users: CompatCollection<ClerkUser>;
  emailAddresses: CompatCollection<ClerkEmailAddress>;
  organizations: CompatCollection<ClerkOrganization>;
  memberships: CompatCollection<ClerkOrganizationMembership>;
  invitations: CompatCollection<ClerkOrganizationInvitation>;
  sessions: CompatCollection<ClerkSession>;
  oauthApps: CompatCollection<ClerkOAuthApplication>;
}

function compatCollection<T extends CompatEntity>(
  store: CompatStoreSource,
  name: string,
  indexFields: string[],
): CompatCollection<T> {
  return store.collection<T>(name, indexFields);
}

export function getClerkStore(store: CompatStoreSource): ClerkStore {
  return {
    users: compatCollection<ClerkUser>(store, "clerk.users", ["clerk_id", "username"]),
    emailAddresses: compatCollection<ClerkEmailAddress>(store, "clerk.emails", [
      "email_id",
      "user_id",
      "email_address",
    ]),
    organizations: compatCollection<ClerkOrganization>(store, "clerk.orgs", ["clerk_id", "slug"]),
    memberships: compatCollection<ClerkOrganizationMembership>(store, "clerk.memberships", [
      "membership_id",
      "org_id",
      "user_id",
    ]),
    invitations: compatCollection<ClerkOrganizationInvitation>(store, "clerk.invitations", ["invitation_id", "org_id"]),
    sessions: compatCollection<ClerkSession>(store, "clerk.sessions", ["clerk_id", "user_id"]),
    oauthApps: compatCollection<ClerkOAuthApplication>(store, "clerk.oauth_apps", ["app_id", "client_id"]),
  };
}

// Legacy public entity type augmentations.
export interface ClerkUser extends CompatEntity {
  clerk_id: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  image_url: string | null;
  profile_image_url: string | null;
  external_id: string | null;
  primary_email_address_id: string | null;
  primary_phone_number_id: string | null;
  password_enabled: boolean;
  password_hash: string | null;
  totp_enabled: boolean;
  backup_code_enabled: boolean;
  two_factor_enabled: boolean;
  banned: boolean;
  locked: boolean;
  public_metadata: Record<string, unknown>;
  private_metadata: Record<string, unknown>;
  unsafe_metadata: Record<string, unknown>;
  last_active_at: number | null;
  last_sign_in_at: number | null;
  created_at_unix: number;
  updated_at_unix: number;
}

export interface ClerkEmailAddress extends CompatEntity {
  email_id: string;
  email_address: string;
  user_id: string;
  verification_status: "verified" | "unverified";
  verification_strategy: string;
  is_primary: boolean;
  reserved: boolean;
  created_at_unix: number;
  updated_at_unix: number;
}

export interface ClerkOrganization extends CompatEntity {
  clerk_id: string;
  name: string;
  slug: string;
  image_url: string | null;
  has_logo: boolean;
  members_count: number;
  pending_invitations_count: number;
  public_metadata: Record<string, unknown>;
  private_metadata: Record<string, unknown>;
  max_allowed_memberships: number | null;
  admin_delete_enabled: boolean;
  created_at_unix: number;
  updated_at_unix: number;
}

export interface ClerkOrganizationMembership extends CompatEntity {
  membership_id: string;
  org_id: string;
  user_id: string;
  role: string;
  permissions: string[];
  public_metadata: Record<string, unknown>;
  private_metadata: Record<string, unknown>;
  created_at_unix: number;
  updated_at_unix: number;
}

export interface ClerkOrganizationInvitation extends CompatEntity {
  invitation_id: string;
  email_address: string;
  org_id: string;
  role: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  expires_at: number;
  created_at_unix: number;
  updated_at_unix: number;
}

export interface ClerkSession extends CompatEntity {
  clerk_id: string;
  user_id: string;
  client_id: string;
  status: "active" | "revoked" | "ended";
  last_active_at: number | null;
  expire_at: number;
  abandon_at: number;
  created_at_unix: number;
  updated_at_unix: number;
}

export interface ClerkOAuthApplication extends CompatEntity {
  app_id: string;
  name: string;
  client_id: string;
  client_secret: string;
  is_public: boolean;
  scopes: string[];
  redirect_uris: string[];
  created_at_unix: number;
  updated_at_unix: number;
}

// Legacy public seed config type augmentations.
export interface ClerkSeedConfig {
  users?: Array<{
    clerk_id?: string;
    email_addresses: string[];
    first_name?: string;
    last_name?: string;
    username?: string;
    password?: string;
    external_id?: string;
    public_metadata?: Record<string, unknown>;
    private_metadata?: Record<string, unknown>;
    unsafe_metadata?: Record<string, unknown>;
  }>;
  organizations?: Array<{
    clerk_id?: string;
    name: string;
    slug?: string;
    max_allowed_memberships?: number;
    public_metadata?: Record<string, unknown>;
    private_metadata?: Record<string, unknown>;
    members?: Array<{
      email: string;
      role: string;
    }>;
  }>;
  oauth_applications?: Array<{
    client_id: string;
    client_secret?: string;
    name: string;
    redirect_uris: string[];
    scopes?: string[];
    public?: boolean;
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

export const clerkPlugin = plugin;

export function seedFromConfig(_store?: unknown, _baseUrl?: string, _config?: ClerkSeedConfig): void {
  throw new Error(
    "seedFromConfig is no longer supported by native compatibility facade packages. Pass seed data to createEmulateHandler or createEmulator instead.",
  );
}

export function createAppKeyResolver(): undefined {
  return undefined;
}

export default plugin;
