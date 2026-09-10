import type { AppEnv, Hono } from "@emulators/core";
import type { GUser } from "../entities.js";
import { formatGroup, formatUser } from "../formatters.js";
import {
  api,
  badRequest,
  bool,
  collection,
  conflict,
  emailValid,
  entity,
  guid,
  notFound,
  odataOptions,
  parseJsonBody,
  requirePermission,
  route,
  str,
  strOrNull,
  stringArray,
  versionOf,
  type Body,
} from "../helpers.js";
import { logEvent, type GStore } from "../store.js";

export const READ_USERS = ["User.Read.All", "User.ReadWrite.All", "Directory.Read.All", "Directory.ReadWrite.All"];
export const WRITE_USERS = ["User.ReadWrite.All", "Directory.ReadWrite.All"];

export function findUser(gs: GStore, tenantId: string, id: string): GUser {
  const decoded = decodeURIComponent(id);
  const user = gs.users
    .findBy("tenant_id", tenantId)
    .find(
      (candidate) =>
        !candidate.deleted &&
        (candidate.object_id === decoded || candidate.userPrincipalName.toLowerCase() === decoded.toLowerCase()),
    );
  if (!user) throw notFound();
  return user;
}

export function tenantDomain(gs: GStore, tenantId: string): string {
  return gs.tenants.findOneBy("tenant_id", tenantId)?.domain ?? "emulate.onmicrosoft.com";
}

export interface CreateUserInput {
  tenantId: string;
  displayName: string;
  userPrincipalName?: string;
  mailNickname?: string;
  mail?: string | null;
  givenName?: string | null;
  surname?: string | null;
  accountEnabled?: boolean;
  userType?: GUser["userType"];
  externalUserState?: GUser["externalUserState"];
  jobTitle?: string | null;
  department?: string | null;
  companyName?: string | null;
  preferredLanguage?: string | null;
  mobilePhone?: string | null;
  officeLocation?: string | null;
  businessPhones?: string[];
  usageLocation?: string | null;
  otherMails?: string[];
  id?: string;
}

export function createUser(gs: GStore, input: CreateUserInput): GUser {
  const domain = tenantDomain(gs, input.tenantId);
  const nickname =
    input.mailNickname ??
    (input.mail ?? input.userPrincipalName ?? input.displayName)
      .split("@")[0]
      .replace(/[^a-zA-Z0-9._-]/g, "")
      .toLowerCase();
  const upn = input.userPrincipalName ?? `${nickname}@${domain}`;
  if (
    gs.users
      .findBy("tenant_id", input.tenantId)
      .some((candidate) => !candidate.deleted && candidate.userPrincipalName.toLowerCase() === upn.toLowerCase())
  )
    throw conflict("Another object with the same value for property userPrincipalName already exists.");
  const [first, ...rest] = input.displayName.split(" ");
  const user = gs.users.insert({
    tenant_id: input.tenantId,
    object_id: input.id ?? guid(),
    displayName: input.displayName,
    givenName: input.givenName ?? first ?? null,
    surname: input.surname ?? (rest.length > 0 ? rest.join(" ") : null),
    mail: input.mail === undefined ? upn : input.mail,
    userPrincipalName: upn,
    mailNickname: nickname,
    jobTitle: input.jobTitle ?? null,
    mobilePhone: input.mobilePhone ?? null,
    officeLocation: input.officeLocation ?? null,
    preferredLanguage: input.preferredLanguage ?? null,
    businessPhones: input.businessPhones ?? [],
    accountEnabled: input.accountEnabled ?? true,
    userType: input.userType ?? "Member",
    externalUserState: input.externalUserState ?? null,
    externalUserStateChangeDateTime: input.externalUserState ? new Date().toISOString() : null,
    department: input.department ?? null,
    companyName: input.companyName ?? null,
    usageLocation: input.usageLocation ?? null,
    otherMails: input.otherMails ?? (input.userType === "Guest" && input.mail ? [input.mail] : []),
    proxyAddresses: input.mail ? [`SMTP:${input.mail}`] : [],
    createdDateTime: new Date().toISOString(),
    deleted: false,
    deletedDateTime: null,
    password_profile: null,
  });
  logEvent(gs, input.tenantId, "user.created", user.object_id, {
    displayName: user.displayName,
    mail: user.mail,
    userType: user.userType,
  });
  return user;
}

const UPDATABLE = [
  "displayName",
  "givenName",
  "surname",
  "mail",
  "jobTitle",
  "mobilePhone",
  "officeLocation",
  "preferredLanguage",
  "department",
  "companyName",
  "usageLocation",
  "mailNickname",
  "userPrincipalName",
] as const;

