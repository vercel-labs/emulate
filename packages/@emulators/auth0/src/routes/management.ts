import type { Context } from "hono";
import { parsePagination, setLinkHeader, type AppEnv, type RouteContext } from "@emulators/core";
import type {
  Auth0ApplicationType,
  Auth0ConnectionStrategy,
  Auth0TokenEndpointAuthMethod,
  Auth0User,
} from "../entities.js";
import { generateAuth0Id, userIdForConnection } from "../helpers.js";
import {
  applicationResponse,
  auth0Error,
  connectionResponse,
  findApplicationByRef,
  findConnectionByRef,
  findOrganizationByRef,
  findRoleByRef,
  findUserByRef,
  organizationResponse,
  readJsonObject,
  requireManagementAuth,
  roleResponse,
  userResponse,
} from "../route-helpers.js";
import { getAuth0Store } from "../store.js";

function paginate<T>(c: Context<AppEnv>, items: T[]): T[] {
  const { page, per_page } = parsePagination(c);
  const total = items.length;
  setLinkHeader(c, total, page, per_page);
  c.header("X-Total-Count", String(total));
  return items.slice((page - 1) * per_page, page * per_page);
}

function stringValue(body: Record<string, unknown>, key: string, fallback = ""): string {
  const value = body[key];
  return typeof value === "string" ? value : fallback;
}

function stringArray(body: Record<string, unknown>, key: string, fallback: string[] = []): string[] {
  const value = body[key];
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  return fallback;
}

function booleanValue(body: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = body[key];
  return typeof value === "boolean" ? value : fallback;
}

function userUpdates(user: Auth0User, body: Record<string, unknown>): Partial<Auth0User> {
  const nextName = stringValue(body, "name", user.name);
  const nextEmail = stringValue(body, "email", user.email);
  return {
    email: nextEmail,
    email_verified: booleanValue(body, "email_verified", user.email_verified),
    name: nextName,
    nickname: stringValue(body, "nickname", user.nickname || nextEmail.split("@")[0] || nextName),
    picture: stringValue(body, "picture", user.picture),
    blocked: booleanValue(body, "blocked", user.blocked),
    locale:
      body.user_metadata && typeof body.user_metadata === "object"
        ? stringValue(body.user_metadata as Record<string, unknown>, "locale", user.locale)
        : user.locale,
  };
}

