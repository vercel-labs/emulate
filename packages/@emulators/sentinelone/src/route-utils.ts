import type { AppEnv, Hono } from "@emulators/core";
import type { S1Account, S1Agent, S1Group, S1Licenses, S1Site, S1User, ScopeLevel } from "./entities.js";
import type { Fmt } from "./formatters.js";
import { list, notFound, num, obj, str, token, validation, type Body, type QueryParams } from "./helpers.js";
import { logActivity, logEvent, nextId, type S1Store } from "./store.js";

export interface S1RouteContext {
  app: Hono<AppEnv>;
  ss: S1Store;
  fmt: Fmt;
  baseUrl: string;
}

export const SYSTEM_USER = { id: "1000000000000000001", fullName: "Emulate System" };

export function findAccount(ss: S1Store, id: string): S1Account {
  const account = ss.accounts.findOneBy("s1_id", id);
  if (!account) throw notFound(`Account ${id} was not found`);
  return account;
}

export function findSite(ss: S1Store, id: string): S1Site {
  const site = ss.sites.findOneBy("s1_id", id);
  if (!site) throw notFound(`Site ${id} was not found`);
  return site;
}

export function findGroup(ss: S1Store, id: string): S1Group {
  const group = ss.groups.findOneBy("s1_id", id);
  if (!group) throw notFound(`Group ${id} was not found`);
  return group;
}

export function findAgent(ss: S1Store, id: string): S1Agent {
  const agent = ss.agents.findOneBy("s1_id", id) ?? ss.agents.findOneBy("uuid", id);
  if (!agent) throw notFound(`Agent ${id} was not found`);
  return agent;
}

export function findUser(ss: S1Store, id: string): S1User {
  const user = ss.users.findOneBy("s1_id", id);
  if (!user) throw notFound(`User ${id} was not found`);
  return user;
}

export function requestUser(ss: S1Store, userId: string | null): { id: string; fullName: string } {
  const user = userId ? ss.users.findOneBy("s1_id", userId) : undefined;
  return user ? { id: user.s1_id, fullName: user.fullName } : SYSTEM_USER;
}

export function parseLicenses(value: unknown, fallback: S1Licenses): S1Licenses {
  const record = obj(value);
  if (!record) return fallback;
  const bundles = Array.isArray(record.bundles)
    ? record.bundles.map((entry) => {
        const bundle = obj(entry) ?? {};
        const name = str(bundle.name);
        if (!name) throw validation("licenses.bundles[].name is required");
        return {
          name,
          surfaces: Array.isArray(bundle.surfaces)
            ? bundle.surfaces.map((surfaceEntry) => {
                const surface = obj(surfaceEntry) ?? {};
                return { name: str(surface.name) ?? "Total Agents", count: num(surface.count) ?? -1 };
              })
            : [{ name: "Total Agents", count: -1 }],
        };
      })
    : fallback.bundles;
  return {
    bundles,
    modules: Array.isArray(record.modules)
      ? record.modules.map((entry) => ({ name: str((obj(entry) ?? {}).name) ?? "" })).filter((module) => module.name)
      : fallback.modules,
    settings: Array.isArray(record.settings)
      ? record.settings.map((entry) => {
          const setting = obj(entry) ?? {};
          return {
            groupName: str(setting.groupName) ?? "",
            setting: str(setting.setting) ?? "",
            displayName: str(setting.displayName),
            settingGroup: str(setting.settingGroup),
            settingGroupDisplayName: str(setting.settingGroupDisplayName),
          };
        })
      : fallback.settings,
  };
}

export interface ScopeSelection {
  accountIds?: string[];
  siteIds?: string[];
  groupIds?: string[];
  tenant: boolean;
}

export function scopeFromParams(params: QueryParams): ScopeSelection {
  return {
    accountIds: params.list("accountIds"),
    siteIds: params.list("siteIds"),
    groupIds: params.list("groupIds"),
    tenant: params.bool("tenant") ?? false,
  };
}

export function scopeFromBody(filter: Body): ScopeSelection {
  return {
    accountIds: list(filter.accountIds),
    siteIds: list(filter.siteIds),
    groupIds: list(filter.groupIds),
    tenant: Boolean(filter.tenant),
  };
}

export function agentInScope(ss: S1Store, agent: S1Agent, scope: ScopeSelection): boolean {
  if (scope.groupIds && scope.groupIds.length > 0 && !scope.groupIds.includes(agent.group_id)) return false;
  if (scope.siteIds && scope.siteIds.length > 0 && !scope.siteIds.includes(agent.site_id)) return false;
  if (scope.accountIds && scope.accountIds.length > 0) {
    const site = ss.sites.findOneBy("s1_id", agent.site_id);
    if (!site || !scope.accountIds.includes(site.account_id)) return false;
  }
  return true;
}

export function scopedEntityMatches(
  ss: S1Store,
  entity: { scope_level: ScopeLevel; scope_id: string | null },
  scope: ScopeSelection,
): boolean {
  if (!scope.accountIds && !scope.siteIds && !scope.groupIds && !scope.tenant) return true;
  if (entity.scope_level === "tenant") return scope.tenant || (!scope.accountIds && !scope.siteIds && !scope.groupIds);
  if (entity.scope_level === "account") return !!scope.accountIds?.includes(entity.scope_id ?? "");
  if (entity.scope_level === "site") {
    if (scope.siteIds?.includes(entity.scope_id ?? "")) return true;
    const site = ss.sites.findOneBy("s1_id", entity.scope_id ?? "");
    return !!site && !!scope.accountIds?.includes(site.account_id) && !scope.siteIds;
  }
  if (scope.groupIds?.includes(entity.scope_id ?? "")) return true;
  const group = ss.groups.findOneBy("s1_id", entity.scope_id ?? "");
  if (!group) return false;
  if (scope.siteIds?.includes(group.site_id) && !scope.groupIds) return true;
  const site = ss.sites.findOneBy("s1_id", group.site_id);
  return !!site && !!scope.accountIds?.includes(site.account_id) && !scope.siteIds && !scope.groupIds;
}

