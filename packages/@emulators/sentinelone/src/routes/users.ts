import type { S1ScopeRole, S1User, UserScope } from "../entities.js";
import { formatRole, formatUser } from "../formatters.js";
import {
  alreadyExists,
  api,
  bool,
  containsAny,
  dataOf,
  emailValid,
  filterOf,
  list,
  matchesList,
  notFound,
  oneOf,
  paginate,
  parseJsonBody,
  queryParams,
  route,
  str,
  token,
  validation,
  type Body,
} from "../helpers.js";
import { logActivity, logEvent, nextId, type S1Store } from "../store.js";
import { findUser, requestUser, type S1RouteContext } from "../route-utils.js";

const SCOPES = ["tenant", "account", "site"] as const;

export function parseScopeRoles(ss: S1Store, scope: UserScope, value: unknown): S1ScopeRole[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw validation("scopeRoles must be an array of { id, roleId }");
  const roles = value.map((entry) => {
    const record = (entry && typeof entry === "object" ? entry : {}) as Body;
    const id = str(record.id);
    const roleId = str(record.roleId);
    if (!id || !roleId) throw validation("Each scopeRoles entry requires id and roleId");
    if (!ss.roles.findOneBy("s1_id", roleId)) throw validation(`Role ${roleId} does not exist`);
    if (scope === "account" && !ss.accounts.findOneBy("s1_id", id))
      throw validation(`Account ${id} does not exist for scope account`);
    if (scope === "site" && !ss.sites.findOneBy("s1_id", id) && !ss.accounts.findOneBy("s1_id", id))
      throw validation(`Site ${id} does not exist for scope site`);
    return { id, roleId };
  });
  const seen = new Set<string>();
  return roles.filter((role) => {
    const key = `${role.id}:${role.roleId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface CreateUserInput {
  email: string;
  fullName: string;
  scope: UserScope;
  scopeRoles: S1ScopeRole[];
  twoFaEnabled?: boolean;
  source?: S1User["source"];
  emailVerified?: boolean;
  canGenerateApiToken?: boolean;
  id?: string;
}

export function createUser(ss: S1Store, input: CreateUserInput): S1User {
  const email = input.email.trim().toLowerCase();
  if (!email || !emailValid(email)) throw validation("email must be a valid email address");
  if (ss.users.findOneBy("email", email)) throw alreadyExists(`A user with email ${email} already exists`);
  const fullName = input.fullName.trim();
  if (!fullName) throw validation("fullName is required");
  if (input.scope !== "tenant" && input.scopeRoles.length === 0)
    throw validation("scopeRoles must contain at least one role for account or site scope");
  const user = ss.users.insert({
    s1_id: input.id ?? nextId(ss),
    email,
    fullName,
    scope: input.scope,
    scopeRoles: input.scopeRoles,
    source: input.source ?? "mgmt",
    emailVerified: input.emailVerified ?? false,
    twoFaEnabled: input.twoFaEnabled ?? true,
    twoFaConfigured: false,
    primaryTwoFaMethod: null,
    canGenerateApiToken: input.canGenerateApiToken ?? false,
    apiTokenCreatedAt: null,
    apiTokenExpiresAt: null,
    dateJoined: new Date().toISOString(),
    firstLogin: null,
    lastLogin: null,
    isSystem: false,
    onboardingEmailsSent: 0,
    resetPasswordEmailsSent: 0,
  });
  logActivity(ss, {
    activityType: 6000,
    primaryDescription: `User ${user.fullName} (${user.email}) was created`,
    userId: user.s1_id,
  });
  logEvent(ss, "user.created", user.s1_id, {
    email: user.email,
    fullName: user.fullName,
    scope: user.scope,
    scopeRoles: user.scopeRoles,
  });
  return user;
}

export function userRoutes(rc: S1RouteContext): void {
  const { app, ss, fmt } = rc;

  route(
    app,
    "get",
    "/users",
    api(ss, (c) => {
      const params = queryParams(c);
      const email = params.list("email");
      const siteIds = params.list("siteIds");
      const accountIds = params.list("accountIds");
      const roleIds = params.list("roleIds");
      const rows = ss.users
        .all()
        .filter((user) => matchesList(user.s1_id, params.list("ids")))
        .filter((user) => matchesList(user.email, email))
        .filter((user) => containsAny(user.email, params.list("email__contains")))
        .filter((user) => matchesList(user.fullName, params.list("fullName")))
        .filter((user) => containsAny(user.fullName, params.list("fullName__contains")))
        .filter((user) => containsAny(`${user.fullName} ${user.email}`, params.list("query")))
        .filter((user) =>
          params.bool("emailVerified") === undefined ? true : user.emailVerified === params.bool("emailVerified"),
        )
        .filter((user) =>
          params.bool("twoFaEnabled") === undefined ? true : user.twoFaEnabled === params.bool("twoFaEnabled"),
        )
        .filter((user) =>
          params.bool("canGenerateApiToken") === undefined
            ? true
            : user.canGenerateApiToken === params.bool("canGenerateApiToken"),
        )
        .filter((user) => matchesList(user.scope, params.list("scope") ?? params.list("scopes")))
        .filter((user) => matchesList(user.source, params.list("source")))
        .filter((user) => (siteIds ? user.scopeRoles.some((role) => siteIds.includes(role.id)) : true))
        .filter((user) =>
          accountIds
            ? user.scopeRoles.some(
                (role) =>
                  accountIds.includes(role.id) ||
                  (ss.sites.findOneBy("s1_id", role.id) &&
                    accountIds.includes(ss.sites.findOneBy("s1_id", role.id)!.account_id)),
              )
            : true,
        )
        .filter((user) => (roleIds ? user.scopeRoles.some((role) => roleIds.includes(role.roleId)) : true))
        .sort((a, b) => a.id - b.id)
        .map((user) => formatUser(fmt, user));
      return c.json(
        paginate(c, rows, {
          sortable: [
            "id",
            "email",
            "fullName",
            "dateJoined",
            "firstLogin",
            "lastLogin",
            "createdAt",
            "emailVerified",
            "twoFaEnabled",
            "twoFaStatus",
            "source",
            "canGenerateApiToken",
            "apiTokenCreatedAt",
            "apiTokenExpiresAt",
            "roleId",
          ],
        }),
      );
    }),
  );

  route(
    app,
    "post",
    "/users",
    api(ss, async (c) => {
      const data = dataOf(await parseJsonBody(c));
      const scope = oneOf(data.scope, SCOPES, "scope");
      if (!scope) throw validation("scope is required");
      const user = createUser(ss, {
        email: str(data.email) ?? "",
        fullName: str(data.fullName) ?? "",
        scope,
        scopeRoles: parseScopeRoles(ss, scope, data.scopeRoles),
        twoFaEnabled: bool(data.twoFaEnabled),
        canGenerateApiToken: bool(data.canGenerateApiToken),
      });
      return c.json({ data: formatUser(fmt, user) });
    }),
  );

  route(
    app,
    "get",
    "/users/:id",
    api(ss, (c) => c.json({ data: formatUser(fmt, findUser(ss, c.req.param("id"))) })),
  );

  route(
    app,
    "put",
    "/users/:id",
    api(ss, async (c) => {
      const user = findUser(ss, c.req.param("id"));
      const data = dataOf(await parseJsonBody(c));
      const scope = data.scope !== undefined ? (oneOf(data.scope, SCOPES, "scope") ?? user.scope) : user.scope;
      const scopeRoles = data.scopeRoles !== undefined ? parseScopeRoles(ss, scope, data.scopeRoles) : user.scopeRoles;
      if (scope !== "tenant" && scopeRoles.length === 0)
        throw validation("scopeRoles must contain at least one role for account or site scope");
      const fullName = data.fullName !== undefined ? (str(data.fullName)?.trim() ?? "") : user.fullName;
      if (!fullName) throw validation("fullName cannot be empty");
      const updated = ss.users.update(user.id, {
        scope,
        scopeRoles,
        fullName,
        twoFaEnabled: bool(data.twoFaEnabled) ?? user.twoFaEnabled,
        canGenerateApiToken: bool(data.canGenerateApiToken) ?? user.canGenerateApiToken,
        emailVerified: bool(data.emailVerified) ?? user.emailVerified,
      })!;
      logEvent(ss, "user.updated", updated.s1_id, {
        email: updated.email,
        scope: updated.scope,
        scopeRoles: updated.scopeRoles,
      });
      return c.json({ data: formatUser(fmt, updated) });
    }),
  );

  route(
    app,
    "delete",
    "/users/:id",
    api(ss, (c) => {
      const user = findUser(ss, c.req.param("id"));
      if (user.isSystem) throw validation("System users cannot be deleted");
      for (const apiToken of ss.apiTokens.findBy("user_id", user.s1_id)) ss.apiTokens.delete(apiToken.id);
      ss.users.delete(user.id);
      logEvent(ss, "user.deleted", user.s1_id, { email: user.email });
      return c.json({ data: { success: true } });
    }),
  );

  const selectUsers = (body: Body): S1User[] => {
    const filter = filterOf(body);
    const data = dataOf(body);
    const ids = list(filter.ids) ?? list(data.ids) ?? [];
    const emails = list(filter.emails) ?? list(data.emails) ?? [];
    const users = [
      ...ids.map((id) => findUser(ss, id)),
      ...emails
        .map((email) => ss.users.findOneBy("email", email.toLowerCase()))
        .filter((user): user is S1User => !!user),
    ];
    if (users.length === 0) throw validation("filter.ids or data.ids must select at least one user");
    return users;
  };

  route(
    app,
    "post",
    "/users/onboarding/send-verification-email",
    api(ss, async (c) => {
      const users = selectUsers(await parseJsonBody(c));
      for (const user of users) {
        ss.users.update(user.id, { onboardingEmailsSent: user.onboardingEmailsSent + 1 });
        logEvent(ss, "user.onboarding_email", user.s1_id, { email: user.email });
      }
      return c.json({ data: { affected: users.length } });
    }),
  );

  route(
    app,
    "post",
    "/users/login/send-reset-password-email",
    api(ss, async (c) => {
      const users = selectUsers(await parseJsonBody(c));
      for (const user of users) {
        ss.users.update(user.id, { resetPasswordEmailsSent: user.resetPasswordEmailsSent + 1 });
        logEvent(ss, "user.reset_password_email", user.s1_id, { email: user.email });
      }
      return c.json({ data: { affected: users.length } });
    }),
  );

  route(
    app,
    "post",
    "/users/reset-2fa",
    api(ss, async (c) => {
      const users = selectUsers(await parseJsonBody(c));
      for (const user of users) {
        ss.users.update(user.id, { twoFaConfigured: false, primaryTwoFaMethod: null });
        logEvent(ss, "user.reset_2fa", user.s1_id, { email: user.email });
      }
      return c.json({ data: { affected: users.length } });
    }),
  );

  route(
    app,
    "post",
    "/users/enroll-2fa",
    api(ss, async (c) => {
      const users = selectUsers(await parseJsonBody(c));
      for (const user of users) {
        ss.users.update(user.id, { twoFaEnabled: true, twoFaConfigured: false, primaryTwoFaMethod: "email" });
        logEvent(ss, "user.enroll_2fa", user.s1_id, { email: user.email });
      }
      return c.json({ data: { affected: users.length } });
    }),
  );

  route(
    app,
    "post",
    "/users/generate-api-token",
    api(ss, async (c, key) => {
      const owner = key.user_id ? findUser(ss, key.user_id) : undefined;
      const body = await parseJsonBody(c);
      const target = str(dataOf(body).userId) ? findUser(ss, String(dataOf(body).userId)) : owner;
      if (target)
        for (const existing of ss.apiTokens.findBy("user_id", target.s1_id))
          if (existing.expires_at) ss.apiTokens.delete(existing.id);
      const expiresAt = new Date(Date.now() + 180 * 24 * 3600 * 1000).toISOString();
      const created = ss.apiTokens.insert({
        token: token(80),
        user_id: target?.s1_id ?? null,
        description: target ? `API token for ${target.email}` : "Generated API token",
        expires_at: expiresAt,
      });
      if (target)
        ss.users.update(target.id, {
          apiTokenCreatedAt: created.created_at,
          apiTokenExpiresAt: expiresAt,
          canGenerateApiToken: true,
        });
      logEvent(ss, "user.api_token", target?.s1_id ?? "anonymous", { email: target?.email ?? null, expiresAt });
      return c.json({ data: { token: created.token, createdAt: created.created_at, expiresAt } });
    }),
  );

  route(
    app,
    "post",
    "/users/revoke-api-token",
    api(ss, async (c, key) => {
      const target = key.user_id ? findUser(ss, key.user_id) : undefined;
      if (!target) throw validation("The calling token is not bound to a user");
      for (const existing of ss.apiTokens.findBy("user_id", target.s1_id)) ss.apiTokens.delete(existing.id);
      ss.users.update(target.id, { apiTokenCreatedAt: null, apiTokenExpiresAt: null });
      return c.json({ data: { success: true } });
    }),
  );

  route(
    app,
    "get",
    "/user",
    api(ss, (c, key) => {
      const user = key.user_id ? ss.users.findOneBy("s1_id", key.user_id) : undefined;
      if (!user)
        return c.json({
          data: {
            id: requestUser(ss, null).id,
            email: "api@emulate.local",
            fullName: requestUser(ss, null).fullName,
            scope: "tenant",
            scopeRoles: [],
            isSystem: true,
          },
        });
      return c.json({ data: formatUser(fmt, user) });
    }),
  );

  route(
    app,
    "get",
    "/rbac/roles",
    api(ss, (c) => {
      const params = queryParams(c);
      const siteIds = params.list("siteIds");
      const accountIds = params.list("accountIds");
      const rows = ss.roles
        .all()
        .filter((role) => matchesList(role.s1_id, params.list("ids")))
        .filter((role) => matchesList(role.name, params.list("name")))
        .filter((role) => containsAny(`${role.name} ${role.description}`, params.list("query")))
        .filter((role) => matchesList(role.scope, params.list("scope") ?? params.list("scopes")))
        .filter((role) =>
          params.bool("predefinedRole") === undefined ? true : role.predefinedRole === params.bool("predefinedRole"),
        )
        .filter((role) =>
          siteIds
            ? role.scope === "tenant" ||
              role.scope_id === null ||
              siteIds.includes(role.scope_id) ||
              siteIds.some((siteId) => ss.sites.findOneBy("s1_id", siteId)?.account_id === role.scope_id)
            : true,
        )
        .filter((role) =>
          accountIds ? role.scope === "tenant" || role.scope_id === null || accountIds.includes(role.scope_id) : true,
        )
        .sort((a, b) => a.id - b.id)
        .map((role) => formatRole(fmt, role));
      return c.json(
        paginate(c, rows, {
          sortable: ["id", "name", "scope", "createdAt", "updatedAt", "usersInRoles", "predefinedRole"],
        }),
      );
    }),
  );

  route(
    app,
    "post",
    "/rbac/role",
    api(ss, async (c, key) => {
      const data = dataOf(await parseJsonBody(c));
      const name = str(data.name)?.trim();
      if (!name) throw validation("name is required");
      if (ss.roles.findOneBy("name", name)) throw alreadyExists(`Role ${name} already exists`);
      const scope = oneOf(data.scope, SCOPES, "scope") ?? "tenant";
      const scopeId = str(data.scopeId) ?? null;
      if (scope === "account" && scopeId && !ss.accounts.findOneBy("s1_id", scopeId))
        throw notFound(`Account ${scopeId} was not found`);
      if (scope === "site" && scopeId && !ss.sites.findOneBy("s1_id", scopeId))
        throw notFound(`Site ${scopeId} was not found`);
      const role = ss.roles.insert({
        s1_id: str(data.id) ?? nextId(ss),
        name,
        description: str(data.description) ?? "",
        scope,
        scope_id: scope === "tenant" ? null : scopeId,
        predefinedRole: false,
        creator: requestUser(ss, key.user_id).fullName,
      });
      logEvent(ss, "role.created", role.s1_id, { name: role.name, scope: role.scope });
      return c.json({ data: formatRole(fmt, role) });
    }),
  );

  route(
    app,
    "get",
    "/rbac/role/:id",
    api(ss, (c) => {
      const role = ss.roles.findOneBy("s1_id", c.req.param("id"));
      if (!role) throw notFound(`Role ${c.req.param("id")} was not found`);
      return c.json({ data: formatRole(fmt, role) });
    }),
  );

  route(
    app,
    "delete",
    "/rbac/role/:id",
    api(ss, (c) => {
      const role = ss.roles.findOneBy("s1_id", c.req.param("id"));
      if (!role) throw notFound(`Role ${c.req.param("id")} was not found`);
      if (role.predefinedRole) throw validation("Predefined roles cannot be deleted");
      if (ss.users.all().some((user) => user.scopeRoles.some((scopeRole) => scopeRole.roleId === role.s1_id)))
        throw validation(`Role ${role.name} is assigned to users and cannot be deleted`);
      ss.roles.delete(role.id);
      return c.json({ data: { success: true } });
    }),
  );
}
