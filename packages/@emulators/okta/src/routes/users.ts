import { parsePagination, setLinkHeader, type RouteContext } from "@emulators/core";
import { boolFromQuery, generateOktaId, nowIso, userDisplayName } from "../helpers.js";
import { findUserByRef, oktaError, readJsonObject, requireManagementAuth, userResponse } from "../route-helpers.js";
import { getOktaStore } from "../store.js";
import type { OktaUser, OktaUserStatus } from "../entities.js";

function updateUserProfile(user: OktaUser, profile: Record<string, unknown>): Partial<OktaUser> {
  const nextFirstName = typeof profile.firstName === "string" ? profile.firstName : user.first_name;
  const nextLastName = typeof profile.lastName === "string" ? profile.lastName : user.last_name;
  const nextDisplayName =
    typeof profile.displayName === "string"
      ? profile.displayName
      : typeof profile.nickName === "string"
        ? profile.nickName
        : user.display_name;

  return {
    login: typeof profile.login === "string" ? profile.login : user.login,
    email: typeof profile.email === "string" ? profile.email : user.email,
    first_name: nextFirstName,
    last_name: nextLastName,
    display_name: nextDisplayName || `${nextFirstName} ${nextLastName}`.trim(),
    locale: typeof profile.locale === "string" ? profile.locale : user.locale,
    time_zone: typeof profile.timeZone === "string" ? profile.timeZone : user.time_zone,
  };
}

function setLifecycleStatus(user: OktaUser, target: OktaUserStatus): Partial<OktaUser> {
  const now = nowIso();
  const activatedAt = target === "ACTIVE" ? (user.activated_at ?? now) : user.activated_at;
  return {
    status: target,
    transitioning_to_status: null,
    status_changed_at: now,
    activated_at: activatedAt,
  };
}

