import type {
  JobResult,
  UserRole,
  ZendeskGroup,
  ZendeskJobStatus,
  ZendeskOrganization,
  ZendeskOrganizationMembership,
  ZendeskUser,
} from "./entities.js";
import { formatOrganization, formatUser } from "./formatters.js";
import {
  bool,
  emailValid,
  list,
  normalizeTags,
  num,
  obj,
  recordInvalid,
  recordNotFound,
  str,
  strOrNull,
  type Body,
} from "./helpers.js";
import { hexToken, nextId, reserveId } from "./ids.js";
import type { ZendeskStore } from "./store.js";
import { emitZendeskEvent, type ZendeskCtx } from "./webhooks.js";

const ROLES = new Set<string>(["end-user", "agent", "admin"]);

export interface UserInput {
  id?: number;
  name?: string;
  email?: string | null;
  role?: UserRole;
  external_id?: string | null;
  organization_id?: number | null;
  organization?: { name?: string } | null;
  tags?: string[];
  user_fields?: Record<string, unknown>;
  phone?: string | null;
  details?: string | null;
  notes?: string | null;
  alias?: string | null;
  locale?: string;
  time_zone?: string;
  verified?: boolean;
  active?: boolean;
  suspended?: boolean;
  default_group_id?: number | null;
  signature?: string | null;
  password?: string | null;
  moderator?: boolean;
  ticket_restriction?: string | null;
  only_private_comments?: boolean;
}

export function parseUserInput(body: Body): UserInput {
  const input: UserInput = {};
  if (body.id !== undefined) input.id = num(body.id);
  if (body.name !== undefined) input.name = str(body.name) ?? "";
  if (body.email !== undefined) input.email = strOrNull(body.email);
  if (body.role !== undefined) input.role = str(body.role) as UserRole;
  if (body.external_id !== undefined) input.external_id = strOrNull(body.external_id);
  if (body.organization_id !== undefined)
    input.organization_id = body.organization_id === null ? null : (num(body.organization_id) ?? null);
  if (body.organization !== undefined)
    input.organization = body.organization ? { name: str(obj(body.organization).name) } : null;
  if (body.tags !== undefined) input.tags = normalizeTags(body.tags);
  if (body.user_fields !== undefined) input.user_fields = obj(body.user_fields);
  if (body.phone !== undefined) input.phone = strOrNull(body.phone);
  if (body.details !== undefined) input.details = strOrNull(body.details);
  if (body.notes !== undefined) input.notes = strOrNull(body.notes);
  if (body.alias !== undefined) input.alias = strOrNull(body.alias);
  if (body.locale !== undefined) input.locale = str(body.locale);
  if (body.time_zone !== undefined) input.time_zone = str(body.time_zone);
  if (body.verified !== undefined) input.verified = bool(body.verified);
  if (body.active !== undefined) input.active = bool(body.active);
  if (body.suspended !== undefined) input.suspended = bool(body.suspended);
  if (body.default_group_id !== undefined)
    input.default_group_id = body.default_group_id === null ? null : (num(body.default_group_id) ?? null);
  if (body.signature !== undefined) input.signature = strOrNull(body.signature);
  if (body.password !== undefined) input.password = strOrNull(body.password);
  if (body.moderator !== undefined) input.moderator = bool(body.moderator);
  if (body.ticket_restriction !== undefined) input.ticket_restriction = strOrNull(body.ticket_restriction);
  if (body.only_private_comments !== undefined) input.only_private_comments = bool(body.only_private_comments);
  const identities = list(body.identities);
  if (input.email === undefined) {
    const emailIdentity = identities.map(obj).find((identity) => identity.type === "email" && identity.value);
    if (emailIdentity) input.email = str(emailIdentity.value) ?? null;
  }
  return input;
}

export function findUserByEmail(zs: ZendeskStore, email: string | null | undefined): ZendeskUser | undefined {
  if (!email) return undefined;
  const lowered = email.toLowerCase();
  return zs.users.all().find((user) => !user.deleted && user.email?.toLowerCase() === lowered);
}

