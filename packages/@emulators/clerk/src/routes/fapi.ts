import type { RouteContext, Store, Context, AppEnv } from "@emulators/core";
import { generateClerkId, nowUnix } from "../helpers.js";
import { clerkError, userResponse } from "../route-helpers.js";
import { getClerkStore } from "../store.js";
import { createSessionToken } from "./oauth.js";
import type { ClerkUser, ClerkSession } from "../entities.js";

// clerk-js posts FAPI bodies as application/x-www-form-urlencoded (with a JSON fallback).
async function readFapiBody(c: Context<AppEnv>): Promise<Record<string, string>> {
  const contentType = c.req.header("Content-Type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const parsed = (await c.req.json()) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
      return out;
    } catch {
      return {};
    }
  }
  try {
    const raw = await c.req.text();
    return Object.fromEntries(new URLSearchParams(raw));
  } catch {
    return {};
  }
}

// Build the org_membership JSON array embedded in a user resource.
function userOrgMemberships(store: Store, user: ClerkUser): Record<string, unknown>[] {
  const cs = getClerkStore(store);
  return cs.memberships
    .findBy("user_id", user.clerk_id)
    .map((m) => {
      const org = cs.organizations.findOneBy("clerk_id", m.org_id);
      if (!org) return null;
      return {
        object: "organization_membership",
        id: m.membership_id,
        role: m.role,
        permissions: m.permissions,
        public_metadata: m.public_metadata,
        organization: {
          object: "organization",
          id: org.clerk_id,
          name: org.name,
          slug: org.slug,
          image_url: org.image_url,
          has_image: org.image_url !== null,
          members_count: org.members_count,
          max_allowed_memberships: org.max_allowed_memberships,
          admin_delete_enabled: org.admin_delete_enabled,
          public_metadata: org.public_metadata,
          created_at: org.created_at_unix * 1000,
          updated_at: org.updated_at_unix * 1000,
        },
        created_at: m.created_at_unix * 1000,
        updated_at: m.updated_at_unix * 1000,
      };
    })
    .filter((m): m is Record<string, unknown> => m !== null);
}

// Build a FAPI SessionJSON (with embedded user, org memberships, and a live token).
async function buildSessionJson(store: Store, baseUrl: string, s: ClerkSession): Promise<Record<string, unknown>> {
  const cs = getClerkStore(store);
  const user = cs.users.findOneBy("clerk_id", s.user_id);
  const emails = user ? cs.emailAddresses.findBy("user_id", user.clerk_id) : [];
  const primaryEmail = emails.find((e) => e.is_primary) ?? emails[0];

  // last_active_token is REQUIRED by clerk-js — must be a real token object.
  let lastActiveToken: { object: string; jwt: string } | null = null;
  let lastActiveOrgId: string | null = null;
  let userJson: Record<string, unknown> | null = null;

  if (user) {
    const memberships = cs.memberships.findBy("user_id", user.clerk_id);
    const firstMembership = memberships[0];
    let orgId: string | undefined;
    let orgRole: string | undefined;
    let orgSlug: string | undefined;
    let orgPermissions: string[] | undefined;
    if (firstMembership) {
      const org = cs.organizations.findOneBy("clerk_id", firstMembership.org_id);
      if (org) {
        orgId = org.clerk_id;
        orgRole = firstMembership.role;
        orgSlug = org.slug;
        orgPermissions = firstMembership.permissions;
        lastActiveOrgId = org.clerk_id;
      }
    }
    const jwt = await createSessionToken(store, user, s.clerk_id, baseUrl, orgId, orgRole, orgSlug, orgPermissions);
    lastActiveToken = { object: "token", jwt };
    userJson = { ...userResponse(user, emails), organization_memberships: userOrgMemberships(store, user) };
  }

  return {
    object: "session",
    id: s.clerk_id,
    status: s.status,
    factor_verification_age: [0, 0],
    expire_at: s.expire_at * 1000,
    abandon_at: s.abandon_at * 1000,
    last_active_at: (s.last_active_at ?? s.created_at_unix) * 1000,
    last_active_token: lastActiveToken,
    last_active_organization_id: lastActiveOrgId,
    actor: null,
    tasks: [],
    user: userJson,
    public_user_data: user
      ? {
          first_name: user.first_name,
          last_name: user.last_name,
          image_url: user.image_url ?? `https://img.clerk.com/preview?seed=${user.clerk_id}`,
          has_image: user.image_url !== null,
          identifier: primaryEmail?.email_address ?? user.username ?? user.clerk_id,
        }
      : null,
    created_at: s.created_at_unix * 1000,
    updated_at: s.updated_at_unix * 1000,
  };
}

