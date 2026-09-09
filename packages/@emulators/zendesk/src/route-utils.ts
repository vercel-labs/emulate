import type { AppEnv, Hono } from "@emulators/core";
import type { ZendeskGroup, ZendeskOrganization, ZendeskTicket, ZendeskUser } from "./entities.js";
import type { Fmt } from "./formatters.js";
import { recordNotFound } from "./helpers.js";
import type { ZendeskStore } from "./store.js";
import type { ZendeskCtx } from "./webhooks.js";

export interface ZendeskRouteContext {
  app: Hono<AppEnv>;
  zs: ZendeskStore;
  ctx: ZendeskCtx;
  fmt: Fmt;
  baseUrl: string;
}

export function idParam(value: string): number {
  const parsed = Number(value.replace(/\.json$/, ""));
  if (!Number.isFinite(parsed)) throw recordNotFound();
  return parsed;
}

export function findTicket(zs: ZendeskStore, id: number, includeDeleted = false): ZendeskTicket {
  const ticket = zs.tickets.findOneBy("zd_id", id);
  if (!ticket || (ticket.deleted && !includeDeleted)) throw recordNotFound();
  return ticket;
}

export function findUser(zs: ZendeskStore, id: number): ZendeskUser {
  const user = zs.users.findOneBy("zd_id", id);
  if (!user || user.deleted) throw recordNotFound();
  return user;
}

export function findOrganization(zs: ZendeskStore, id: number): ZendeskOrganization {
  const organization = zs.organizations.findOneBy("zd_id", id);
  if (!organization || organization.deleted) throw recordNotFound();
  return organization;
}

export function findGroup(zs: ZendeskStore, id: number): ZendeskGroup {
  const group = zs.groups.findOneBy("zd_id", id);
  if (!group || group.deleted) throw recordNotFound();
  return group;
}

export function liveTickets(zs: ZendeskStore): ZendeskTicket[] {
  return zs.tickets.all().filter((ticket) => !ticket.deleted);
}

export function liveUsers(zs: ZendeskStore): ZendeskUser[] {
  return zs.users.all().filter((user) => !user.deleted);
}

export function liveOrganizations(zs: ZendeskStore): ZendeskOrganization[] {
  return zs.organizations.all().filter((organization) => !organization.deleted);
}

export function canSeeTicket(zs: ZendeskStore, user: ZendeskUser, ticket: ZendeskTicket): boolean {
  if (user.role !== "end-user") return true;
  if (
    ticket.requester_id === user.zd_id ||
    ticket.collaborator_ids.includes(user.zd_id) ||
    ticket.email_cc_ids.includes(user.zd_id)
  )
    return true;
  if (ticket.organization_id !== null) {
    const organization = zs.organizations.findOneBy("zd_id", ticket.organization_id);
    if (
      organization?.shared_tickets &&
      zs.organizationMemberships.findBy("user_id", user.zd_id).some((m) => m.organization_id === ticket.organization_id)
    ) {
      return true;
    }
  }
  return false;
}