export function userDetail(ctx: ZendeskCtx, user: ZendeskUser): Record<string, unknown> {
  const formatted = formatUser({ zs: ctx.zs, baseUrl: ctx.baseUrl }, user);
  return {
    id: formatted.id,
    created_at: formatted.created_at,
    updated_at: formatted.updated_at,
    email: formatted.email,
    external_id: formatted.external_id,
    default_group_id: formatted.default_group_id,
    organization_id: formatted.organization_id,
    role: formatted.role,
    name: formatted.name,
    active: formatted.active,
    suspended: formatted.suspended,
    tags: formatted.tags,
  };
}

export function organizationDetail(ctx: ZendeskCtx, organization: ZendeskOrganization): Record<string, unknown> {
  const formatted = formatOrganization({ zs: ctx.zs, baseUrl: ctx.baseUrl }, organization);
  return {
    id: formatted.id,
    created_at: formatted.created_at,
    updated_at: formatted.updated_at,
    name: formatted.name,
    external_id: formatted.external_id,
    details: formatted.details,
    notes: formatted.notes,
    domain_names: formatted.domain_names,
    tags: formatted.tags,
    group_id: formatted.group_id,
    shared_tickets: formatted.shared_tickets,
    shared_comments: formatted.shared_comments,
  };
}

function defaultGroup(zs: ZendeskStore): ZendeskGroup | undefined {
  return (
    zs.groups.all().find((group) => group.default && !group.deleted) ?? zs.groups.all().find((group) => !group.deleted)
  );
}

function organizationByDomain(zs: ZendeskStore, email: string | null): ZendeskOrganization | undefined {
  if (!email || !email.includes("@")) return undefined;
  const domain = email.split("@")[1].toLowerCase();
  return zs.organizations
    .all()
    .find((org) => !org.deleted && org.domain_names.some((candidate) => candidate.toLowerCase() === domain));
}

export interface RecordOptions {
  emit?: boolean;
}

export async function createUser(ctx: ZendeskCtx, input: UserInput, options: RecordOptions = {}): Promise<ZendeskUser> {
  const { zs } = ctx;
  const name = input.name?.trim();
  if (!name) throw recordInvalid({ name: "Name: cannot be blank" });
  const role = input.role ?? "end-user";
  if (!ROLES.has(role)) throw recordInvalid({ role: `Role: ${role} is not a valid role` });
  const email = input.email ?? null;
  if (email !== null) {
    if (!emailValid(email)) throw recordInvalid({ email: `Email: ${email} is not properly formatted` });
    if (findUserByEmail(zs, email))
      throw recordInvalid({ email: `Email: ${email} is already being used by another user` });
  }
  if (input.external_id && zs.users.all().some((user) => !user.deleted && user.external_id === input.external_id)) {
    throw recordInvalid({ external_id: `External has already been taken` });
  }
  let organizationId: number | null = null;
  if (input.organization_id !== undefined && input.organization_id !== null) {
    const organization = zs.organizations.findOneBy("zd_id", input.organization_id);
    if (!organization || organization.deleted)
      throw recordInvalid({ organization: "Organization: Invalid organization" });
    organizationId = organization.zd_id;
  } else if (input.organization?.name) {
    const existing = zs.organizations
      .all()
      .find((org) => !org.deleted && org.name.toLowerCase() === input.organization!.name!.toLowerCase());
    const organization = existing ?? (await createOrganization(ctx, { name: input.organization.name }, options));
    organizationId = organization.zd_id;
  } else {
    organizationId = organizationByDomain(zs, email)?.zd_id ?? null;
  }
  const isAgent = role !== "end-user";
  const group = isAgent ? defaultGroup(zs) : undefined;
  const id = input.id ?? nextId(zs, "users");
  if (input.id !== undefined) {
    if (zs.users.findOneBy("zd_id", id)) throw recordInvalid({ id: "Id: has already been taken" });
    reserveId(zs, "users", id);
  }
  const user = zs.users.insert({
    zd_id: id,
    name,
    email,
    role,
    active: input.active ?? true,
    verified: input.verified ?? false,
    suspended: input.suspended ?? false,
    organization_id: organizationId,
    default_group_id: input.default_group_id ?? group?.zd_id ?? null,
    external_id: input.external_id ?? null,
    alias: input.alias ?? null,
    details: input.details ?? null,
    notes: input.notes ?? null,
    phone: input.phone ?? null,
    locale: input.locale ?? "en-US",
    time_zone: input.time_zone ?? "UTC",
    tags: input.tags ?? [],
    user_fields: input.user_fields ?? {},
    password: input.password ?? null,
    last_login_at: null,
    signature: input.signature ?? null,
    moderator: input.moderator ?? role === "admin",
    ticket_restriction: input.ticket_restriction ?? (role === "end-user" ? "requested" : null),
    only_private_comments: input.only_private_comments ?? false,
    restricted_agent: role === "agent",
    shared: false,
    shared_agent: false,
    photo: null,
    deleted: false,
  });
  if (organizationId !== null) {
    zs.organizationMemberships.insert({
      zd_id: nextId(zs, "organization_memberships"),
      user_id: user.zd_id,
      organization_id: organizationId,
      default: true,
    });
  }
  if (group) {
    zs.groupMemberships.insert({
      zd_id: nextId(zs, "group_memberships"),
      user_id: user.zd_id,
      group_id: group.zd_id,
      default: true,
    });
  }
  if (options.emit !== false) {
    await emitZendeskEvent(ctx, "zen:event-type:user.created", `zen:user:${user.zd_id}`, userDetail(ctx, user));
    if (organizationId !== null) {
      await emitZendeskEvent(
        ctx,
        "zen:event-type:user.organization_membership_created",
        `zen:user:${user.zd_id}`,
        userDetail(ctx, user),
        {
          organization_id: organizationId,
        },
      );
    }
  }
  return user;
}