export function applyUserUpdate(gs: GStore, user: GUser, body: Body): GUser {
  const updates: Partial<GUser> = {};
  for (const field of UPDATABLE)
    if (body[field] !== undefined) (updates as Record<string, unknown>)[field] = strOrNull(body[field]);
  if (updates.userPrincipalName === null) throw badRequest("Property userPrincipalName cannot be null.");
  if (updates.displayName === null) throw badRequest("Property displayName cannot be null.");
  if (
    updates.userPrincipalName &&
    gs.users
      .findBy("tenant_id", user.tenant_id)
      .some(
        (candidate) =>
          candidate.id !== user.id &&
          !candidate.deleted &&
          candidate.userPrincipalName.toLowerCase() === updates.userPrincipalName!.toLowerCase(),
      )
  )
    throw conflict("Another object with the same value for property userPrincipalName already exists.");
  if (body.accountEnabled !== undefined) {
    const enabled = bool(body.accountEnabled);
    if (enabled === undefined)
      throw badRequest("Invalid value specified for property 'accountEnabled' of resource 'User'.");
    updates.accountEnabled = enabled;
  }
  if (body.businessPhones !== undefined) updates.businessPhones = stringArray(body.businessPhones) ?? [];
  if (body.otherMails !== undefined) updates.otherMails = stringArray(body.otherMails) ?? [];
  if (body.passwordProfile !== undefined && body.passwordProfile && typeof body.passwordProfile === "object")
    updates.password_profile = {
      forceChangePasswordNextSignIn: bool((body.passwordProfile as Body).forceChangePasswordNextSignIn) ?? false,
    };
  const unknown = Object.keys(body).filter(
    (key) =>
      !UPDATABLE.includes(key as (typeof UPDATABLE)[number]) &&
      !["accountEnabled", "businessPhones", "otherMails", "passwordProfile", "id", "@odata.type"].includes(key),
  );
  if (unknown.length > 0)
    throw badRequest(`One or more properties contains invalid values: ${unknown.join(", ")}`, "Request_BadRequest");
  const updated = gs.users.update(user.id, updates)!;
  logEvent(gs, user.tenant_id, "user.updated", user.object_id, {
    fields: Object.keys(body),
    accountEnabled: updated.accountEnabled,
  });
  return updated;
}