export function userRoutes({ app, store, baseUrl, tokenMap }: RouteContext): void {
  const oktaStore = getOktaStore(store);

  app.get("/api/v1/users", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const q = (c.req.query("q") ?? "").toLowerCase();
    const search = (c.req.query("search") ?? "").toLowerCase();
    const filter = c.req.query("filter") ?? "";

    let users = oktaStore.users.all();

    if (q) {
      users = users.filter((user) =>
        [user.login, user.email, user.first_name, user.last_name, user.display_name]
          .join(" ")
          .toLowerCase()
          .includes(q),
      );
    }

    if (search) {
      users = users.filter((user) =>
        [user.login, user.email, user.first_name, user.last_name, user.display_name]
          .join(" ")
          .toLowerCase()
          .includes(search),
      );
    }

    if (filter) {
      const statusMatch = filter.match(/status\s+eq\s+"?([A-Z_]+)"?/i);
      if (statusMatch?.[1]) {
        users = users.filter((user) => user.status === statusMatch[1]);
      }
    }

    const { page, per_page } = parsePagination(c);
    const total = users.length;
    const start = (page - 1) * per_page;
    const paged = users.slice(start, start + per_page);
    setLinkHeader(c, total, page, per_page);
    c.header("X-Total-Count", String(total));

    return c.json(paged.map((user) => userResponse(baseUrl, user)));
  });

  app.post("/api/v1/users", async (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const body = await readJsonObject(c);
    const profile = (body.profile && typeof body.profile === "object" ? body.profile : {}) as Record<string, unknown>;
    const login = typeof profile.login === "string" ? profile.login.trim() : "";
    const email = typeof profile.email === "string" ? profile.email.trim() : login;

    if (!login || !email) {
      return oktaError(c, 400, "E0000001", "profile.login and profile.email are required");
    }

    if (oktaStore.users.findOneBy("login", login) || oktaStore.users.findOneBy("email", email)) {
      return oktaError(c, 400, "E0000001", "A user with the same login or email already exists");
    }

    const activate = boolFromQuery(c.req.query("activate"), true);
    const now = nowIso();
    const firstName = typeof profile.firstName === "string" ? profile.firstName : "Test";
    const lastName = typeof profile.lastName === "string" ? profile.lastName : "User";
    const displayName =
      typeof profile.displayName === "string"
        ? profile.displayName
        : `${firstName} ${lastName}`.trim() || login;

    const created = oktaStore.users.insert({
      okta_id: generateOktaId("00u"),
      status: activate ? "ACTIVE" : "STAGED",
      activated_at: activate ? now : null,
      status_changed_at: now,
      last_login_at: null,
      password_changed_at: null,
      transitioning_to_status: null,
      login,
      email,
      first_name: firstName,
      last_name: lastName,
      display_name: displayName,
      locale: typeof profile.locale === "string" ? profile.locale : "en-US",
      time_zone: typeof profile.timeZone === "string" ? profile.timeZone : "UTC",
    });

    return c.json(userResponse(baseUrl, created), 201);
  });

  app.get("/api/v1/users/me", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    const user = oktaStore.users.findOneBy("login", auth.login) ?? oktaStore.users.all()[0];
    if (!user) return oktaError(c, 404, "E0000007", "Not found: user");

    const response = userResponse(baseUrl, user);
    return c.json({
      ...response,
      profile: {
        ...(response.profile as Record<string, unknown>),
        displayName: userDisplayName(user),
      },
    });
  });

  app.get("/api/v1/users/:userId/groups", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const user = findUserByRef(oktaStore, c.req.param("userId"));
    if (!user) return oktaError(c, 404, "E0000007", "Not found: user");

    const memberships = oktaStore.groupMemberships.findBy("user_okta_id", user.okta_id);
    const groups = memberships
      .map((membership) => oktaStore.groups.findOneBy("okta_id", membership.group_okta_id))
      .filter((group): group is NonNullable<typeof group> => Boolean(group));

    return c.json(groups.map((group) => ({
      id: group.okta_id,
      profile: {
        name: group.name,
        description: group.description,
      },
      type: group.type,
    })));
  });

  app.post("/api/v1/users/:userId/lifecycle/activate", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    const user = findUserByRef(oktaStore, c.req.param("userId"));
    if (!user) return oktaError(c, 404, "E0000007", "Not found: user");
    const updated = oktaStore.users.update(user.id, setLifecycleStatus(user, "ACTIVE"));
    return c.json(userResponse(baseUrl, updated ?? user));
  });

  app.post("/api/v1/users/:userId/lifecycle/deactivate", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    const user = findUserByRef(oktaStore, c.req.param("userId"));
    if (!user) return oktaError(c, 404, "E0000007", "Not found: user");
    const updated = oktaStore.users.update(user.id, setLifecycleStatus(user, "DEPROVISIONED"));
    return c.json(userResponse(baseUrl, updated ?? user));
  });

  app.post("/api/v1/users/:userId/lifecycle/suspend", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    const user = findUserByRef(oktaStore, c.req.param("userId"));
    if (!user) return oktaError(c, 404, "E0000007", "Not found: user");
    const updated = oktaStore.users.update(user.id, setLifecycleStatus(user, "SUSPENDED"));
    return c.json(userResponse(baseUrl, updated ?? user));
  });

  app.post("/api/v1/users/:userId/lifecycle/unsuspend", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    const user = findUserByRef(oktaStore, c.req.param("userId"));
    if (!user) return oktaError(c, 404, "E0000007", "Not found: user");
    const updated = oktaStore.users.update(user.id, setLifecycleStatus(user, "ACTIVE"));
    return c.json(userResponse(baseUrl, updated ?? user));
  });

  app.get("/api/v1/users/:userId", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const user = findUserByRef(oktaStore, c.req.param("userId"));
    if (!user) return oktaError(c, 404, "E0000007", "Not found: user");
    return c.json(userResponse(baseUrl, user));
  });

  app.put("/api/v1/users/:userId", async (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const user = findUserByRef(oktaStore, c.req.param("userId"));
    if (!user) return oktaError(c, 404, "E0000007", "Not found: user");

    const body = await readJsonObject(c);
    const profile = (body.profile && typeof body.profile === "object" ? body.profile : {}) as Record<string, unknown>;

    const updates = updateUserProfile(user, profile);
    if (
      (updates.login !== user.login && oktaStore.users.findOneBy("login", updates.login ?? "")) ||
      (updates.email !== user.email && oktaStore.users.findOneBy("email", updates.email ?? ""))
    ) {
      return oktaError(c, 400, "E0000001", "A user with the same login or email already exists");
    }

    const updated = oktaStore.users.update(user.id, updates);
    return c.json(userResponse(baseUrl, updated ?? user));
  });

  app.post("/api/v1/users/:userId", async (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const user = findUserByRef(oktaStore, c.req.param("userId"));
    if (!user) return oktaError(c, 404, "E0000007", "Not found: user");

    const body = await readJsonObject(c);
    const profile = (body.profile && typeof body.profile === "object" ? body.profile : {}) as Record<string, unknown>;
    const updates = updateUserProfile(user, profile);
    const updated = oktaStore.users.update(user.id, updates);
    return c.json(userResponse(baseUrl, updated ?? user));
  });

  app.delete("/api/v1/users/:userId", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const user = findUserByRef(oktaStore, c.req.param("userId"));
    if (!user) return oktaError(c, 404, "E0000007", "Not found: user");

    // Match Okta behavior: first delete request deactivates, second removes.
    if (user.status !== "DEPROVISIONED") {
      oktaStore.users.update(user.id, setLifecycleStatus(user, "DEPROVISIONED"));
      return new Response(null, { status: 204 });
    }

    for (const membership of oktaStore.groupMemberships.findBy("user_okta_id", user.okta_id)) {
      oktaStore.groupMemberships.delete(membership.id);
    }
    for (const assignment of oktaStore.appAssignments.findBy("user_okta_id", user.okta_id)) {
      oktaStore.appAssignments.delete(assignment.id);
    }

    oktaStore.users.delete(user.id);
    return new Response(null, { status: 204 });
  });

  app.post("/api/v1/users/:userId/lifecycle/reactivate", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    const user = findUserByRef(oktaStore, c.req.param("userId"));
    if (!user) return oktaError(c, 404, "E0000007", "Not found: user");
    const updated = oktaStore.users.update(user.id, {
      status: "PROVISIONED",
      status_changed_at: nowIso(),
      transitioning_to_status: null,
    });
    return c.json(userResponse(baseUrl, updated ?? user));
  });
}