export async function updateUser(
  ctx: ZendeskCtx,
  user: ZendeskUser,
  input: UserInput,
  options: RecordOptions = {},
): Promise<ZendeskUser> {
  const { zs } = ctx;
  const updates: Partial<ZendeskUser> = {};
  const events: Array<{ type: string; event: Record<string, unknown> }> = [];
  if (input.name !== undefined) {
    if (!input.name.trim()) throw recordInvalid({ name: "Name: cannot be blank" });
    if (input.name !== user.name) {
      updates.name = input.name.trim();
      events.push({ type: "user.name_changed", event: { current: updates.name, previous: user.name } });
    }
  }
  if (input.email !== undefined && input.email !== user.email) {
    if (input.email !== null) {
      if (!emailValid(input.email)) throw recordInvalid({ email: `Email: ${input.email} is not properly formatted` });
      const other = findUserByEmail(zs, input.email);
      if (other && other.zd_id !== user.zd_id)
        throw recordInvalid({ email: `Email: ${input.email} is already being used by another user` });
    }
    updates.email = input.email;
    events.push({ type: "user.email_changed", event: { current: input.email, previous: user.email } });
  }
  if (input.role !== undefined && input.role !== user.role) {
    if (!ROLES.has(input.role)) throw recordInvalid({ role: `Role: ${input.role} is not a valid role` });
    updates.role = input.role;
    updates.restricted_agent = input.role === "agent";
    updates.ticket_restriction = input.role === "end-user" ? "requested" : null;
    if (input.role !== "end-user" && zs.groupMemberships.findBy("user_id", user.zd_id).length === 0) {
      const group = defaultGroup(zs);
      if (group) {
        zs.groupMemberships.insert({
          zd_id: nextId(zs, "group_memberships"),
          user_id: user.zd_id,
          group_id: group.zd_id,
          default: true,
        });
        updates.default_group_id = group.zd_id;
      }
    }
    events.push({ type: "user.role_changed", event: { current: input.role, previous: user.role } });
  }
  if (input.organization_id !== undefined && input.organization_id !== user.organization_id) {
    if (input.organization_id !== null) {
      const organization = zs.organizations.findOneBy("zd_id", input.organization_id);
      if (!organization || organization.deleted)
        throw recordInvalid({ organization: "Organization: Invalid organization" });
      if (
        !zs.organizationMemberships
          .findBy("user_id", user.zd_id)
          .some((membership) => membership.organization_id === organization.zd_id)
      ) {
        for (const membership of zs.organizationMemberships.findBy("user_id", user.zd_id)) {
          zs.organizationMemberships.update(membership.id, { default: false });
        }
        zs.organizationMemberships.insert({
          zd_id: nextId(zs, "organization_memberships"),
          user_id: user.zd_id,
          organization_id: organization.zd_id,
          default: true,
        });
        events.push({ type: "user.organization_membership_created", event: { organization_id: organization.zd_id } });
      }
    }
    updates.organization_id = input.organization_id;
  }
  if (input.tags !== undefined && JSON.stringify(input.tags) !== JSON.stringify(user.tags)) {
    updates.tags = input.tags;
    events.push({ type: "user.tags_changed", event: { current: input.tags, previous: user.tags } });
  }
  if (input.user_fields !== undefined) {
    updates.user_fields = { ...user.user_fields, ...input.user_fields };
    for (const [key, value] of Object.entries(input.user_fields)) {
      if (JSON.stringify(user.user_fields[key] ?? null) !== JSON.stringify(value ?? null)) {
        events.push({
          type: "user.custom_field_changed",
          event: { field: key, current: value, previous: user.user_fields[key] ?? null },
        });
      }
    }
  }
  if (input.suspended !== undefined && input.suspended !== user.suspended) {
    updates.suspended = input.suspended;
    events.push({ type: "user.suspended_changed", event: { current: input.suspended, previous: user.suspended } });
  }
  if (input.active !== undefined && input.active !== user.active) {
    updates.active = input.active;
    events.push({ type: "user.active_changed", event: { current: input.active, previous: user.active } });
  }
  if (input.default_group_id !== undefined && input.default_group_id !== user.default_group_id) {
    updates.default_group_id = input.default_group_id;
    events.push({
      type: "user.default_group_changed",
      event: { current: input.default_group_id, previous: user.default_group_id },
    });
  }
  for (const key of [
    "external_id",
    "phone",
    "details",
    "notes",
    "alias",
    "signature",
    "password",
    "locale",
    "time_zone",
    "verified",
    "moderator",
    "ticket_restriction",
    "only_private_comments",
  ] as const) {
    if (input[key] !== undefined) (updates as Record<string, unknown>)[key] = input[key];
  }
  const updated = zs.users.update(user.id, updates)!;
  if (options.emit !== false) {
    for (const change of events) {
      await emitZendeskEvent(
        ctx,
        `zen:event-type:${change.type}`,
        `zen:user:${updated.zd_id}`,
        userDetail(ctx, updated),
        change.event,
      );
    }
  }
  return updated;
}

