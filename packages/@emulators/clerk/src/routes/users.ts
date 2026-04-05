import type { RouteContext } from "@emulators/core";
import { generateClerkId, nowUnix } from "../helpers.js";
import {
  clerkError,
  requireSecretKey,
  isAuthResponse,
  deletedResponse,
  paginatedResponse,
  parsePagination,
  userResponse,
  readJsonBody,
} from "../route-helpers.js";
import { getClerkStore } from "../store.js";

export function userRoutes({ app, store, tokenMap }: RouteContext): void {
  const cs = getClerkStore(store);

  app.get("/v1/users", (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const { limit, offset } = parsePagination(c);
    const query = c.req.query("query");
    const orderBy = c.req.query("order_by") ?? "-created_at";
    const emailFilter = c.req.queries("email_address");

    let users = cs.users.all();

    if (query) {
      const q = query.toLowerCase();
      users = users.filter((u) => {
        const emails = cs.emailAddresses.findBy("user_id", u.clerk_id);
        return (
          u.first_name?.toLowerCase().includes(q) ||
          u.last_name?.toLowerCase().includes(q) ||
          u.username?.toLowerCase().includes(q) ||
          emails.some((e) => e.email_address.toLowerCase().includes(q))
        );
      });
    }

    if (emailFilter && emailFilter.length > 0) {
      const emailSet = new Set(emailFilter.map((e) => e.toLowerCase()));
      users = users.filter((u) => {
        const emails = cs.emailAddresses.findBy("user_id", u.clerk_id);
        return emails.some((e) => emailSet.has(e.email_address.toLowerCase()));
      });
    }

    const desc = orderBy.startsWith("-");
    const field = orderBy.replace(/^-/, "");
    users.sort((a, b) => {
      const aVal = field === "created_at" ? a.created_at_unix : a.updated_at_unix;
      const bVal = field === "created_at" ? b.created_at_unix : b.updated_at_unix;
      return desc ? bVal - aVal : aVal - bVal;
    });

    const totalCount = users.length;
    const paged = users.slice(offset, offset + limit);

    const data = paged.map((u) => {
      const emails = cs.emailAddresses.findBy("user_id", u.clerk_id);
      return userResponse(u, emails);
    });

    return c.json(paginatedResponse(data, totalCount, limit, offset));
  });

  app.get("/v1/users/count", (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    return c.json({ object: "total_count", total_count: cs.users.all().length });
  });

  app.get("/v1/users/:userId", (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const userId = c.req.param("userId");
    const user = cs.users.findOneBy("clerk_id", userId);
    if (!user) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "User not found");

    const emails = cs.emailAddresses.findBy("user_id", user.clerk_id);
    return c.json(userResponse(user, emails));
  });

  app.post("/v1/users", async (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const body = await readJsonBody(c);
    const now = nowUnix();
    const clerkId = generateClerkId("user_");

    const user = cs.users.insert({
      clerk_id: clerkId,
      username: (body.username as string) ?? null,
      first_name: (body.first_name as string) ?? null,
      last_name: (body.last_name as string) ?? null,
      image_url: null,
      profile_image_url: null,
      external_id: (body.external_id as string) ?? null,
      primary_email_address_id: null,
      primary_phone_number_id: null,
      password_enabled: typeof body.password === "string" && body.password.length > 0,
      password_hash: (body.password as string) ?? null,
      totp_enabled: false,
      backup_code_enabled: false,
      two_factor_enabled: false,
      banned: false,
      locked: false,
      public_metadata: (body.public_metadata as Record<string, unknown>) ?? {},
      private_metadata: (body.private_metadata as Record<string, unknown>) ?? {},
      unsafe_metadata: (body.unsafe_metadata as Record<string, unknown>) ?? {},
      last_active_at: null,
      last_sign_in_at: null,
      created_at_unix: now,
      updated_at_unix: now,
    });

    const emailAddr = (body.email_address as string[] | string) ?? [];
    const emailList = Array.isArray(emailAddr) ? emailAddr : [emailAddr];
    let primaryEmailId: string | null = null;

    for (let i = 0; i < emailList.length; i++) {
      const email = cs.emailAddresses.insert({
        email_id: generateClerkId("idn_"),
        email_address: emailList[i],
        user_id: clerkId,
        verification_status: "verified",
        verification_strategy: "email_code",
        is_primary: i === 0,
        reserved: false,
        created_at_unix: now,
        updated_at_unix: now,
      });
      if (i === 0) primaryEmailId = email.email_id;
    }

    if (primaryEmailId) {
      cs.users.update(user.id, { primary_email_address_id: primaryEmailId });
    }

    const emails = cs.emailAddresses.findBy("user_id", clerkId);
    const updatedUser = cs.users.findOneBy("clerk_id", clerkId)!;
    return c.json(userResponse(updatedUser, emails), 200);
  });

  app.patch("/v1/users/:userId", async (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const userId = c.req.param("userId");
    const user = cs.users.findOneBy("clerk_id", userId);
    if (!user) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "User not found");

    const body = await readJsonBody(c);
    const now = nowUnix();
    const patch: Partial<typeof user> = { updated_at_unix: now };

    if (body.first_name !== undefined) patch.first_name = body.first_name as string | null;
    if (body.last_name !== undefined) patch.last_name = body.last_name as string | null;
    if (body.username !== undefined) patch.username = body.username as string | null;
    if (body.external_id !== undefined) patch.external_id = body.external_id as string | null;
    if (body.primary_email_address_id !== undefined) patch.primary_email_address_id = body.primary_email_address_id as string;
    if (body.primary_phone_number_id !== undefined) patch.primary_phone_number_id = body.primary_phone_number_id as string;
    if (body.public_metadata !== undefined) patch.public_metadata = body.public_metadata as Record<string, unknown>;
    if (body.private_metadata !== undefined) patch.private_metadata = body.private_metadata as Record<string, unknown>;
    if (body.unsafe_metadata !== undefined) patch.unsafe_metadata = body.unsafe_metadata as Record<string, unknown>;
    if (typeof body.password === "string") {
      patch.password_enabled = body.password.length > 0;
      patch.password_hash = body.password;
    }

    cs.users.update(user.id, patch);
    const updated = cs.users.findOneBy("clerk_id", userId)!;
    const emails = cs.emailAddresses.findBy("user_id", userId);
    return c.json(userResponse(updated, emails));
  });

  app.delete("/v1/users/:userId", (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const userId = c.req.param("userId");
    const user = cs.users.findOneBy("clerk_id", userId);
    if (!user) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "User not found");

    for (const email of cs.emailAddresses.findBy("user_id", userId)) {
      cs.emailAddresses.delete(email.id);
    }
    for (const membership of cs.memberships.findBy("user_id", userId)) {
      cs.memberships.delete(membership.id);
      const org = cs.organizations.findOneBy("clerk_id", membership.org_id);
      if (org) cs.organizations.update(org.id, { members_count: Math.max(0, org.members_count - 1) });
    }
    for (const session of cs.sessions.findBy("user_id", userId)) {
      cs.sessions.delete(session.id);
    }
    cs.users.delete(user.id);

    return c.json(deletedResponse("user", userId));
  });

  app.post("/v1/users/:userId/ban", (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const userId = c.req.param("userId");
    const user = cs.users.findOneBy("clerk_id", userId);
    if (!user) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "User not found");

    cs.users.update(user.id, { banned: true, updated_at_unix: nowUnix() });
    const updated = cs.users.findOneBy("clerk_id", userId)!;
    const emails = cs.emailAddresses.findBy("user_id", userId);
    return c.json(userResponse(updated, emails));
  });

  app.post("/v1/users/:userId/unban", (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const userId = c.req.param("userId");
    const user = cs.users.findOneBy("clerk_id", userId);
    if (!user) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "User not found");

    cs.users.update(user.id, { banned: false, updated_at_unix: nowUnix() });
    const updated = cs.users.findOneBy("clerk_id", userId)!;
    const emails = cs.emailAddresses.findBy("user_id", userId);
    return c.json(userResponse(updated, emails));
  });

  app.post("/v1/users/:userId/lock", (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const userId = c.req.param("userId");
    const user = cs.users.findOneBy("clerk_id", userId);
    if (!user) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "User not found");

    cs.users.update(user.id, { locked: true, updated_at_unix: nowUnix() });
    const updated = cs.users.findOneBy("clerk_id", userId)!;
    const emails = cs.emailAddresses.findBy("user_id", userId);
    return c.json(userResponse(updated, emails));
  });

  app.post("/v1/users/:userId/unlock", (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const userId = c.req.param("userId");
    const user = cs.users.findOneBy("clerk_id", userId);
    if (!user) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "User not found");

    cs.users.update(user.id, { locked: false, updated_at_unix: nowUnix() });
    const updated = cs.users.findOneBy("clerk_id", userId)!;
    const emails = cs.emailAddresses.findBy("user_id", userId);
    return c.json(userResponse(updated, emails));
  });

  app.patch("/v1/users/:userId/metadata", async (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const userId = c.req.param("userId");
    const user = cs.users.findOneBy("clerk_id", userId);
    if (!user) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "User not found");

    const body = await readJsonBody(c);
    const patch: Partial<typeof user> = { updated_at_unix: nowUnix() };

    if (body.public_metadata !== undefined) {
      patch.public_metadata = { ...user.public_metadata, ...(body.public_metadata as Record<string, unknown>) };
    }
    if (body.private_metadata !== undefined) {
      patch.private_metadata = { ...user.private_metadata, ...(body.private_metadata as Record<string, unknown>) };
    }
    if (body.unsafe_metadata !== undefined) {
      patch.unsafe_metadata = { ...user.unsafe_metadata, ...(body.unsafe_metadata as Record<string, unknown>) };
    }

    cs.users.update(user.id, patch);
    const updated = cs.users.findOneBy("clerk_id", userId)!;
    const emails = cs.emailAddresses.findBy("user_id", userId);
    return c.json(userResponse(updated, emails));
  });

  app.post("/v1/users/:userId/verify_password", async (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const userId = c.req.param("userId");
    const user = cs.users.findOneBy("clerk_id", userId);
    if (!user) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "User not found");

    const body = await readJsonBody(c);
    const password = body.password as string;
    const verified = user.password_hash === password;

    return c.json({ object: "verification", verified });
  });
}