async function buildClientJson(store: Store, baseUrl: string, activeSessionId?: string | null) {
  const cs = getClerkStore(store);
  const sessions = cs.sessions.all().filter((s) => s.status === "active");

  const sessionJsons = await Promise.all(sessions.map((s) => buildSessionJson(store, baseUrl, s)));

  return {
    object: "client",
    id: "client_emulate",
    sessions: sessionJsons,
    sign_up: null,
    sign_in: null,
    last_active_session_id: activeSessionId ?? sessionJsons[0]?.id ?? null,
    last_authentication_strategy: null,
    cookie_expires_at: null,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
}

async function fapiResponse(
  response: unknown,
  store: Store,
  baseUrl: string,
  activeSessionId?: string | null,
  embedSignIn?: Record<string, unknown> | null,
  embedSignUp?: Record<string, unknown> | null,
) {
  const client = await buildClientJson(store, baseUrl, activeSessionId);
  // clerk-js's useSignIn()/useSignUp() hooks proxy client.sign_in / client.sign_up —
  // embed them so the hook resources reflect the in-progress attempt.
  if (embedSignIn !== undefined) {
    (client as Record<string, unknown>).sign_in = embedSignIn;
  }
  if (embedSignUp !== undefined) {
    (client as Record<string, unknown>).sign_up = embedSignUp;
  }
  return { response, client };
}

function buildEnvironmentJson(baseUrl: string): Record<string, unknown> {
  return {
    api_keys_settings: { user_api_keys_enabled: false, orgs_api_keys_enabled: false },
    auth_config: {
      object: "auth_config",
      id: "aac_emulate",
      single_session_mode: false,
      claimed_at: null,
      reverification: false,
    },
    commerce_settings: {
      billing: {
        stripe_publishable_key: null,
        organization: { enabled: false, has_paid_plans: false },
        user: { enabled: false, has_paid_plans: false },
      },
    },
    display_config: {
      object: "display_config",
      id: "display_emulate",
      after_sign_in_url: "/",
      after_sign_out_all_url: "/",
      after_sign_out_one_url: "/",
      after_sign_up_url: "/",
      after_switch_session_url: "/",
      application_name: "Emulate",
      branded: false,
      captcha_public_key: null,
      captcha_widget_type: "invisible",
      captcha_public_key_invisible: null,
      captcha_provider: "turnstile",
      captcha_oauth_bypass: [],
      home_url: baseUrl,
      instance_environment_type: "development",
      logo_image_url: "",
      favicon_image_url: "",
      preferred_sign_in_strategy: "password",
      sign_in_url: "/sign-in",
      sign_up_url: "/sign-up",
      support_email: "",
      theme: {},
      user_profile_url: "/user",
      clerk_js_version: "5",
      organization_profile_url: "/organization",
      create_organization_url: "/create-organization",
      after_leave_organization_url: "/",
      after_create_organization_url: "/",
      show_devmode_warning: false,
      terms_url: "",
      privacy_policy_url: "",
      waitlist_url: "",
      after_join_waitlist_url: "",
    },
    maintenance_mode: false,
    organization_settings: {
      enabled: true,
      max_allowed_memberships: 100,
      force_organization_selection: false,
      actions: { admin_delete: true },
      domains: { enabled: true, enrollment_modes: ["manual_invitation", "automatic_invitation", "automatic_suggestion"], default_role: "org:member" },
      slug: { disabled: false },
      organization_creation_defaults: { enabled: true },
    },
    user_settings: {
      attributes: {
        email_address: {
          enabled: true,
          required: true,
          verifications: ["email_code"],
          used_for_first_factor: true,
          first_factors: ["email_code"],
          used_for_second_factor: false,
          second_factors: [],
          verify_at_sign_up: false,
        },
        password: {
          enabled: true,
          required: true,
        },
        first_name: { enabled: true, required: false },
        last_name: { enabled: true, required: false },
        username: { enabled: false, required: false },
        phone_number: { enabled: false, required: false },
        web3_wallet: { enabled: false, required: false },
      },
      actions: { delete_self: true, create_organization: true },
      social: {},
      enterprise_sso: { enabled: false, self_serve_sso: false },
      sign_in: { second_factor: { required: false, enabled: false } },
      sign_up: { allowlist_only: false, progressive: true, captcha_enabled: false, mode: "public", legal_consent_enabled: false },
      password_settings: { min_length: 8, max_length: 72, disable_hibp: true, allowed_special_characters: "" },
      passkey_settings: { allow_autofill: false, show_sign_in_button: false },
      username_settings: { min_length: 4, max_length: 64 },
    },
    protect_config: { object: "protect_config", id: "protect_emulate" },
  };
}

// Fixed verification codes for the emulator (mirrors Clerk's test-mode 424242 convention).
const EMULATE_EMAIL_CODE = "424242";
const EMULATE_TOTP_CODE = "424242";

type Verification = { status: "verified" | "unverified"; strategy: string } | null;

type PendingSignIn = {
  id: string;
  user: ClerkUser;
  status: "needs_first_factor" | "needs_second_factor" | "complete";
  createdSessionId: string | null;
  firstFactorVerification: Verification;
  secondFactorVerification: Verification;
};

function getSignIns(store: Store): Map<string, PendingSignIn> {
  let map = store.getData<Map<string, PendingSignIn>>("clerk.fapi.signIns");
  if (!map) {
    map = new Map();
    store.setData("clerk.fapi.signIns", map);
  }
  return map;
}

// Create an active session and mark the sign-in complete.
function completeSignIn(cs: ReturnType<typeof getClerkStore>, signIn: PendingSignIn) {
  const now = nowUnix();
  const session = cs.sessions.insert({
    clerk_id: generateClerkId("sess_"),
    user_id: signIn.user.clerk_id,
    client_id: "client_emulate",
    status: "active",
    last_active_at: now,
    expire_at: now + 86400,
    abandon_at: now + 604800,
    created_at_unix: now,
    updated_at_unix: now,
  });
  signIn.status = "complete";
  signIn.createdSessionId = session.clerk_id;
  return session;
}

// First factor passed: go to MFA if the user has TOTP enabled, else complete.
function advanceAfterFirstFactor(cs: ReturnType<typeof getClerkStore>, signIn: PendingSignIn): void {
  signIn.firstFactorVerification = { status: "verified", strategy: signIn.firstFactorVerification?.strategy ?? "password" };
  if (signIn.user.totp_enabled) {
    signIn.status = "needs_second_factor";
  } else {
    completeSignIn(cs, signIn);
  }
}

function signInJson(cs: ReturnType<typeof getClerkStore>, signIn: PendingSignIn): Record<string, unknown> {
  const emails = cs.emailAddresses.findBy("user_id", signIn.user.clerk_id);
  const primaryEmail = emails.find((e) => e.is_primary) ?? emails[0];
  const identifier = primaryEmail?.email_address ?? signIn.user.username ?? signIn.user.clerk_id;

  const firstFactors: Record<string, unknown>[] = [{ strategy: "password", safe_identifier: identifier }];
  if (primaryEmail) {
    firstFactors.push({
      strategy: "email_code",
      safe_identifier: primaryEmail.email_address,
      email_address_id: primaryEmail.email_id,
    });
  }

  const secondFactors: Record<string, unknown>[] = signIn.user.totp_enabled ? [{ strategy: "totp" }] : [];

  return {
    object: "sign_in",
    id: signIn.id,
    status: signIn.status,
    identifier,
    user_data: {
      first_name: signIn.user.first_name,
      last_name: signIn.user.last_name,
      image_url: signIn.user.image_url ?? `https://img.clerk.com/preview?seed=${signIn.user.clerk_id}`,
      has_image: signIn.user.image_url !== null,
    },
    supported_first_factors: firstFactors,
    supported_second_factors: secondFactors,
    first_factor_verification: signIn.firstFactorVerification,
    second_factor_verification: signIn.secondFactorVerification,
    created_session_id: signIn.createdSessionId,
  };
}

type PendingSignUp = {
  id: string;
  email_address: string;
  password: string | null;
  first_name: string | null;
  last_name: string | null;
  emailVerification: Verification;
  status: "missing_requirements" | "complete";
  createdSessionId: string | null;
};

function getSignUps(store: Store): Map<string, PendingSignUp> {
  let map = store.getData<Map<string, PendingSignUp>>("clerk.fapi.signUps");
  if (!map) {
    map = new Map();
    store.setData("clerk.fapi.signUps", map);
  }
  return map;
}

function signUpJson(signUp: PendingSignUp): Record<string, unknown> {
  const emailVerified = signUp.emailVerification?.status === "verified";
  return {
    object: "sign_up",
    id: signUp.id,
    status: signUp.status,
    required_fields: ["email_address", "password"],
    optional_fields: ["first_name", "last_name"],
    missing_fields: signUp.status === "complete" ? [] : signUp.password ? [] : ["password"],
    unverified_fields: emailVerified ? [] : ["email_address"],
    verifications: {
      email_address: {
        status: signUp.emailVerification?.status ?? "unverified",
        strategy: signUp.emailVerification?.strategy ?? "email_code",
      },
      phone_number: null,
      web3_wallet: null,
      external_account: null,
    },
    username: null,
    email_address: signUp.email_address,
    phone_number: null,
    web3_wallet: null,
    first_name: signUp.first_name,
    last_name: signUp.last_name,
    has_password: signUp.password !== null,
    created_session_id: signUp.createdSessionId,
    created_user_id: null,
  };
}

export function fapiRoutes({ app, store, baseUrl }: RouteContext): void {
  const cs = getClerkStore(store);

  // Dev browser init
  app.post("/v1/dev_browser", (c) => {
    const jwt = "emulate_dev_browser_jwt";
    c.header("Clerk-Db-Jwt", jwt);
    return c.json({ id: jwt });
  });

  // Environment (clerk-js sends GET or POST depending on version)
  const environmentHandler = async (c: Context<AppEnv>) =>
    c.json(await fapiResponse(buildEnvironmentJson(baseUrl), store, baseUrl));
  app.get("/v1/environment", environmentHandler);
  app.post("/v1/environment", environmentHandler);

  // Client
  const clientHandler = async (c: Context<AppEnv>) =>
    c.json(await fapiResponse(await buildClientJson(store, baseUrl), store, baseUrl));
  app.get("/v1/client", clientHandler);
  app.post("/v1/client", clientHandler);

  const incorrectCode = (c: Context<AppEnv>) =>
    c.json(
      {
        errors: [
          {
            code: "form_code_incorrect",
            message: "Incorrect code.",
            long_message: "Incorrect code. Try again.",
          },
        ],
        meta: {},
      },
      422,
    );

  const incorrectPassword = (c: Context<AppEnv>) =>
    c.json(
      {
        errors: [
          {
            code: "form_password_incorrect",
            message: "Password is incorrect. Try again, or use another method.",
            long_message: "Password is incorrect. Try again, or use another method.",
          },
        ],
        meta: {},
      },
      422,
    );

  // Sign-in: create
  app.post("/v1/client/sign_ins", async (c) => {
    const body = await readFapiBody(c);
    const identifier = (body.identifier as string) ?? "";

    const email = cs.emailAddresses.findOneBy("email_address", identifier);
    if (!email) {
      return c.json(
        {
          errors: [{ code: "form_identifier_not_found", message: "Couldn't find your account.", long_message: "Couldn't find your account." }],
          meta: {},
        },
        422,
      );
    }

    const user = cs.users.findOneBy("clerk_id", email.user_id);
    if (!user) {
      return c.json(
        { errors: [{ code: "form_identifier_not_found", message: "Couldn't find your account." }] },
        422,
      );
    }

    const signInId = generateClerkId("sia_");
    const signIn: PendingSignIn = {
      id: signInId,
      user,
      status: "needs_first_factor",
      createdSessionId: null,
      firstFactorVerification: null,
      secondFactorVerification: null,
    };
    getSignIns(store).set(signInId, signIn);

    // Combined flow: @clerk/react's future API (signIn.password()) sends the
    // password in the create call and expects completion in one request.
    const password = body.password as string | undefined;
    if (password !== undefined) {
      if (user.password_hash !== password) return incorrectPassword(c);
      advanceAfterFirstFactor(cs, signIn);
      const json = signInJson(cs, signIn);
      return c.json(await fapiResponse(json, store, baseUrl, signIn.createdSessionId, json));
    }

    const json = signInJson(cs, signIn);
    return c.json(await fapiResponse(json, store, baseUrl, undefined, json));
  });

  // Sign-in: prepare first factor (e.g. send email code)
  app.post("/v1/client/sign_ins/:signInId/prepare_first_factor", async (c) => {
    const signIn = getSignIns(store).get(c.req.param("signInId"));
    if (!signIn) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Sign-in not found");

    const body = await readFapiBody(c);
    const strategy = (body.strategy as string) ?? "email_code";
    signIn.firstFactorVerification = { status: "unverified", strategy };

    const json = signInJson(cs, signIn);
    return c.json(await fapiResponse(json, store, baseUrl, undefined, json));
  });

  // Sign-in: attempt first factor (password or email_code)
  app.post("/v1/client/sign_ins/:signInId/attempt_first_factor", async (c) => {
    const signIn = getSignIns(store).get(c.req.param("signInId"));
    if (!signIn) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Sign-in not found");

    const body = await readFapiBody(c);
    const strategy = (body.strategy as string) ?? "password";

    if (strategy === "password") {
      if (signIn.user.password_hash !== (body.password as string)) return incorrectPassword(c);
    } else if (strategy === "email_code") {
      if ((body.code as string) !== EMULATE_EMAIL_CODE) return incorrectCode(c);
    }
    signIn.firstFactorVerification = { status: "verified", strategy };

    advanceAfterFirstFactor(cs, signIn);
    const json = signInJson(cs, signIn);
    return c.json(await fapiResponse(json, store, baseUrl, signIn.createdSessionId, json));
  });

  // Sign-in: attempt second factor (TOTP MFA)
  app.post("/v1/client/sign_ins/:signInId/attempt_second_factor", async (c) => {
    const signIn = getSignIns(store).get(c.req.param("signInId"));
    if (!signIn) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Sign-in not found");

    const body = await readFapiBody(c);
    const strategy = (body.strategy as string) ?? "totp";
    if ((body.code as string) !== EMULATE_TOTP_CODE) return incorrectCode(c);

    signIn.secondFactorVerification = { status: "verified", strategy };
    const session = completeSignIn(cs, signIn);
    const json = signInJson(cs, signIn);
    return c.json(await fapiResponse(json, store, baseUrl, session.clerk_id, json));
  });

  // Sign-up: create
  app.post("/v1/client/sign_ups", async (c) => {
    const body = await readFapiBody(c);
    const emailAddress = (body.email_address as string) ?? "";

    if (!emailAddress) {
      return c.json(
        { errors: [{ code: "form_param_missing", message: "email_address is required", long_message: "email_address is required" }], meta: {} },
        422,
      );
    }
    if (cs.emailAddresses.findOneBy("email_address", emailAddress)) {
      return c.json(
        {
          errors: [{ code: "form_identifier_exists", message: "That email address is taken.", long_message: "That email address is taken." }],
          meta: {},
        },
        422,
      );
    }

    const signUpId = generateClerkId("sua_");
    const signUp: PendingSignUp = {
      id: signUpId,
      email_address: emailAddress,
      password: (body.password as string) ?? null,
      first_name: (body.first_name as string) ?? null,
      last_name: (body.last_name as string) ?? null,
      emailVerification: null,
      status: "missing_requirements",
      createdSessionId: null,
    };
    getSignUps(store).set(signUpId, signUp);

    const json = signUpJson(signUp);
    return c.json(await fapiResponse(json, store, baseUrl, undefined, undefined, json));
  });

  // Sign-up: prepare verification (send email code)
  app.post("/v1/client/sign_ups/:signUpId/prepare_verification", async (c) => {
    const signUp = getSignUps(store).get(c.req.param("signUpId"));
    if (!signUp) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Sign-up not found");

    const body = await readFapiBody(c);
    signUp.emailVerification = { status: "unverified", strategy: (body.strategy as string) ?? "email_code" };

    const json = signUpJson(signUp);
    return c.json(await fapiResponse(json, store, baseUrl, undefined, undefined, json));
  });

  // Sign-up: attempt verification (verify email code, create the user)
  app.post("/v1/client/sign_ups/:signUpId/attempt_verification", async (c) => {
    const signUp = getSignUps(store).get(c.req.param("signUpId"));
    if (!signUp) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Sign-up not found");

    const body = await readFapiBody(c);
    if ((body.code as string) !== EMULATE_EMAIL_CODE) return incorrectCode(c);

    signUp.emailVerification = { status: "verified", strategy: "email_code" };

    // Create the user + verified email, then an active session.
    const now = nowUnix();
    const clerkId = generateClerkId("user_");
    const user = cs.users.insert({
      clerk_id: clerkId,
      username: null,
      first_name: signUp.first_name,
      last_name: signUp.last_name,
      image_url: null,
      profile_image_url: null,
      external_id: null,
      primary_email_address_id: null,
      primary_phone_number_id: null,
      password_enabled: signUp.password !== null,
      password_hash: signUp.password,
      totp_enabled: false,
      backup_code_enabled: false,
      two_factor_enabled: false,
      banned: false,
      locked: false,
      public_metadata: {},
      private_metadata: {},
      unsafe_metadata: {},
      last_active_at: null,
      last_sign_in_at: null,
      created_at_unix: now,
      updated_at_unix: now,
    });
    const emailRec = cs.emailAddresses.insert({
      email_id: generateClerkId("idn_"),
      email_address: signUp.email_address,
      user_id: clerkId,
      verification_status: "verified",
      verification_strategy: "email_code",
      is_primary: true,
      reserved: false,
      created_at_unix: now,
      updated_at_unix: now,
    });
    cs.users.update(user.id, { primary_email_address_id: emailRec.email_id });

    const session = cs.sessions.insert({
      clerk_id: generateClerkId("sess_"),
      user_id: clerkId,
      client_id: "client_emulate",
      status: "active",
      last_active_at: now,
      expire_at: now + 86400,
      abandon_at: now + 604800,
      created_at_unix: now,
      updated_at_unix: now,
    });

    signUp.status = "complete";
    signUp.createdSessionId = session.clerk_id;

    const json = signUpJson(signUp);
    return c.json(await fapiResponse(json, store, baseUrl, session.clerk_id, undefined, json));
  });

  // FAPI session token creation
  app.post("/v1/client/sessions/:sessionId/tokens", async (c) => {
    const sessionId = c.req.param("sessionId");
    const session = cs.sessions.findOneBy("clerk_id", sessionId);
    if (!session) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Session not found");

    const user = cs.users.findOneBy("clerk_id", session.user_id);
    if (!user) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "User not found");

    const memberships = cs.memberships.findBy("user_id", user.clerk_id);
    const firstMembership = memberships[0];
    let orgId: string | undefined;
    let orgRole: string | undefined;
    let orgSlug: string | undefined;
    let orgPermissions: string[] | undefined;

    if (firstMembership) {
      const org = cs.organizations.findOneBy("clerk_id", firstMembership.org_id);
      if (org) {
        orgId = org.clerk_id;
        orgRole = firstMembership.role;
        orgSlug = org.slug;
        orgPermissions = firstMembership.permissions;
      }
    }

    const jwt = await createSessionToken(store, user, sessionId, baseUrl, orgId, orgRole, orgSlug, orgPermissions);

    cs.sessions.update(session.id, { last_active_at: nowUnix() });

    return c.json({ object: "token", jwt });
  });

  // Session touch
  app.post("/v1/client/sessions/:sessionId/touch", async (c) => {
    const sessionId = c.req.param("sessionId");
    const session = cs.sessions.findOneBy("clerk_id", sessionId);
    if (!session) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Session not found");

    cs.sessions.update(session.id, { last_active_at: nowUnix() });

    // clerk-js's setActive reads the touched Session resource from `response`.
    const updated = cs.sessions.findOneBy("clerk_id", sessionId)!;
    const sessionJson = await buildSessionJson(store, baseUrl, updated);
    return c.json(await fapiResponse(sessionJson, store, baseUrl, sessionId));
  });

  // Sign out of all sessions — clerk-js sends DELETE /v1/client/sessions
  // (delivered as POST with ?_method=DELETE due to a Safari CORS workaround).
  const removeAllSessionsHandler = async (c: Context<AppEnv>) => {
    const now = nowUnix();
    for (const s of cs.sessions.all()) {
      if (s.status === "active") {
        cs.sessions.update(s.id, { status: "ended", updated_at_unix: now });
      }
    }
    return c.json(await fapiResponse(await buildClientJson(store, baseUrl), store, baseUrl));
  };
  app.post("/v1/client/sessions", removeAllSessionsHandler);
  app.delete("/v1/client/sessions", removeAllSessionsHandler);

  // Single session end
  app.delete("/v1/client/sessions/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const session = cs.sessions.findOneBy("clerk_id", sessionId);
    if (!session) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Session not found");

    cs.sessions.update(session.id, { status: "ended", updated_at_unix: nowUnix() });

    return c.json(await fapiResponse({ object: "session", id: sessionId, status: "ended" }, store, baseUrl));
  });

  // User's organization memberships (FAPI path)
  app.get("/v1/me/organization_memberships", async (c) => {
    const empty = { data: [], total_count: 0 };
    const sessionId = c.req.query("_clerk_session_id");
    if (!sessionId) return c.json(await fapiResponse(empty, store, baseUrl));

    const session = cs.sessions.findOneBy("clerk_id", sessionId);
    if (!session) return c.json(await fapiResponse(empty, store, baseUrl));

    const memberships = cs.memberships.findBy("user_id", session.user_id);
    const data = memberships.map((m) => {
      const org = cs.organizations.findOneBy("clerk_id", m.org_id);
      return {
        object: "organization_membership",
        id: m.membership_id,
        role: m.role,
        permissions: m.permissions,
        public_metadata: m.public_metadata,
        organization: org
          ? {
              object: "organization",
              id: org.clerk_id,
              name: org.name,
              slug: org.slug,
              image_url: org.image_url,
              has_image: org.image_url !== null,
              members_count: org.members_count,
              public_metadata: org.public_metadata,
            }
          : null,
        created_at: m.created_at_unix * 1000,
        updated_at: m.updated_at_unix * 1000,
      };
    });

    return c.json(await fapiResponse({ data, total_count: data.length }, store, baseUrl, sessionId));
  });

  // Proxy clerk-js from CDN
  app.get("/npm/:path{.+}", async (c) => {
    const path = c.req.param("path");
    try {
      const cdnRes = await fetch(`https://cdn.jsdelivr.net/npm/${path}`);
      const body = await cdnRes.text();
      const contentType = cdnRes.headers.get("content-type") ?? "application/javascript";
      return c.body(body, 200, { "Content-Type": contentType, "Access-Control-Allow-Origin": "*" });
    } catch {
      return c.text("Failed to load clerk-js", 502);
    }
  });
}