export async function deleteUser(
  ctx: ZendeskCtx,
  user: ZendeskUser,
  options: RecordOptions = {},
): Promise<ZendeskUser> {
  const { zs } = ctx;
  for (const membership of zs.organizationMemberships.findBy("user_id", user.zd_id))
    zs.organizationMemberships.delete(membership.id);
  for (const membership of zs.groupMemberships.findBy("user_id", user.zd_id)) zs.groupMemberships.delete(membership.id);
  const deleted = zs.users.update(user.id, { active: false, deleted: true })!;
  if (options.emit !== false) {
    await emitZendeskEvent(ctx, "zen:event-type:user.deleted", `zen:user:${deleted.zd_id}`, userDetail(ctx, deleted));
  }
  return deleted;
}

export async function ensureEndUser(
  ctx: ZendeskCtx,
  requester: { name?: string | null; email?: string | null; locale?: string | null },
  options: RecordOptions = {},
): Promise<ZendeskUser> {
  const existing = findUserByEmail(ctx.zs, requester.email);
  if (existing) return existing;
  if (!requester.email) throw recordInvalid({ requester: "Requester: email is required to create a new requester" });
  return createUser(
    ctx,
    {
      name: requester.name ?? requester.email.split("@")[0],
      email: requester.email,
      locale: requester.locale ?? undefined,
      role: "end-user",
    },
    options,
  );
}

