import { parsePagination, setLinkHeader, type RouteContext } from "@emulators/core";
import { generateOktaId, normalizeAppStatus } from "../helpers.js";
import {
  appResponse,
  findAppByRef,
  findUserByRef,
  oktaError,
  readJsonObject,
  requireManagementAuth,
  userResponse,
} from "../route-helpers.js";
import { getOktaStore } from "../store.js";

export function appRoutes({ app, store, baseUrl, tokenMap }: RouteContext): void {
  const oktaStore = getOktaStore(store);

  app.get("/api/v1/apps", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const q = (c.req.query("q") ?? "").toLowerCase();
    let apps = oktaStore.apps.all();
    if (q) {
      apps = apps.filter((entry) =>
        `${entry.name} ${entry.label}`.toLowerCase().includes(q),
      );
    }
    const { page, per_page } = parsePagination(c);
    const total = apps.length;
    const start = (page - 1) * per_page;
    const paged = apps.slice(start, start + per_page);
    setLinkHeader(c, total, page, per_page);
    c.header("X-Total-Count", String(total));

    return c.json(paged.map((entry) => appResponse(baseUrl, entry)));
  });

  app.post("/api/v1/apps", async (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const body = await readJsonObject(c);
    const name = typeof body.name === "string" ? body.name : "oidc_client";
    const label = typeof body.label === "string" ? body.label : "Okta App";
    const signOnMode = typeof body.signOnMode === "string" ? body.signOnMode : "OPENID_CONNECT";
    const settings = body.settings && typeof body.settings === "object"
      ? (body.settings as Record<string, unknown>)
      : {};
    const credentials = body.credentials && typeof body.credentials === "object"
      ? (body.credentials as Record<string, unknown>)
      : {};

    const created = oktaStore.apps.insert({
      okta_id: generateOktaId("0oa"),
      name,
      label,
      status: normalizeAppStatus(typeof body.status === "string" ? body.status : undefined, "ACTIVE"),
      sign_on_mode: signOnMode,
      settings,
      credentials,
    });

    return c.json(appResponse(baseUrl, created), 201);
  });

  app.get("/api/v1/apps/:appId/users", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const appEntity = findAppByRef(oktaStore, c.req.param("appId"));
    if (!appEntity) return oktaError(c, 404, "E0000007", "Not found: app");

    const assignments = oktaStore.appAssignments.findBy("app_okta_id", appEntity.okta_id);
    const users = assignments
      .map((assignment) => oktaStore.users.findOneBy("okta_id", assignment.user_okta_id))
      .filter((user): user is NonNullable<typeof user> => Boolean(user));

    return c.json(
      users.map((user) => ({
        id: user.okta_id,
        scope: "USER",
        credentials: { userName: user.login },
        profile: (userResponse(baseUrl, user).profile as Record<string, unknown>),
      })),
    );
  });

  app.put("/api/v1/apps/:appId/users/:userId", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const appEntity = findAppByRef(oktaStore, c.req.param("appId"));
    if (!appEntity) return oktaError(c, 404, "E0000007", "Not found: app");
    const user = findUserByRef(oktaStore, c.req.param("userId"));
    if (!user) return oktaError(c, 404, "E0000007", "Not found: user");

    const existing = oktaStore.appAssignments
      .findBy("app_okta_id", appEntity.okta_id)
      .find((assignment) => assignment.user_okta_id === user.okta_id);
    if (!existing) {
      oktaStore.appAssignments.insert({
        app_okta_id: appEntity.okta_id,
        user_okta_id: user.okta_id,
      });
    }

    return new Response(null, { status: 204 });
  });

  app.delete("/api/v1/apps/:appId/users/:userId", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const appEntity = findAppByRef(oktaStore, c.req.param("appId"));
    if (!appEntity) return oktaError(c, 404, "E0000007", "Not found: app");
    const user = findUserByRef(oktaStore, c.req.param("userId"));
    if (!user) return oktaError(c, 404, "E0000007", "Not found: user");

    const existing = oktaStore.appAssignments
      .findBy("app_okta_id", appEntity.okta_id)
      .find((assignment) => assignment.user_okta_id === user.okta_id);
    if (existing) oktaStore.appAssignments.delete(existing.id);
    return new Response(null, { status: 204 });
  });

  app.post("/api/v1/apps/:appId/lifecycle/activate", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    const appEntity = findAppByRef(oktaStore, c.req.param("appId"));
    if (!appEntity) return oktaError(c, 404, "E0000007", "Not found: app");

    const updated = oktaStore.apps.update(appEntity.id, { status: "ACTIVE" });
    return c.json(appResponse(baseUrl, updated ?? appEntity));
  });

  app.post("/api/v1/apps/:appId/lifecycle/deactivate", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    const appEntity = findAppByRef(oktaStore, c.req.param("appId"));
    if (!appEntity) return oktaError(c, 404, "E0000007", "Not found: app");

    const updated = oktaStore.apps.update(appEntity.id, { status: "INACTIVE" });
    return c.json(appResponse(baseUrl, updated ?? appEntity));
  });

  app.get("/api/v1/apps/:appId", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const appEntity = findAppByRef(oktaStore, c.req.param("appId"));
    if (!appEntity) return oktaError(c, 404, "E0000007", "Not found: app");
    return c.json(appResponse(baseUrl, appEntity));
  });

  app.put("/api/v1/apps/:appId", async (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const appEntity = findAppByRef(oktaStore, c.req.param("appId"));
    if (!appEntity) return oktaError(c, 404, "E0000007", "Not found: app");

    const body = await readJsonObject(c);
    const updated = oktaStore.apps.update(appEntity.id, {
      name: typeof body.name === "string" ? body.name : appEntity.name,
      label: typeof body.label === "string" ? body.label : appEntity.label,
      status: normalizeAppStatus(typeof body.status === "string" ? body.status : undefined, appEntity.status),
      sign_on_mode: typeof body.signOnMode === "string" ? body.signOnMode : appEntity.sign_on_mode,
      settings: body.settings && typeof body.settings === "object"
        ? (body.settings as Record<string, unknown>)
        : appEntity.settings,
      credentials: body.credentials && typeof body.credentials === "object"
        ? (body.credentials as Record<string, unknown>)
        : appEntity.credentials,
    });
    return c.json(appResponse(baseUrl, updated ?? appEntity));
  });

  app.delete("/api/v1/apps/:appId", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const appEntity = findAppByRef(oktaStore, c.req.param("appId"));
    if (!appEntity) return oktaError(c, 404, "E0000007", "Not found: app");
    if (appEntity.status !== "INACTIVE") {
      return oktaError(c, 400, "E0000001", "App must be INACTIVE before deletion");
    }

    for (const assignment of oktaStore.appAssignments.findBy("app_okta_id", appEntity.okta_id)) {
      oktaStore.appAssignments.delete(assignment.id);
    }
    oktaStore.apps.delete(appEntity.id);
    return new Response(null, { status: 204 });
  });
}