export function managementRoutes({ app, store, tokenMap }: RouteContext): void {
  const auth0 = getAuth0Store(store);

  app.get("/api/v2/users", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    const q = (c.req.query("q") ?? "").toLowerCase();
    let users = auth0.users.all();
    if (q) {
      users = users.filter((user) =>
        [user.email, user.name, user.nickname, user.auth0_id].join(" ").toLowerCase().includes(q),
      );
    }
    return c.json(paginate(c, users).map(userResponse));
  });

  app.post("/api/v2/users", async (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    const body = await readJsonObject(c);
    const email = stringValue(body, "email").trim();
    if (!email) return auth0Error(c, 400, "Bad Request", "email is required");
    if (auth0.users.findOneBy("email", email)) return auth0Error(c, 409, "Conflict", "The user already exists.");
    const connection = stringValue(body, "connection", "Username-Password-Authentication");
    const id = userIdForConnection(
      connection === "Username-Password-Authentication" ? "auth0" : connection,
      generateAuth0Id("user"),
    );
    const name = stringValue(body, "name", email);
    const created = auth0.users.insert({
      auth0_id: id,
      email,
      email_verified: booleanValue(body, "email_verified", false),
      name,
      nickname: stringValue(body, "nickname", email.split("@")[0] ?? name),
      picture: stringValue(body, "picture", "https://cdn.auth0.com/avatars/default.png"),
      connection,
      password: stringValue(body, "password") || null,
      blocked: booleanValue(body, "blocked", false),
      locale: "en-US",
      last_login: null,
      logins_count: 0,
    });
    return c.json(userResponse(created), 201);
  });

  app.get("/api/v2/users/:id", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    const user = findUserByRef(auth0, c.req.param("id"));
    if (!user) return auth0Error(c, 404, "Not Found", "User not found.");
    return c.json(userResponse(user));
  });

  app.patch("/api/v2/users/:id", async (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    const user = findUserByRef(auth0, c.req.param("id"));
    if (!user) return auth0Error(c, 404, "Not Found", "User not found.");
    const body = await readJsonObject(c);
    const updates = userUpdates(user, body);
    if (updates.email !== user.email && auth0.users.findOneBy("email", updates.email ?? "")) {
      return auth0Error(c, 409, "Conflict", "The user already exists.");
    }
    const updated = auth0.users.update(user.id, updates);
    return c.json(userResponse(updated ?? user));
  });

  app.delete("/api/v2/users/:id", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    const user = findUserByRef(auth0, c.req.param("id"));
    if (!user) return auth0Error(c, 404, "Not Found", "User not found.");
    auth0.users.delete(user.id);
    return c.body(null, 204);
  });

  app.get("/api/v2/users/:id/roles", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    const user = findUserByRef(auth0, c.req.param("id"));
    if (!user) return auth0Error(c, 404, "Not Found", "User not found.");
    const roles = auth0.roleAssignments
      .findBy("user_auth0_id", user.auth0_id)
      .map((assignment) => auth0.roles.findOneBy("role_id", assignment.role_id))
      .filter((role): role is NonNullable<typeof role> => Boolean(role));
    return c.json(roles.map(roleResponse));
  });

  app.post("/api/v2/users/:id/roles", async (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    const user = findUserByRef(auth0, c.req.param("id"));
    if (!user) return auth0Error(c, 404, "Not Found", "User not found.");
    const body = await readJsonObject(c);
    for (const roleId of stringArray(body, "roles")) {
      const role = findRoleByRef(auth0, roleId);
      if (!role) continue;
      const exists = auth0.roleAssignments
        .findBy("user_auth0_id", user.auth0_id)
        .find((assignment) => assignment.role_id === role.role_id);
      if (!exists) auth0.roleAssignments.insert({ user_auth0_id: user.auth0_id, role_id: role.role_id });
    }
    return c.body(null, 204);
  });

  app.get("/api/v2/roles", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    return c.json(paginate(c, auth0.roles.all()).map(roleResponse));
  });

  app.post("/api/v2/roles", async (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    const body = await readJsonObject(c);
    const name = stringValue(body, "name").trim();
    if (!name) return auth0Error(c, 400, "Bad Request", "name is required");
    if (auth0.roles.findOneBy("name", name)) return auth0Error(c, 409, "Conflict", "The role already exists.");
    const created = auth0.roles.insert({
      role_id: generateAuth0Id("rol"),
      name,
      description: stringValue(body, "description"),
    });
    return c.json(roleResponse(created), 201);
  });

  app.get("/api/v2/roles/:id", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    const role = findRoleByRef(auth0, c.req.param("id"));
    if (!role) return auth0Error(c, 404, "Not Found", "Role not found.");
    return c.json(roleResponse(role));
  });

  app.patch("/api/v2/roles/:id", async (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    const role = findRoleByRef(auth0, c.req.param("id"));
    if (!role) return auth0Error(c, 404, "Not Found", "Role not found.");
    const body = await readJsonObject(c);
    const updated = auth0.roles.update(role.id, {
      name: stringValue(body, "name", role.name),
      description: stringValue(body, "description", role.description),
    });
    return c.json(roleResponse(updated ?? role));
  });

  app.delete("/api/v2/roles/:id", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    const role = findRoleByRef(auth0, c.req.param("id"));
    if (!role) return auth0Error(c, 404, "Not Found", "Role not found.");
    auth0.roles.delete(role.id);
    return c.body(null, 204);
  });

  app.get("/api/v2/applications", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    return c.json(paginate(c, auth0.applications.all()).map(applicationResponse));
  });

  app.post("/api/v2/applications", async (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    const body = await readJsonObject(c);
    const name = stringValue(body, "name").trim();
    if (!name) return auth0Error(c, 400, "Bad Request", "name is required");
    const created = auth0.applications.insert({
      client_id: stringValue(body, "client_id", generateAuth0Id("app")),
      client_secret: stringValue(body, "client_secret", generateAuth0Id("secret")),
      name,
      app_type: stringValue(body, "app_type", "regular_web") as Auth0ApplicationType,
      callbacks: stringArray(body, "callbacks"),
      allowed_logout_urls: stringArray(body, "allowed_logout_urls"),
      grant_types: stringArray(body, "grant_types", ["authorization_code", "refresh_token"]),
      token_endpoint_auth_method: stringValue(
        body,
        "token_endpoint_auth_method",
        "client_secret_post",
      ) as Auth0TokenEndpointAuthMethod,
      organization_usage: "allow",
    });
    return c.json(applicationResponse(created), 201);
  });

  app.get("/api/v2/applications/:id", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    const application = findApplicationByRef(auth0, c.req.param("id"));
    if (!application) return auth0Error(c, 404, "Not Found", "Application not found.");
    return c.json(applicationResponse(application));
  });

  app.patch("/api/v2/applications/:id", async (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    const application = findApplicationByRef(auth0, c.req.param("id"));
    if (!application) return auth0Error(c, 404, "Not Found", "Application not found.");
    const body = await readJsonObject(c);
    const updated = auth0.applications.update(application.id, {
      name: stringValue(body, "name", application.name),
      callbacks: stringArray(body, "callbacks", application.callbacks),
      allowed_logout_urls: stringArray(body, "allowed_logout_urls", application.allowed_logout_urls),
      grant_types: stringArray(body, "grant_types", application.grant_types),
      token_endpoint_auth_method: stringValue(
        body,
        "token_endpoint_auth_method",
        application.token_endpoint_auth_method,
      ) as Auth0TokenEndpointAuthMethod,
    });
    return c.json(applicationResponse(updated ?? application));
  });

  app.delete("/api/v2/applications/:id", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    const application = findApplicationByRef(auth0, c.req.param("id"));
    if (!application) return auth0Error(c, 404, "Not Found", "Application not found.");
    auth0.applications.delete(application.id);
    return c.body(null, 204);
  });

  app.get("/api/v2/connections", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    return c.json(paginate(c, auth0.connections.all()).map(connectionResponse));
  });

  app.post("/api/v2/connections", async (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    const body = await readJsonObject(c);
    const name = stringValue(body, "name").trim();
    if (!name) return auth0Error(c, 400, "Bad Request", "name is required");
    const created = auth0.connections.insert({
      connection_id: stringValue(body, "id", generateAuth0Id("con")),
      name,
      strategy: stringValue(body, "strategy", "auth0") as Auth0ConnectionStrategy,
      enabled_clients: stringArray(body, "enabled_clients"),
    });
    return c.json(connectionResponse(created), 201);
  });

  app.get("/api/v2/connections/:id", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    const connection = findConnectionByRef(auth0, c.req.param("id"));
    if (!connection) return auth0Error(c, 404, "Not Found", "Connection not found.");
    return c.json(connectionResponse(connection));
  });

  app.patch("/api/v2/connections/:id", async (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    const connection = findConnectionByRef(auth0, c.req.param("id"));
    if (!connection) return auth0Error(c, 404, "Not Found", "Connection not found.");
    const body = await readJsonObject(c);
    const updated = auth0.connections.update(connection.id, {
      name: stringValue(body, "name", connection.name),
      strategy: stringValue(body, "strategy", connection.strategy) as Auth0ConnectionStrategy,
      enabled_clients: stringArray(body, "enabled_clients", connection.enabled_clients),
    });
    return c.json(connectionResponse(updated ?? connection));
  });

  app.delete("/api/v2/connections/:id", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    const connection = findConnectionByRef(auth0, c.req.param("id"));
    if (!connection) return auth0Error(c, 404, "Not Found", "Connection not found.");
    auth0.connections.delete(connection.id);
    return c.body(null, 204);
  });

  app.get("/api/v2/organizations", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    return c.json(paginate(c, auth0.organizations.all()).map(organizationResponse));
  });

  app.post("/api/v2/organizations", async (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    const body = await readJsonObject(c);
    const name = stringValue(body, "name").trim();
    if (!name) return auth0Error(c, 400, "Bad Request", "name is required");
    const created = auth0.organizations.insert({
      org_id: stringValue(body, "id", generateAuth0Id("org")),
      name,
      display_name: stringValue(body, "display_name", name),
      branding: body.branding && typeof body.branding === "object" ? (body.branding as Record<string, unknown>) : {},
    });
    return c.json(organizationResponse(created), 201);
  });

  app.get("/api/v2/organizations/:id", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    const organization = findOrganizationByRef(auth0, c.req.param("id"));
    if (!organization) return auth0Error(c, 404, "Not Found", "Organization not found.");
    return c.json(organizationResponse(organization));
  });

  app.patch("/api/v2/organizations/:id", async (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    const organization = findOrganizationByRef(auth0, c.req.param("id"));
    if (!organization) return auth0Error(c, 404, "Not Found", "Organization not found.");
    const body = await readJsonObject(c);
    const updated = auth0.organizations.update(organization.id, {
      name: stringValue(body, "name", organization.name),
      display_name: stringValue(body, "display_name", organization.display_name),
      branding:
        body.branding && typeof body.branding === "object"
          ? (body.branding as Record<string, unknown>)
          : organization.branding,
    });
    return c.json(organizationResponse(updated ?? organization));
  });

  app.delete("/api/v2/organizations/:id", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    const organization = findOrganizationByRef(auth0, c.req.param("id"));
    if (!organization) return auth0Error(c, 404, "Not Found", "Organization not found.");
    auth0.organizations.delete(organization.id);
    return c.body(null, 204);
  });

  app.get("/api/v2/organizations/:id/members", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    const organization = findOrganizationByRef(auth0, c.req.param("id"));
    if (!organization) return auth0Error(c, 404, "Not Found", "Organization not found.");
    const members = auth0.organizationMemberships
      .findBy("org_id", organization.org_id)
      .map((membership) => auth0.users.findOneBy("auth0_id", membership.user_auth0_id))
      .filter((user): user is NonNullable<typeof user> => Boolean(user));
    return c.json(members.map(userResponse));
  });
}