export interface OrganizationInput {
  id?: number;
  name?: string;
  details?: string | null;
  notes?: string | null;
  domain_names?: string[];
  external_id?: string | null;
  group_id?: number | null;
  shared_tickets?: boolean;
  shared_comments?: boolean;
  tags?: string[];
  organization_fields?: Record<string, unknown>;
}

export function parseOrganizationInput(body: Body): OrganizationInput {
  const input: OrganizationInput = {};
  if (body.id !== undefined) input.id = num(body.id);
  if (body.name !== undefined) input.name = str(body.name) ?? "";
  if (body.details !== undefined) input.details = strOrNull(body.details);
  if (body.notes !== undefined) input.notes = strOrNull(body.notes);
  if (body.domain_names !== undefined) input.domain_names = list(body.domain_names).map(String).filter(Boolean);
  if (body.external_id !== undefined) input.external_id = strOrNull(body.external_id);
  if (body.group_id !== undefined) input.group_id = body.group_id === null ? null : (num(body.group_id) ?? null);
  if (body.shared_tickets !== undefined) input.shared_tickets = bool(body.shared_tickets);
  if (body.shared_comments !== undefined) input.shared_comments = bool(body.shared_comments);
  if (body.tags !== undefined) input.tags = normalizeTags(body.tags);
  if (body.organization_fields !== undefined) input.organization_fields = obj(body.organization_fields);
  return input;
}

export function findOrganizationByName(zs: ZendeskStore, name: string | undefined): ZendeskOrganization | undefined {
  if (!name) return undefined;
  const lowered = name.toLowerCase();
  return zs.organizations.all().find((org) => !org.deleted && org.name.toLowerCase() === lowered);
}

export async function createOrganization(
  ctx: ZendeskCtx,
  input: OrganizationInput,
  options: RecordOptions = {},
): Promise<ZendeskOrganization> {
  const { zs } = ctx;
  const name = input.name?.trim();
  if (!name) throw recordInvalid({ name: "Name: cannot be blank" });
  if (findOrganizationByName(zs, name)) throw recordInvalid({ name: "Name: has already been taken" });
  if (
    input.external_id &&
    zs.organizations.all().some((org) => !org.deleted && org.external_id === input.external_id)
  ) {
    throw recordInvalid({ external_id: "External has already been taken" });
  }
  const id = input.id ?? nextId(zs, "organizations");
  if (input.id !== undefined) {
    if (zs.organizations.findOneBy("zd_id", id)) throw recordInvalid({ id: "Id: has already been taken" });
    reserveId(zs, "organizations", id);
  }
  const organization = zs.organizations.insert({
    zd_id: id,
    name,
    details: input.details ?? null,
    notes: input.notes ?? null,
    domain_names: input.domain_names ?? [],
    external_id: input.external_id ?? null,
    group_id: input.group_id ?? null,
    shared_tickets: input.shared_tickets ?? false,
    shared_comments: input.shared_comments ?? false,
    tags: input.tags ?? [],
    organization_fields: input.organization_fields ?? {},
    deleted: false,
  });
  if (options.emit !== false) {
    await emitZendeskEvent(
      ctx,
      "zen:event-type:organization.created",
      `zen:organization:${organization.zd_id}`,
      organizationDetail(ctx, organization),
    );
  }
  return organization;
}

