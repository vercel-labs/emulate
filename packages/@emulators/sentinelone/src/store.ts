import { Store, type Collection } from "@emulators/core";
import type {
  S1Account,
  S1Activity,
  S1Agent,
  S1ApiToken,
  S1Application,
  S1Cve,
  S1DeviceRule,
  S1EventLog,
  S1Exclusion,
  S1Filter,
  S1Group,
  S1Restriction,
  S1Role,
  S1Site,
  S1Threat,
  S1User,
} from "./entities.js";

export interface S1Store {
  raw: Store;
  apiTokens: Collection<S1ApiToken>;
  accounts: Collection<S1Account>;
  sites: Collection<S1Site>;
  groups: Collection<S1Group>;
  filters: Collection<S1Filter>;
  agents: Collection<S1Agent>;
  users: Collection<S1User>;
  roles: Collection<S1Role>;
  threats: Collection<S1Threat>;
  applications: Collection<S1Application>;
  cves: Collection<S1Cve>;
  exclusions: Collection<S1Exclusion>;
  restrictions: Collection<S1Restriction>;
  deviceRules: Collection<S1DeviceRule>;
  activities: Collection<S1Activity>;
  events: Collection<S1EventLog>;
}

export function getS1Store(store: Store): S1Store {
  return {
    raw: store,
    apiTokens: store.collection<S1ApiToken>("sentinelone.api_tokens", ["token", "user_id"]),
    accounts: store.collection<S1Account>("sentinelone.accounts", ["s1_id", "name", "externalId"]),
    sites: store.collection<S1Site>("sentinelone.sites", ["s1_id", "account_id", "registrationToken", "externalId"]),
    groups: store.collection<S1Group>("sentinelone.groups", ["s1_id", "site_id", "registrationToken"]),
    filters: store.collection<S1Filter>("sentinelone.filters", ["s1_id", "scope_id"]),
    agents: store.collection<S1Agent>("sentinelone.agents", ["s1_id", "uuid", "site_id", "group_id"]),
    users: store.collection<S1User>("sentinelone.users", ["s1_id", "email"]),
    roles: store.collection<S1Role>("sentinelone.roles", ["s1_id", "name"]),
    threats: store.collection<S1Threat>("sentinelone.threats", ["s1_id", "agent_id"]),
    applications: store.collection<S1Application>("sentinelone.applications", ["s1_id", "agent_id"]),
    cves: store.collection<S1Cve>("sentinelone.cves", ["s1_id", "application_id", "cveId"]),
    exclusions: store.collection<S1Exclusion>("sentinelone.exclusions", ["s1_id", "scope_id"]),
    restrictions: store.collection<S1Restriction>("sentinelone.restrictions", ["s1_id", "scope_id"]),
    deviceRules: store.collection<S1DeviceRule>("sentinelone.device_rules", ["s1_id", "scope_id"]),
    activities: store.collection<S1Activity>("sentinelone.activities", ["s1_id", "site_id"]),
    events: store.collection<S1EventLog>("sentinelone.events", ["type"]),
  };
}

const NEXT_ID_KEY = "sentinelone.next_id";
const TENANT_KEY = "sentinelone.tenant";
const GLOBAL_POLICY_KEY = "sentinelone.global_policy";

export interface S1Tenant {
  name: string;
  consoleUrl: string;
  region: string;
}

export const DEFAULT_TENANT: S1Tenant = {
  name: "Emulate MSSP",
  consoleUrl: "https://emulate.sentinelone.net",
  region: "eu",
};

const ID_BASE = 2250000000000000000n;

export function nextId(ss: S1Store): string {
  const current = ss.raw.getData<number>(NEXT_ID_KEY) ?? 1;
  ss.raw.setData(NEXT_ID_KEY, current + 1);
  return String(ID_BASE + BigInt(current) * 7919n);
}

export function tenant(ss: S1Store): S1Tenant {
  return ss.raw.getData<S1Tenant>(TENANT_KEY) ?? DEFAULT_TENANT;
}

export function setTenant(ss: S1Store, value: Partial<S1Tenant>): void {
  ss.raw.setData(TENANT_KEY, { ...tenant(ss), ...value });
}

export function globalPolicy(ss: S1Store): Record<string, unknown> | null {
  return ss.raw.getData<Record<string, unknown>>(GLOBAL_POLICY_KEY) ?? null;
}

export function setGlobalPolicy(ss: S1Store, value: Record<string, unknown>): void {
  ss.raw.setData(GLOBAL_POLICY_KEY, value);
}

export function logEvent(ss: S1Store, type: string, subject: string, detail: Record<string, unknown>): void {
  ss.events.insert({ type, subject, detail });
  const all = ss.events.all();
  if (all.length > 1000) for (const stale of all.slice(0, all.length - 1000)) ss.events.delete(stale.id);
}

export function logActivity(
  ss: S1Store,
  input: {
    activityType: number;
    primaryDescription: string;
    secondaryDescription?: string | null;
    accountId?: string | null;
    siteId?: string | null;
    groupId?: string | null;
    agentId?: string | null;
    threatId?: string | null;
    userId?: string | null;
    data?: Record<string, unknown>;
  },
): void {
  ss.activities.insert({
    s1_id: nextId(ss),
    activityType: input.activityType,
    primaryDescription: input.primaryDescription,
    secondaryDescription: input.secondaryDescription ?? null,
    account_id: input.accountId ?? null,
    site_id: input.siteId ?? null,
    group_id: input.groupId ?? null,
    agent_id: input.agentId ?? null,
    threat_id: input.threatId ?? null,
    user_id: input.userId ?? null,
    data: input.data ?? {},
  });
}
