import type { RouteContext } from "@emulators/core";
import { generateClerkId, nowUnix } from "../helpers.js";
import {
  clerkError,
  requireSecretKey,
  isAuthResponse,
  paginatedResponse,
  parsePagination,
  sessionResponse,
  readJsonBody,
} from "../route-helpers.js";
import { getClerkStore } from "../store.js";
import { createSessionToken } from "./oauth.js";

export function sessionRoutes({ app, store, baseUrl, tokenMap }: RouteContext): void {
  const cs = getClerkStore(store);

  app.get("/v1/sessions", (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const { limit, offset } = parsePagination(c);
    const userIdFilter = c.req.query("user_id");

    let sessions = cs.sessions.all();

    if (userIdFilter) {
      sessions = sessions.filter((s) => s.user_id === userIdFilter);
    }

    sessions.sort((a, b) => b.created_at_unix - a.created_at_unix);
    const totalCount = sessions.length;
    const paged = sessions.slice(offset, offset + limit);

    return c.json(paginatedResponse(paged.map(sessionResponse), totalCount, limit, offset));
  });

  app.get("/v1/sessions/:sessionId", (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const sessionId = c.req.param("sessionId");
    const session = cs.sessions.findOneBy("clerk_id", sessionId);
    if (!session) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Session not found");

    return c.json(sessionResponse(session));
  });

  app.post("/v1/sessions", async (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const body = await readJsonBody(c);
    const userId = body.user_id as string;
    if (!userId) return clerkError(c, 422, "INVALID_REQUEST_BODY", "user_id is required");

    const user = cs.users.findOneBy("clerk_id", userId);
    if (!user) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "User not found");

    const now = nowUnix();
    const session = cs.sessions.insert({
      clerk_id: generateClerkId("sess_"),
      user_id: userId,
      client_id: (body.client_id as string) ?? "client_emulate",
      status: "active",
      last_active_at: now,
      expire_at: now + 86400,
      abandon_at: now + 604800,
      created_at_unix: now,
      updated_at_unix: now,
    });

    cs.users.update(user.id, { last_active_at: now, last_sign_in_at: now, updated_at_unix: now });

    return c.json(sessionResponse(session), 200);
  });

  app.post("/v1/sessions/:sessionId/revoke", (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const sessionId = c.req.param("sessionId");
    const session = cs.sessions.findOneBy("clerk_id", sessionId);
    if (!session) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Session not found");

    cs.sessions.update(session.id, { status: "revoked", updated_at_unix: nowUnix() });
    const updated = cs.sessions.findOneBy("clerk_id", sessionId)!;
    return c.json(sessionResponse(updated));
  });

  app.post("/v1/sessions/:sessionId/tokens", async (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const sessionId = c.req.param("sessionId");
    const session = cs.sessions.findOneBy("clerk_id", sessionId);
    if (!session) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Session not found");

    if (session.status !== "active") {
      return clerkError(c, 422, "SESSION_NOT_ACTIVE", "Session is not active");
    }

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

  app.post("/v1/sessions/:sessionId/tokens/:template", async (c) => {
    const auth = requireSecretKey(c, tokenMap);
    if (isAuthResponse(auth)) return auth;

    const sessionId = c.req.param("sessionId");
    const session = cs.sessions.findOneBy("clerk_id", sessionId);
    if (!session) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "Session not found");

    if (session.status !== "active") {
      return clerkError(c, 422, "SESSION_NOT_ACTIVE", "Session is not active");
    }

    const user = cs.users.findOneBy("clerk_id", session.user_id);
    if (!user) return clerkError(c, 404, "RESOURCE_NOT_FOUND", "User not found");

    const jwt = await createSessionToken(store, user, sessionId, baseUrl);

    cs.sessions.update(session.id, { last_active_at: nowUnix() });

    return c.json({ object: "token", jwt });
  });
}