export async function updateOrganization(
  ctx: ZendeskCtx,
  organization: ZendeskOrganization,
  input: OrganizationInput,
  options: RecordOptions = {},
): Promise<ZendeskOrganization> {
  const { zs } = ctx;
  const updates: Partial<ZendeskOrganization> = {};
  const events: Array<{ type: string; event: Record<string, unknown> }> = [];
  if (input.name !== undefined && input.name.trim() !== organization.name) {
    const name = input.name.trim();
    if (!name) throw recordInvalid({ name: "Name: cannot be blank" });
    const other = findOrganizationByName(zs, name);
    if (other && other.zd_id !== organization.zd_id) throw recordInvalid({ name: "Name: has already been taken" });
    updates.name = name;
    events.push({ type: "organization.name_changed", event: { current: name, previous: organization.name } });
  }
  if (input.external_id !== undefined && input.external_id !== organization.external_id) {
    updates.external_id = input.external_id;
    events.push({
      type: "organization.external_id_changed",
      event: { current: input.external_id, previous: organization.external_id },
    });
  }
  if (input.tags !== undefined && JSON.stringify(input.tags) !== JSON.stringify(organization.tags)) {
    updates.tags = input.tags;
    events.push({ type: "organization.tags_changed", event: { current: input.tags, previous: organization.tags } });
  }
  if (input.organization_fields !== undefined) {
    updates.organization_fields = { ...organization.organization_fields, ...input.organization_fields };
    for (const [key, value] of Object.entries(input.organization_fields)) {
      if (JSON.stringify(organization.organization_fields[key] ?? null) !== JSON.stringify(value ?? null)) {
        events.push({
          type: "organization.custom_field_changed",
          event: { field: key, current: value, previous: organization.organization_fields[key] ?? null },
        });
      }
    }
  }
  for (const key of ["details", "notes", "domain_names", "group_id", "shared_tickets", "shared_comments"] as const) {
    if (input[key] !== undefined) (updates as Record<string, unknown>)[key] = input[key];
  }
  const updated = zs.organizations.update(organization.id, updates)!;
  if (options.emit !== false) {
    for (const change of events) {
      await emitZendeskEvent(
        ctx,
        `zen:event-type:${change.type}`,
        `zen:organization:${updated.zd_id}`,
        organizationDetail(ctx, updated),
        change.event,
      );
    }
  }
  return updated;
}

export async function deleteOrganization(
  ctx: ZendeskCtx,
  organization: ZendeskOrganization,
  options: RecordOptions = {},
): Promise<ZendeskOrganization> {
  const { zs } = ctx;
  for (const membership of zs.organizationMemberships.findBy("organization_id", organization.zd_id)) {
    zs.organizationMemberships.delete(membership.id);
  }
  for (const user of zs.users.findBy("organization_id", organization.zd_id)) {
    const remaining = zs.organizationMemberships.findBy("user_id", user.zd_id)[0];
    zs.users.update(user.id, { organization_id: remaining?.organization_id ?? null });
  }
  const deleted = zs.organizations.update(organization.id, { deleted: true })!;
  if (options.emit !== false) {
    await emitZendeskEvent(
      ctx,
      "zen:event-type:organization.deleted",
      `zen:organization:${deleted.zd_id}`,
      organizationDetail(ctx, deleted),
    );
  }
  return deleted;
}

export function addOrganizationMembership(
  zs: ZendeskStore,
  userId: number,
  organizationId: number,
  makeDefault = false,
): ZendeskOrganizationMembership {
  const user = zs.users.findOneBy("zd_id", userId);
  if (!user || user.deleted) throw recordInvalid({ user_id: "User: Invalid user" });
  const organization = zs.organizations.findOneBy("zd_id", organizationId);
  if (!organization || organization.deleted)
    throw recordInvalid({ organization_id: "Organization: Invalid organization" });
  const existing = zs.organizationMemberships
    .findBy("user_id", userId)
    .find((membership) => membership.organization_id === organizationId);
  if (existing) throw recordInvalid({ user_id: "User has already been taken" });
  const isFirst = zs.organizationMemberships.findBy("user_id", userId).length === 0;
  const membership = zs.organizationMemberships.insert({
    zd_id: nextId(zs, "organization_memberships"),
    user_id: userId,
    organization_id: organizationId,
    default: makeDefault || isFirst,
  });
  if (membership.default) {
    for (const other of zs.organizationMemberships.findBy("user_id", userId)) {
      if (other.id !== membership.id && other.default) zs.organizationMemberships.update(other.id, { default: false });
    }
    zs.users.update(user.id, { organization_id: organizationId });
  }
  return membership;
}