export function userRoutes(app: Hono<AppEnv>, gs: GStore, baseUrl: string): void {
  route(
    app,
    "get",
    "/users",
    api(gs, (c, auth) => {
      requirePermission(auth, ...READ_USERS);
      const rows = gs.users
        .findBy("tenant_id", auth.tenantId)
        .filter((user) => !user.deleted)
        .sort((a, b) => a.id - b.id)
        .map(formatUser);
      return collection(c, baseUrl, versionOf(c), "users", rows, odataOptions(c));
    }),
  );

  route(
    app,
    "post",
    "/users",
    api(gs, async (c, auth) => {
      requirePermission(auth, ...WRITE_USERS);
      const body = await parseJsonBody(c);
      const displayName = str(body.displayName)?.trim();
      const upn = str(body.userPrincipalName)?.trim();
      const nickname = str(body.mailNickname)?.trim();
      if (!displayName) throw badRequest("Property displayName is required.");
      if (!upn || !emailValid(upn))
        throw badRequest("Property userPrincipalName is required and must be a valid principal name.");
      if (!nickname) throw badRequest("Property mailNickname is required.");
      if (body.accountEnabled === undefined) throw badRequest("Property accountEnabled is required.");
      if (
        !body.passwordProfile ||
        typeof body.passwordProfile !== "object" ||
        !str((body.passwordProfile as Body).password)
      )
        throw badRequest("Property passwordProfile.password is required.");
      const user = createUser(gs, {
        tenantId: auth.tenantId,
        displayName,
        userPrincipalName: upn,
        mailNickname: nickname,
        mail: body.mail === undefined ? null : strOrNull(body.mail),
        givenName: strOrNull(body.givenName),
        surname: strOrNull(body.surname),
        accountEnabled: bool(body.accountEnabled),
        jobTitle: strOrNull(body.jobTitle),
        department: strOrNull(body.department),
        companyName: strOrNull(body.companyName),
        preferredLanguage: strOrNull(body.preferredLanguage),
        mobilePhone: strOrNull(body.mobilePhone),
        officeLocation: strOrNull(body.officeLocation),
        businessPhones: stringArray(body.businessPhones),
        usageLocation: strOrNull(body.usageLocation),
        otherMails: stringArray(body.otherMails),
      });
      gs.users.update(user.id, {
        password_profile: {
          forceChangePasswordNextSignIn: bool((body.passwordProfile as Body).forceChangePasswordNextSignIn) ?? true,
        },
      });
      return entity(c, baseUrl, versionOf(c), "users", formatUser(gs.users.get(user.id)!), 201);
    }),
  );

  route(
    app,
    "get",
    "/users/:id",
    api(gs, (c, auth) => {
      requirePermission(auth, ...READ_USERS);
      return entity(c, baseUrl, versionOf(c), "users", formatUser(findUser(gs, auth.tenantId, c.req.param("id"))));
    }),
  );

  route(
    app,
    "patch",
    "/users/:id",
    api(gs, async (c, auth) => {
      requirePermission(auth, ...WRITE_USERS);
      const user = findUser(gs, auth.tenantId, c.req.param("id"));
      const body = await parseJsonBody(c);
      if (Object.keys(body).length === 0) throw badRequest("Empty Payload. JSON content expected.");
      applyUserUpdate(gs, user, body);
      return c.body(null, 204);
    }),
  );

  route(
    app,
    "delete",
    "/users/:id",
    api(gs, (c, auth) => {
      requirePermission(auth, ...WRITE_USERS);
      const user = findUser(gs, auth.tenantId, c.req.param("id"));
      gs.users.update(user.id, { deleted: true, deletedDateTime: new Date().toISOString(), accountEnabled: false });
      for (const assignment of gs.roleAssignments.findBy("principalId", user.object_id))
        gs.roleAssignments.delete(assignment.id);
      for (const group of gs.groups.findBy("tenant_id", auth.tenantId))
        if (group.member_ids.includes(user.object_id))
          gs.groups.update(group.id, { member_ids: group.member_ids.filter((id) => id !== user.object_id) });
      logEvent(gs, auth.tenantId, "user.deleted", user.object_id, { mail: user.mail });
      return c.body(null, 204);
    }),
  );

  route(
    app,
    "get",
    "/users/:id/memberOf",
    api(gs, (c, auth) => {
      requirePermission(auth, ...READ_USERS, "Group.Read.All", "Group.ReadWrite.All");
      const user = findUser(gs, auth.tenantId, c.req.param("id"));
      const rows = gs.groups
        .findBy("tenant_id", auth.tenantId)
        .filter((group) => group.member_ids.includes(user.object_id))
        .map((group) => ({ "@odata.type": "#microsoft.graph.group", ...formatGroup(group) }));
      return collection(c, baseUrl, versionOf(c), "directoryObjects", rows, odataOptions(c));
    }),
  );

  route(
    app,
    "get",
    "/users/:id/transitiveMemberOf",
    api(gs, (c, auth) => {
      requirePermission(auth, ...READ_USERS, "Group.Read.All", "Group.ReadWrite.All");
      const user = findUser(gs, auth.tenantId, c.req.param("id"));
      const groups = gs.groups
        .findBy("tenant_id", auth.tenantId)
        .filter((group) => group.member_ids.includes(user.object_id))
        .map((group) => ({ "@odata.type": "#microsoft.graph.group", ...formatGroup(group) }));
      const roles = gs.roleAssignments
        .findBy("principalId", user.object_id)
        .filter((assignment) => assignment.tenant_id === auth.tenantId)
        .map((assignment) => gs.roleDefinitions.findOneBy("role_id", assignment.roleDefinitionId))
        .filter((role): role is NonNullable<typeof role> => !!role)
        .map((role) => ({
          "@odata.type": "#microsoft.graph.directoryRole",
          id: role.role_id,
          displayName: role.displayName,
          description: role.description,
          roleTemplateId: role.templateId,
        }));
      return collection(c, baseUrl, versionOf(c), "directoryObjects", [...groups, ...roles], odataOptions(c));
    }),
  );

  route(
    app,
    "get",
    "/directory/deletedItems/microsoft.graph.user",
    api(gs, (c, auth) => {
      requirePermission(auth, ...READ_USERS);
      const rows = gs.users
        .findBy("tenant_id", auth.tenantId)
        .filter((user) => user.deleted)
        .map(formatUser);
      return collection(c, baseUrl, versionOf(c), "directoryObjects", rows, odataOptions(c));
    }),
  );

  route(
    app,
    "post",
    "/directory/deletedItems/:id/restore",
    api(gs, (c, auth) => {
      requirePermission(auth, ...WRITE_USERS);
      const user = gs.users
        .findBy("tenant_id", auth.tenantId)
        .find((candidate) => candidate.deleted && candidate.object_id === c.req.param("id"));
      if (!user) throw notFound();
      const restored = gs.users.update(user.id, { deleted: false, deletedDateTime: null })!;
      return entity(c, baseUrl, versionOf(c), "directoryObjects", formatUser(restored));
    }),
  );
}
