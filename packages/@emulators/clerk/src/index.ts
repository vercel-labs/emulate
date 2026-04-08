import type { Hono } from "hono";
import type {
  AppEnv,
  RouteContext,
  ServicePlugin,
  Store,
  TokenMap,
  WebhookDispatcher,
} from "@emulators/core";
import {
  generateClerkId,
  nowUnix,
  createDefaultUser,
  createDefaultEmailAddress,
} from "./helpers.js";
import { oauthRoutes } from "./routes/oauth.js";
import { userRoutes } from "./routes/users.js";
import { emailAddressRoutes } from "./routes/email-addresses.js";
import { organizationRoutes } from "./routes/organizations.js";
import { membershipRoutes } from "./routes/memberships.js";
import { invitationRoutes } from "./routes/invitations.js";
import { sessionRoutes } from "./routes/sessions.js";
import { getClerkStore } from "./store.js";

export { getClerkStore, type ClerkStore } from "./store.js";
export * from "./entities.js";

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

function seedDefaults(store: Store, _baseUrl: string): void {
  const cs = getClerkStore(store);

  if (cs.users.all().length > 0) return;

  const userInput = createDefaultUser();
  const user = cs.users.insert(userInput);

  const email = cs.emailAddresses.insert(
    createDefaultEmailAddress(user.clerk_id, "test@example.com", true),
  );

  cs.users.update(user.id, { primary_email_address_id: email.email_id });

  const now = nowUnix();
  cs.oauthApps.insert({
    app_id: generateClerkId("oauth_app_"),
    name: "Emulate App",
    client_id: "clerk_emulate_client",
    client_secret: "clerk_emulate_secret",
    is_public: false,
    scopes: ["openid", "profile", "email"],
    redirect_uris: ["http://localhost:3000/api/auth/callback/clerk"],
    created_at_unix: now,
    updated_at_unix: now,
  });
}

export function seedFromConfig(store: Store, _baseUrl: string, config: ClerkSeedConfig): void {
  const cs = getClerkStore(store);
  const now = nowUnix();

  if (config.users) {
    for (const userCfg of config.users) {
      const existingEmail = userCfg.email_addresses?.[0];
      if (existingEmail) {
        const found = cs.emailAddresses.findOneBy("email_address", existingEmail);
        if (found) continue;
      }

      const clerkId = userCfg.clerk_id ?? generateClerkId("user_");
      const user = cs.users.insert({
        clerk_id: clerkId,
        username: userCfg.username ?? null,
        first_name: userCfg.first_name ?? "Test",
        last_name: userCfg.last_name ?? "User",
        image_url: null,
        profile_image_url: null,
        external_id: userCfg.external_id ?? null,
        primary_email_address_id: null,
        primary_phone_number_id: null,
        password_enabled: typeof userCfg.password === "string" && userCfg.password.length > 0,
        password_hash: userCfg.password ?? null,
        totp_enabled: false,
        backup_code_enabled: false,
        two_factor_enabled: false,
        banned: false,
        locked: false,
        public_metadata: userCfg.public_metadata ?? {},
        private_metadata: userCfg.private_metadata ?? {},
        unsafe_metadata: userCfg.unsafe_metadata ?? {},
        last_active_at: null,
        last_sign_in_at: null,
        created_at_unix: now,
        updated_at_unix: now,
      });

      let primaryEmailId: string | null = null;
      if (userCfg.email_addresses) {
        for (let i = 0; i < userCfg.email_addresses.length; i++) {
          const email = cs.emailAddresses.insert(
            createDefaultEmailAddress(clerkId, userCfg.email_addresses[i], i === 0),
          );
          if (i === 0) primaryEmailId = email.email_id;
        }
      }

      if (primaryEmailId) {
        cs.users.update(user.id, { primary_email_address_id: primaryEmailId });
      }
    }
  }

  if (config.organizations) {
    for (const orgCfg of config.organizations) {
      const existingSlug = orgCfg.slug ?? orgCfg.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const existing = cs.organizations.findOneBy("slug", existingSlug);
      if (existing) continue;

      const orgId = orgCfg.clerk_id ?? generateClerkId("org_");
      const org = cs.organizations.insert({
        clerk_id: orgId,
        name: orgCfg.name,
        slug: existingSlug,
        image_url: null,
        has_logo: false,
        members_count: 0,
        pending_invitations_count: 0,
        public_metadata: orgCfg.public_metadata ?? {},
        private_metadata: orgCfg.private_metadata ?? {},
        max_allowed_memberships: orgCfg.max_allowed_memberships ?? null,
        admin_delete_enabled: true,
        created_at_unix: now,
        updated_at_unix: now,
      });

      if (orgCfg.members) {
        let memberCount = 0;
        for (const memberCfg of orgCfg.members) {
          const emailEntry = cs.emailAddresses.findOneBy("email_address", memberCfg.email);
          if (!emailEntry) continue;

          const user = cs.users.findOneBy("clerk_id", emailEntry.user_id);
          if (!user) continue;

          const existingMembership = cs.memberships
            .findBy("org_id", orgId)
            .find((m) => m.user_id === user.clerk_id);
          if (existingMembership) continue;

          const role = memberCfg.role.startsWith("org:") ? memberCfg.role : `org:${memberCfg.role}`;
          cs.memberships.insert({
            membership_id: generateClerkId("orgmem_"),
            org_id: orgId,
            user_id: user.clerk_id,
            role,
            permissions: role === "org:admin"
              ? ["org:sys_profile:manage", "org:sys_profile:delete", "org:sys_memberships:read", "org:sys_memberships:manage"]
              : ["org:sys_memberships:read"],
            public_metadata: {},
            private_metadata: {},
            created_at_unix: now,
            updated_at_unix: now,
          });
          memberCount++;
        }
        cs.organizations.update(org.id, { members_count: memberCount });
      }
    }
  }

  if (config.oauth_applications) {
    for (const appCfg of config.oauth_applications) {
      const existing = cs.oauthApps.findOneBy("client_id", appCfg.client_id);
      if (existing) continue;

      cs.oauthApps.insert({
        app_id: generateClerkId("oauth_app_"),
        name: appCfg.name,
        client_id: appCfg.client_id,
        client_secret: appCfg.client_secret ?? "",
        is_public: appCfg.public ?? false,
        scopes: appCfg.scopes ?? ["openid", "profile", "email"],
        redirect_uris: appCfg.redirect_uris,
        created_at_unix: now,
        updated_at_unix: now,
      });
    }
  }
}

export const clerkPlugin: ServicePlugin = {
  name: "clerk",
  register(
    app: Hono<AppEnv>,
    store: Store,
    webhooks: WebhookDispatcher,
    baseUrl: string,
    tokenMap?: TokenMap,
  ): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    oauthRoutes(ctx);
    userRoutes(ctx);
    emailAddressRoutes(ctx);
    organizationRoutes(ctx);
    membershipRoutes(ctx);
    invitationRoutes(ctx);
    sessionRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default clerkPlugin;