export function resolveScopeTarget(ss: S1Store, filter: Body): { level: ScopeLevel; id: string | null } {
  const explicitLevel = str(filter.scopeLevel);
  const explicitId = str(filter.scopeLevelId);
  if (explicitLevel) {
    const level = explicitLevel.toLowerCase() as ScopeLevel;
    if (!["tenant", "account", "site", "group"].includes(level))
      throw validation("scopeLevel must be one of: tenant, account, site, group");
    if (level !== "tenant") {
      if (!explicitId) throw validation("scopeLevelId is required");
      if (level === "account") findAccount(ss, explicitId);
      if (level === "site") findSite(ss, explicitId);
      if (level === "group") findGroup(ss, explicitId);
    }
    return { level, id: level === "tenant" ? null : explicitId! };
  }
  const groupIds = list(filter.groupIds);
  if (groupIds && groupIds.length > 0) return { level: "group", id: findGroup(ss, groupIds[0]).s1_id };
  const siteIds = list(filter.siteIds);
  if (siteIds && siteIds.length > 0) return { level: "site", id: findSite(ss, siteIds[0]).s1_id };
  const accountIds = list(filter.accountIds);
  if (accountIds && accountIds.length > 0) return { level: "account", id: findAccount(ss, accountIds[0]).s1_id };
  return { level: "tenant", id: null };
}

export interface CreateGroupInput {
  siteId: string;
  name: string;
  inherits?: boolean;
  filterId?: string | null;
  type?: S1Group["type"];
  description?: string | null;
  isDefault?: boolean;
  policy?: Record<string, unknown> | null;
  creator?: { id: string; fullName: string };
}

export function createGroup(ss: S1Store, input: CreateGroupInput): S1Group {
  const site = findSite(ss, input.siteId);
  const name = input.name.trim();
  if (!name) throw validation("name is required");
  if (ss.groups.findBy("site_id", site.s1_id).some((group) => group.name.toLowerCase() === name.toLowerCase()))
    throw validation(`A group named ${name} already exists in site ${site.name}`, 4000030);
  if (input.filterId) {
    const filter = ss.filters.findOneBy("s1_id", input.filterId);
    if (!filter) throw notFound(`Filter ${input.filterId} was not found`);
  }
  const creator = input.creator ?? SYSTEM_USER;
  const group = ss.groups.insert({
    s1_id: nextId(ss),
    site_id: site.s1_id,
    name,
    description: input.description ?? null,
    type: input.type ?? (input.filterId ? "dynamic" : "static"),
    rank: ss.groups.findBy("site_id", site.s1_id).length + 1,
    isDefault: input.isDefault ?? false,
    inherits: input.inherits ?? true,
    filter_id: input.filterId ?? null,
    registrationToken: token(64),
    policy: input.policy ?? null,
    creator: creator.fullName,
    creatorId: creator.id,
  });
  logActivity(ss, {
    activityType: 1000,
    primaryDescription: `Group ${group.name} was created in site ${site.name}`,
    siteId: site.s1_id,
    accountId: site.account_id,
    groupId: group.s1_id,
    userId: creator.id,
  });
  logEvent(ss, "group.created", group.s1_id, { name: group.name, siteId: site.s1_id, type: group.type });
  return group;
}

export function defaultGroupOf(ss: S1Store, siteId: string): S1Group {
  const existing =
    ss.groups.findBy("site_id", siteId).find((group) => group.isDefault) ?? ss.groups.findBy("site_id", siteId)[0];
  if (existing) return existing;
  return createGroup(ss, { siteId, name: "Default Group", isDefault: true, type: "static" });
}

export function agentMatchesFilter(agent: S1Agent, filterFields: Record<string, unknown>): boolean {
  const machineTypes = list(filterFields.machineTypes);
  const osTypes = list(filterFields.osTypes);
  if (
    machineTypes &&
    machineTypes.length > 0 &&
    !machineTypes.map((type) => type.toLowerCase()).includes(agent.machineType.toLowerCase())
  )
    return false;
  if (osTypes && osTypes.length > 0 && !osTypes.map((type) => type.toLowerCase()).includes(agent.osType.toLowerCase()))
    return false;
  const computerName = list(filterFields.computerName__contains);
  if (
    computerName &&
    computerName.length > 0 &&
    !computerName.some((fragment) => agent.computerName.toLowerCase().includes(fragment.toLowerCase()))
  )
    return false;
  return true;
}

export function assignAgentToGroup(ss: S1Store, agent: S1Agent): S1Agent {
  const dynamicGroups = ss.groups
    .findBy("site_id", agent.site_id)
    .filter((group) => group.type === "dynamic" && group.filter_id)
    .sort((a, b) => a.rank - b.rank);
  for (const group of dynamicGroups) {
    const filter = ss.filters.findOneBy("s1_id", group.filter_id!);
    if (filter && agentMatchesFilter(agent, filter.filterFields))
      return ss.agents.update(agent.id, { group_id: group.s1_id })!;
  }
  const current = ss.groups.findOneBy("s1_id", agent.group_id);
  if (current && current.site_id === agent.site_id && current.type !== "dynamic") return agent;
  return ss.agents.update(agent.id, { group_id: defaultGroupOf(ss, agent.site_id).s1_id })!;
}

export function reassignSiteAgents(ss: S1Store, siteId: string): void {
  for (const agent of ss.agents.findBy("site_id", siteId)) assignAgentToGroup(ss, agent);
}
