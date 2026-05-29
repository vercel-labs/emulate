import type { RouteContext, Store, Context, AppEnv } from "@emulators/core";
import { generateClerkId, nowUnix } from "../helpers.js";
import { clerkError, userResponse, resolvePrimaryOrgClaims } from "../route-helpers.js";
import { getClerkStore } from "../store.js";
import { createSessionToken } from "./oauth.js";
import { buildEnvironmentJson } from "./fapi-environment.js";
import { fapiResponse, buildClientJson, buildSessionJson, fapiMembershipJson } from "./fapi-serializers.js";
import { dispatchClerkEvent } from "../webhook-events.js";
import type { ClerkUser } from "../entities.js";

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

// FAPI form-validation error envelope (HTTP 422), as clerk-js expects.
function fapiFormError(c: Context<AppEnv>, code: string, message: string) {
  return c.json({ errors: [{ code, message, long_message: message }], meta: {} }, 422);
}

const PASSWORD_INCORRECT = "Password is incorrect. Try again, or use another method.";
const CODE_INCORRECT = "Incorrect code. Try again.";

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

// First factor verified with `strategy`: go to MFA if the user has TOTP enabled, else complete.
function advanceAfterFirstFactor(cs: ReturnType<typeof getClerkStore>, signIn: PendingSignIn, strategy: string): void {
  signIn.firstFactorVerification = { status: "verified", strategy };
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

export function fapiRoutes({ app, store, webhooks, baseUrl }: RouteContext): void {
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

  // Sign-in: create
  app.post("/v1/client/sign_ins", async (c) => {
    const body = await readFapiBody(c);
    const identifier = (body.identifier as string) ?? "";

    const email = cs.emailAddresses.findOneBy("email_address", identifier);
    if (!email) return fapiFormError(c, "form_identifier_not_found", "Couldn't find your account.");

    const user = cs.users.findOneBy("clerk_id", email.user_id);
    if (!user) return fapiFormError(c, "form_identifier_not_found", "Couldn't find your account.");

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
      if (user.password_hash !== password) return fapiFormError(c, "form_password_incorrect", PASSWORD_INCORRECT);
      advanceAfterFirstFactor(cs, signIn, "password");
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
      if (signIn.user.password_hash !== (body.password as string)) return fapiFormError(c, "form_password_incorrect", PASSWORD_INCORRECT);
    } else if (strategy === "email_code") {
      if ((body.code as string) !== EMULATE_EMAIL_CODE) return fapiFormError(c, "form_code_incorrect", CODE_INCORRECT);
    }

    advanceAfterFirstFactor(cs, signIn, strategy);
    const json = signInJson(cs, signIn);
    return c.json(await fapiResponse(json, store, baseUrl, signIn.createdSessionId, json));
  });

  // Sign-in: attempt second factor (TOTP MFA)
  app.post("/v1/client/sign_ins/:signInId/attempt_second_factor", async (c) => {
    const signIn = getSignIns(store).get(c.req.param("signInId"));
    if (!signIn) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Sign-in not found");

    const body = await readFapiBody(c);
    const strategy = (body.strategy as string) ?? "totp";
    if ((body.code as string) !== EMULATE_TOTP_CODE) return fapiFormError(c, "form_code_incorrect", CODE_INCORRECT);

    signIn.secondFactorVerification = { status: "verified", strategy };
    const session = completeSignIn(cs, signIn);
    const json = signInJson(cs, signIn);
    return c.json(await fapiResponse(json, store, baseUrl, session.clerk_id, json));
  });

  // Sign-up: create
  app.post("/v1/client/sign_ups", async (c) => {
    const body = await readFapiBody(c);
    const emailAddress = (body.email_address as string) ?? "";

    if (!emailAddress) return fapiFormError(c, "form_param_missing", "email_address is required");
    if (cs.emailAddresses.findOneBy("email_address", emailAddress)) {
      return fapiFormError(c, "form_identifier_exists", "That email address is taken.");
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
    if ((body.code as string) !== EMULATE_EMAIL_CODE) return fapiFormError(c, "form_code_incorrect", CODE_INCORRECT);

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

    // Real Clerk fires user.created when a user registers via the frontend (FAPI),
    // not just via the Backend API. See clerk.com/docs/webhooks — user.created
    // "triggers when a new user registers in the app".
    const created = cs.users.findOneBy("clerk_id", clerkId)!;
    dispatchClerkEvent(webhooks, "user.created", userResponse(created, cs.emailAddresses.findBy("user_id", clerkId)));

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

    const jwt = await createSessionToken(store, user, sessionId, baseUrl, resolvePrimaryOrgClaims(cs, user));

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

    const data = cs.memberships
      .findBy("user_id", session.user_id)
      .map((m) => fapiMembershipJson(cs, m))
      .filter((m): m is Record<string, unknown> => m !== null);

    return c.json(await fapiResponse({ data, total_count: data.length }, store, baseUrl, sessionId));
  });
}