export function removeOrganizationMembership(zs: ZendeskStore, membership: ZendeskOrganizationMembership): void {
  zs.organizationMemberships.delete(membership.id);
  const user = zs.users.findOneBy("zd_id", membership.user_id);
  if (user && user.organization_id === membership.organization_id) {
    const remaining = zs.organizationMemberships.findBy("user_id", user.zd_id)[0];
    if (remaining) zs.organizationMemberships.update(remaining.id, { default: true });
    zs.users.update(user.id, { organization_id: remaining?.organization_id ?? null });
  }
}

export function createGroup(
  zs: ZendeskStore,
  input: { id?: number; name: string; description?: string | null; default?: boolean; is_public?: boolean },
): ZendeskGroup {
  const name = input.name.trim();
  if (!name) throw recordInvalid({ name: "Name: cannot be blank" });
  if (zs.groups.all().some((group) => !group.deleted && group.name.toLowerCase() === name.toLowerCase())) {
    throw recordInvalid({ name: "Name: has already been taken" });
  }
  const id = input.id ?? nextId(zs, "groups");
  if (input.id !== undefined) reserveId(zs, "groups", id);
  const makeDefault = input.default ?? zs.groups.all().filter((group) => !group.deleted).length === 0;
  if (makeDefault) {
    for (const group of zs.groups.all()) if (group.default) zs.groups.update(group.id, { default: false });
  }
  return zs.groups.insert({
    zd_id: id,
    name,
    description: input.description ?? null,
    is_public: input.is_public ?? true,
    default: makeDefault,
    deleted: false,
  });
}

export function addGroupMembership(zs: ZendeskStore, userId: number, groupId: number, makeDefault = false) {
  const user = zs.users.findOneBy("zd_id", userId);
  if (!user || user.deleted || user.role === "end-user") throw recordInvalid({ user_id: "User: must be an agent" });
  const group = zs.groups.findOneBy("zd_id", groupId);
  if (!group || group.deleted) throw recordInvalid({ group_id: "Group: Invalid group" });
  const existing = zs.groupMemberships.findBy("user_id", userId).find((membership) => membership.group_id === groupId);
  if (existing) throw recordInvalid({ user_id: "User has already been taken" });
  const isFirst = zs.groupMemberships.findBy("user_id", userId).length === 0;
  const membership = zs.groupMemberships.insert({
    zd_id: nextId(zs, "group_memberships"),
    user_id: userId,
    group_id: groupId,
    default: makeDefault || isFirst,
  });
  if (membership.default) {
    for (const other of zs.groupMemberships.findBy("user_id", userId)) {
      if (other.id !== membership.id && other.default) zs.groupMemberships.update(other.id, { default: false });
    }
    zs.users.update(user.id, { default_group_id: groupId });
  }
  return membership;
}

export function createJob(zs: ZendeskStore, results: JobResult[], message: string | null = null): ZendeskJobStatus {
  return zs.jobStatuses.insert({
    zd_id: hexToken(16),
    status: "completed",
    message,
    progress: results.length,
    total: results.length,
    results,
  });
}

export function requireUser(zs: ZendeskStore, id: number): ZendeskUser {
  const user = zs.users.findOneBy("zd_id", id);
  if (!user || user.deleted) throw recordNotFound();
  return user;
}

export function requireOrganization(zs: ZendeskStore, id: number): ZendeskOrganization {
  const organization = zs.organizations.findOneBy("zd_id", id);
  if (!organization || organization.deleted) throw recordNotFound();
  return organization;
}

export async function emitMembershipCreated(ctx: ZendeskCtx, user: ZendeskUser, organizationId: number): Promise<void> {
  await emitZendeskEvent(
    ctx,
    "zen:event-type:user.organization_membership_created",
    `zen:user:${user.zd_id}`,
    userDetail(ctx, user),
    {
      organization_id: organizationId,
    },
  );
}
