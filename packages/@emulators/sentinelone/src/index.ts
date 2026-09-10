import type { AppEnv, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import type {
  BillingMode,
  MachineType,
  OsType,
  RiskSeverity,
  S1Licenses,
  S1Policy,
  SiteType,
  ThreatConfidence,
  ThreatIncidentStatus,
  ThreatMitigationStatus,
  UsageType,
  UserScope,
} from "./entities.js";
import type { Fmt } from "./formatters.js";
import { token } from "./helpers.js";
import { stripPolicyMeta } from "./policy.js";
import { accountRoutes, DEFAULT_ACCOUNT_LICENSES } from "./routes/accounts.js";
import { agentRoutes, registerAgent } from "./routes/agents.js";
import { groupRoutes } from "./routes/groups.js";
import { inspectorRoutes } from "./routes/inspector.js";
import { miscRoutes } from "./routes/misc.js";
import { protectionRoutes } from "./routes/protection.js";
import { addCve, riskRoutes, upsertApplication } from "./routes/risks.js";
import { siteRoutes } from "./routes/sites.js";
import { createThreat, threatRoutes } from "./routes/threats.js";
import { createUser, userRoutes } from "./routes/users.js";
import { createGroup, defaultGroupOf, SYSTEM_USER, type S1RouteContext } from "./route-utils.js";
import { getS1Store, logEvent, nextId, setGlobalPolicy, setTenant, type S1Store, type S1Tenant } from "./store.js";

export { getS1Store, type S1Store } from "./store.js";
export * from "./entities.js";
export { DEFAULT_POLICY } from "./policy.js";
export { registerAgent, type RegisterAgentInput } from "./routes/agents.js";
export { createThreat, type CreateThreatInput } from "./routes/threats.js";

export interface SentinelOneSeedAgent {
  id?: string;
  computerName: string;
  osType?: OsType;
  osName?: string;
  osRevision?: string;
  machineType?: MachineType;
  agentVersion?: string;
  domain?: string;
  lastLoggedInUserName?: string;
  isActive?: boolean;
  lastActiveDate?: string;
  consoleMigrationStatus?: "Migrated" | "Pending" | "N/A" | "Failed";
  group?: string;
  externalId?: string;
  tags?: string[];
  threats?: Array<{
    threatName: string;
    classification?: string;
    confidenceLevel?: ThreatConfidence;
    mitigationStatus?: ThreatMitigationStatus;
    incidentStatus?: ThreatIncidentStatus;
    filePath?: string;
    sha1?: string;
  }>;
  applications?: Array<{
    name: string;
    vendor?: string;
    version?: string;
    cves?: Array<{
      cveId: string;
      baseScore?: number;
      severity?: RiskSeverity;
      detectionDate?: string;
      ransomware?: boolean;
      exploitedInTheWild?: boolean;
    }>;
  }>;
}

export interface SentinelOneSeedSite {
  id?: string;
  name: string;
  siteType?: SiteType;
  externalId?: string;
  description?: string;
  expiration?: string | null;
  unlimitedExpiration?: boolean;
  unlimitedLicenses?: boolean;
  totalLicenses?: number;
  inherits?: boolean;
  licenses?: Partial<S1Licenses>;
  policy?: S1Policy;
  registrationToken?: string;
  filters?: Array<{ id?: string; name: string; machineTypes?: string[]; osTypes?: string[] }>;
  groups?: Array<{
    id?: string;
    name: string;
    filter?: string;
    type?: "static" | "pinned" | "dynamic";
    inherits?: boolean;
    policy?: S1Policy;
  }>;
  agents?: SentinelOneSeedAgent[];
}

export interface SentinelOneSeedAccount {
  id?: string;
  name: string;
  accountType?: SiteType;
  usageType?: UsageType;
  billingMode?: BillingMode;
  externalId?: string;
  expiration?: string | null;
  unlimitedExpiration?: boolean;
  inherits?: boolean;
  licenses?: Partial<S1Licenses>;
  policy?: S1Policy;
  sites?: SentinelOneSeedSite[];
}

export interface SentinelOneSeedConfig {
  port?: number;
  baseUrl?: string;
  tenant?: Partial<S1Tenant>;
  api_tokens?: Array<{ token: string; description?: string; user?: string; expires_at?: string | null }>;
  global_policy?: S1Policy;
  roles?: Array<{ id?: string; name: string; description?: string; scope?: UserScope; predefined?: boolean }>;
  accounts?: SentinelOneSeedAccount[];
  users?: Array<{
    id?: string;
    email: string;
    fullName: string;
    scope?: UserScope;
    scopeRoles?: Array<{ id?: string; account?: string; site?: string; roleId?: string; role?: string }>;
    twoFaEnabled?: boolean;
    emailVerified?: boolean;
    canGenerateApiToken?: boolean;
    source?: "mgmt" | "sso" | "scim";
  }>;
}

export const DEFAULT_API_TOKEN = "test_emulate_sentinelone_api_token";
export const DEFAULT_ACCOUNT_ID = "2250000000000000001";
export const DEFAULT_ACCOUNT_NAME = "EMULATE MSSP";
export const DEFAULT_SITE_ID = "2250000000000000101";
export const DEFAULT_SITE_NAME = "ACME CORP";
export const DEFAULT_TRIAL_SITE_ID = "2250000000000000102";
export const DEFAULT_TRIAL_SITE_NAME = "GLOBEX #TRIAL";
export const DEFAULT_SITE_TOKEN = "eyJ1cmwiOiAiaHR0cDovL2xvY2FsaG9zdDo0MDIwIiwgInNpdGVfa2V5IjogImVtdWxhdGUtYWNtZSJ9";
export const DEFAULT_ADMIN_EMAIL = "admin@example.com";
export const DEFAULT_ADMIN_ID = "2250000000000001001";
export const DEFAULT_ANALYST_EMAIL = "analyst@example.com";
export const DEFAULT_ROLE_IDS = {
  admin: "2250000000000009001",
  viewer: "2250000000000009002",
  it: "2250000000000009003",
  soc: "2250000000000009004",
  irTeam: "2250000000000009005",
  cLevel: "2250000000000009006",
  mspAdmin: "2250000000000009101",
  mspTech: "2250000000000009102",
  mspViewer: "2250000000000009103",
  edrAdmin: "2250000000000009104",
  customerAdmin: "2250000000000009201",
  customerTech: "2250000000000009202",
  customerViewer: "2250000000000009203",
  socN1: "2250000000000009301",
  socN2: "2250000000000009302",
  socN3: "2250000000000009303",
} as const;
export const DEFAULT_WORKSTATION_AGENT_ID = "2250000000000002001";
export const DEFAULT_SERVER_AGENT_ID = "2250000000000002002";
export const DEFAULT_MAC_AGENT_ID = "2250000000000002003";
export const DEFAULT_LINUX_AGENT_ID = "2250000000000002004";

const DEFAULT_GROUP_FILTERS = [
  { name: "Windows-Workstations", machineTypes: ["desktop", "laptop"], osTypes: ["windows"] },
  { name: "Windows-Servers", machineTypes: ["server"], osTypes: ["windows"] },
  { name: "Linux-Workstations", machineTypes: ["desktop", "laptop"], osTypes: ["linux"] },
  { name: "Linux-Servers", machineTypes: ["server"], osTypes: ["linux"] },
  { name: "MacOS-Workstations", machineTypes: ["desktop", "laptop"], osTypes: ["macos"] },
];

export const DEFAULT_SEED: SentinelOneSeedConfig = {
  tenant: { name: "Emulate MSSP", consoleUrl: "https://emulate.sentinelone.net", region: "eu" },
  api_tokens: [{ token: DEFAULT_API_TOKEN, description: "Service API token", user: DEFAULT_ADMIN_EMAIL }],
  roles: [
    { id: DEFAULT_ROLE_IDS.admin, name: "Admin", description: "Full access", scope: "tenant", predefined: true },
    { id: DEFAULT_ROLE_IDS.viewer, name: "Viewer", description: "Read only", scope: "tenant", predefined: true },
    { id: DEFAULT_ROLE_IDS.it, name: "IT", description: "Endpoint operations", scope: "tenant", predefined: true },
    { id: DEFAULT_ROLE_IDS.soc, name: "SOC", description: "Threat handling", scope: "tenant", predefined: true },
    {
      id: DEFAULT_ROLE_IDS.irTeam,
      name: "IR Team",
      description: "Incident response",
      scope: "tenant",
      predefined: true,
    },
    { id: DEFAULT_ROLE_IDS.cLevel, name: "C-Level", description: "Dashboards only", scope: "tenant", predefined: true },
    { id: DEFAULT_ROLE_IDS.mspAdmin, name: "MSP Admin", description: "Manage an MSP account", scope: "account" },
    { id: DEFAULT_ROLE_IDS.mspTech, name: "MSP Tech", description: "Operate an MSP account", scope: "account" },
    { id: DEFAULT_ROLE_IDS.mspViewer, name: "MSP Viewer", description: "View an MSP account", scope: "account" },
    { id: DEFAULT_ROLE_IDS.edrAdmin, name: "EDR Admin", description: "Manage EDR accounts", scope: "account" },
    {
      id: DEFAULT_ROLE_IDS.customerAdmin,
      name: "Customer Admin",
      description: "Manage a customer site",
      scope: "site",
    },
    { id: DEFAULT_ROLE_IDS.customerTech, name: "Customer Tech", description: "Operate a customer site", scope: "site" },
    {
      id: DEFAULT_ROLE_IDS.customerViewer,
      name: "Customer Viewer",
      description: "View a customer site",
      scope: "site",
    },
    { id: DEFAULT_ROLE_IDS.socN1, name: "SOC N1", description: "Level 1 analyst", scope: "site" },
    { id: DEFAULT_ROLE_IDS.socN2, name: "SOC N2", description: "Level 2 analyst", scope: "site" },
    { id: DEFAULT_ROLE_IDS.socN3, name: "SOC N3", description: "Level 3 analyst", scope: "site" },
  ],
  accounts: [
    {
      id: DEFAULT_ACCOUNT_ID,
      name: DEFAULT_ACCOUNT_NAME,
      accountType: "Paid",
      usageType: "mssp",
      billingMode: "consumption",
      unlimitedExpiration: true,
      licenses: { bundles: [{ name: "complete", surfaces: [{ name: "Total Agents", count: -1 }] }] },
      sites: [
        {
          id: DEFAULT_SITE_ID,
          name: DEFAULT_SITE_NAME,
          siteType: "Paid",
          externalId: "11111111-1111-4111-8111-111111111111",
          expiration: "2027-12-31T00:00:00.000Z",
          unlimitedLicenses: true,
          registrationToken: DEFAULT_SITE_TOKEN,
          filters: DEFAULT_GROUP_FILTERS,
          groups: DEFAULT_GROUP_FILTERS.map((filter) => ({ name: filter.name, filter: filter.name })),
          agents: [
            {
              id: DEFAULT_WORKSTATION_AGENT_ID,
              computerName: "ACME-WS-001",
              osType: "windows",
              osName: "Windows 11 Pro",
              osRevision: "22631",
              machineType: "laptop",
              domain: "acme.local",
              lastLoggedInUserName: "alice",
              applications: [
                {
                  name: "Google Chrome",
                  vendor: "Google",
                  version: "124.0.6367.60",
                  cves: [{ cveId: "CVE-2024-4947", baseScore: 8.8, exploitedInTheWild: true }],
                },
                {
                  name: "7-Zip",
                  vendor: "Igor Pavlov",
                  version: "22.01",
                  cves: [{ cveId: "CVE-2023-31102", baseScore: 7.8 }],
                },
              ],
            },
            {
              id: DEFAULT_SERVER_AGENT_ID,
              computerName: "ACME-SRV-FILES",
              osType: "windows",
              osName: "Windows Server 2022 Standard",
              osRevision: "20348",
              machineType: "server",
              domain: "acme.local",
              lastLoggedInUserName: "svc-backup",
              applications: [
                {
                  name: "Windows Server 2022",
                  vendor: "Microsoft",
                  version: "10.0.20348",
                  cves: [{ cveId: "CVE-2024-38063", baseScore: 9.8, exploitedInTheWild: true }],
                },
              ],
              threats: [
                {
                  threatName: "mimikatz.exe",
                  classification: "Hacktool",
                  confidenceLevel: "malicious",
                  mitigationStatus: "not_mitigated",
                  filePath: "C:\\Temp\\mimikatz.exe",
                },
              ],
            },
            {
              id: DEFAULT_MAC_AGENT_ID,
              computerName: "ACME-MBP-CAROL",
              osType: "macos",
              osName: "macOS",
              osRevision: "14.4.1",
              machineType: "laptop",
              domain: "acme.local",
              lastLoggedInUserName: "carol",
              threats: [
                {
                  threatName: "eicar.com",
                  classification: "Malware",
                  confidenceLevel: "malicious",
                  mitigationStatus: "mitigated",
                  incidentStatus: "resolved",
                },
              ],
            },
            {
              id: DEFAULT_LINUX_AGENT_ID,
              computerName: "acme-ubuntu-01",
              osType: "linux",
              osName: "Linux",
              osRevision: "Ubuntu 22.04.4 LTS 5.15.0-105-generic",
              machineType: "server",
              domain: "acme.local",
              lastLoggedInUserName: "root",
              applications: [
                {
                  name: "OpenSSL",
                  vendor: "OpenSSL",
                  version: "3.0.2",
                  cves: [
                    { cveId: "CVE-2023-0286", baseScore: 7.4 },
                    { cveId: "CVE-2022-3602", baseScore: 7.5 },
                  ],
                },
              ],
            },
            {
              computerName: "ACME-OLD-KIOSK",
              osType: "windows",
              osName: "Windows 10 Pro",
              osRevision: "19044",
              machineType: "desktop",
              domain: "acme.local",
              isActive: false,
              lastActiveDate: "2026-06-01T08:00:00.000Z",
              consoleMigrationStatus: "Pending",
            },
          ],
        },
        {
          id: DEFAULT_TRIAL_SITE_ID,
          name: DEFAULT_TRIAL_SITE_NAME,
          siteType: "Trial",
          externalId: "22222222-2222-4222-8222-222222222222",
          expiration: "2026-12-31T00:00:00.000Z",
          unlimitedLicenses: false,
          totalLicenses: 25,
          filters: DEFAULT_GROUP_FILTERS,
          groups: DEFAULT_GROUP_FILTERS.map((filter) => ({ name: filter.name, filter: filter.name })),
          agents: [
            {
              computerName: "GLOBEX-WS-01",
              osType: "windows",
              machineType: "desktop",
              domain: "globex.local",
              lastLoggedInUserName: "dave",
            },
          ],
        },
      ],
    },
  ],
  users: [
    {
      id: DEFAULT_ADMIN_ID,
      email: DEFAULT_ADMIN_EMAIL,
      fullName: "Admin User",
      scope: "tenant",
      emailVerified: true,
      canGenerateApiToken: true,
    },
    {
      email: "msp.admin@example.com",
      fullName: "Morgan MSP",
      scope: "account",
      scopeRoles: [{ account: DEFAULT_ACCOUNT_NAME, role: "MSP Admin" }],
      emailVerified: true,
    },
    {
      email: DEFAULT_ANALYST_EMAIL,
      fullName: "Ana Analyst",
      scope: "site",
      scopeRoles: [{ site: DEFAULT_SITE_NAME, role: "SOC N1" }],
      emailVerified: true,
    },
    {
      email: "customer.admin@acme.example",
      fullName: "Alice Acme",
      scope: "site",
      scopeRoles: [{ site: DEFAULT_SITE_NAME, role: "Customer Admin" }],
    },
  ],
};

function seedLicenses(value: Partial<S1Licenses> | undefined, fallback: S1Licenses): S1Licenses {
  return {
    bundles: value?.bundles ?? fallback.bundles,
    modules: value?.modules ?? fallback.modules,
    settings: value?.settings ?? fallback.settings,
  };
}

export function seedFromConfig(
  store: Store,
  _baseUrl: string,
  config: SentinelOneSeedConfig,
  _webhooks?: WebhookDispatcher,
): void {
  const ss = getS1Store(store);
  if (config.tenant) setTenant(ss, config.tenant);
  if (config.global_policy) setGlobalPolicy(ss, stripPolicyMeta(config.global_policy));

  for (const entry of config.roles ?? []) {
    if ((entry.id && ss.roles.findOneBy("s1_id", entry.id)) || ss.roles.findOneBy("name", entry.name)) continue;
    ss.roles.insert({
      s1_id: entry.id ?? nextId(ss),
      name: entry.name,
      description: entry.description ?? "",
      scope: entry.scope ?? "tenant",
      scope_id: null,
      predefinedRole: entry.predefined ?? false,
      creator: SYSTEM_USER.fullName,
    });
  }
  if (ss.roles.count() === 0)
    ss.roles.insert({
      s1_id: DEFAULT_ROLE_IDS.admin,
      name: "Admin",
      description: "Full access",
      scope: "tenant",
      scope_id: null,
      predefinedRole: true,
      creator: SYSTEM_USER.fullName,
    });
  const roleByRef = (ref: string | undefined) =>
    ref
      ? (ss.roles.findOneBy("s1_id", ref) ??
        ss.roles.findOneBy("name", ref) ??
        ss.roles.all().find((role) => role.name.toLowerCase() === ref.toLowerCase()))
      : undefined;

  for (const entry of config.accounts ?? []) {
    const account =
      (entry.id && ss.accounts.findOneBy("s1_id", entry.id)) ||
      ss.accounts.all().find((candidate) => candidate.name.toLowerCase() === entry.name.toLowerCase()) ||
      ss.accounts.insert({
        s1_id: entry.id ?? nextId(ss),
        name: entry.name,
        accountType: entry.accountType ?? "Paid",
        usageType: entry.usageType ?? "mssp",
        externalId: entry.externalId ?? null,
        billingMode: entry.billingMode ?? "subscription",
        expiration:
          entry.unlimitedExpiration === false
            ? (entry.expiration ?? null)
            : entry.expiration === undefined
              ? null
              : entry.expiration,
        unlimitedExpiration: entry.unlimitedExpiration ?? (entry.expiration === undefined || entry.expiration === null),
        inherits: entry.inherits ?? true,
        licenses: seedLicenses(entry.licenses, DEFAULT_ACCOUNT_LICENSES),
        policy: entry.policy ? stripPolicyMeta(entry.policy) : null,
        state: "active",
        creator: SYSTEM_USER.fullName,
        creatorId: SYSTEM_USER.id,
      });
    for (const siteEntry of entry.sites ?? []) {
      const existing =
        (siteEntry.id && ss.sites.findOneBy("s1_id", siteEntry.id)) ||
        ss.sites
          .findBy("account_id", account.s1_id)
          .find((site) => site.name.toLowerCase() === siteEntry.name.toLowerCase());
      const bundle = seedLicenses(siteEntry.licenses, account.licenses).bundles[0]?.name ?? "control";
      const site =
        existing ||
        ss.sites.insert({
          s1_id: siteEntry.id ?? nextId(ss),
          account_id: account.s1_id,
          name: siteEntry.name,
          siteType: siteEntry.siteType ?? "Paid",
          description: siteEntry.description ?? null,
          externalId: siteEntry.externalId ?? null,
          healthStatus: true,
          unlimitedExpiration: siteEntry.unlimitedExpiration ?? siteEntry.expiration === null,
          unlimitedLicenses: siteEntry.unlimitedLicenses ?? true,
          totalLicenses: siteEntry.totalLicenses ?? 0,
          isDefault: false,
          inherits: siteEntry.inherits ?? true,
          expiration:
            siteEntry.expiration === undefined
              ? new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString()
              : siteEntry.expiration,
          licenses: seedLicenses(siteEntry.licenses, account.licenses),
          registrationToken: siteEntry.registrationToken ?? token(64),
          policy: siteEntry.policy ? stripPolicyMeta(siteEntry.policy) : null,
          state: "active",
          sku: bundle,
          suite: bundle === "complete" ? "Complete" : bundle === "control" ? "Control" : "Core",
          creator: SYSTEM_USER.fullName,
          creatorId: SYSTEM_USER.id,
        });
      defaultGroupOf(ss, site.s1_id);
      for (const filterEntry of siteEntry.filters ?? []) {
        if (
          ss.filters
            .findBy("scope_id", site.s1_id)
            .some((filter) => filter.name.toLowerCase() === filterEntry.name.toLowerCase())
        )
          continue;
        ss.filters.insert({
          s1_id: filterEntry.id ?? nextId(ss),
          scope_level: "site",
          scope_id: site.s1_id,
          name: filterEntry.name,
          filterFields: {
            ...(filterEntry.machineTypes ? { machineTypes: filterEntry.machineTypes } : {}),
            ...(filterEntry.osTypes ? { osTypes: filterEntry.osTypes } : {}),
          },
        });
      }
      for (const groupEntry of siteEntry.groups ?? []) {
        if (
          ss.groups
            .findBy("site_id", site.s1_id)
            .some((group) => group.name.toLowerCase() === groupEntry.name.toLowerCase())
        )
          continue;
        const filter = groupEntry.filter
          ? ss.filters
              .findBy("scope_id", site.s1_id)
              .find(
                (candidate) =>
                  candidate.name.toLowerCase() === groupEntry.filter!.toLowerCase() ||
                  candidate.s1_id === groupEntry.filter,
              )
          : undefined;
        const group = createGroup(ss, {
          siteId: site.s1_id,
          name: groupEntry.name,
          filterId: filter?.s1_id ?? null,
          type: groupEntry.type,
          inherits: groupEntry.inherits,
          policy: groupEntry.policy ? stripPolicyMeta(groupEntry.policy) : null,
        });
        if (groupEntry.id) ss.groups.update(group.id, { s1_id: groupEntry.id });
      }
      for (const agentEntry of siteEntry.agents ?? []) {
        if (
          (agentEntry.id && ss.agents.findOneBy("s1_id", agentEntry.id)) ||
          ss.agents
            .findBy("site_id", site.s1_id)
            .some((agent) => agent.computerName.toLowerCase() === agentEntry.computerName.toLowerCase())
        )
          continue;
        const group = agentEntry.group
          ? ss.groups
              .findBy("site_id", site.s1_id)
              .find(
                (candidate) =>
                  candidate.name.toLowerCase() === agentEntry.group!.toLowerCase() ||
                  candidate.s1_id === agentEntry.group,
              )
          : undefined;
        const agent = registerAgent(ss, {
          siteId: site.s1_id,
          id: agentEntry.id,
          computerName: agentEntry.computerName,
          osType: agentEntry.osType,
          osName: agentEntry.osName,
          osRevision: agentEntry.osRevision,
          machineType: agentEntry.machineType,
          agentVersion: agentEntry.agentVersion,
          domain: agentEntry.domain,
          lastLoggedInUserName: agentEntry.lastLoggedInUserName,
          isActive: agentEntry.isActive,
          lastActiveDate: agentEntry.lastActiveDate,
          registeredAt: agentEntry.lastActiveDate
            ? new Date(Date.parse(agentEntry.lastActiveDate) - 90 * 24 * 3600 * 1000).toISOString()
            : new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString(),
          consoleMigrationStatus: agentEntry.consoleMigrationStatus,
          groupId: group?.s1_id ?? null,
          externalId: agentEntry.externalId ?? null,
          tags: agentEntry.tags,
        });
        for (const threatEntry of agentEntry.threats ?? [])
          createThreat(ss, {
            agentId: agent.s1_id,
            threatName: threatEntry.threatName,
            classification: threatEntry.classification,
            confidenceLevel: threatEntry.confidenceLevel,
            mitigationStatus: threatEntry.mitigationStatus,
            incidentStatus: threatEntry.incidentStatus,
            filePath: threatEntry.filePath,
            sha1: threatEntry.sha1,
          });
        for (const applicationEntry of agentEntry.applications ?? []) {
          const application = upsertApplication(ss, {
            agentId: agent.s1_id,
            name: applicationEntry.name,
            vendor: applicationEntry.vendor,
            version: applicationEntry.version,
          });
          for (const cveEntry of applicationEntry.cves ?? []) {
            if (ss.cves.findBy("application_id", application.s1_id).some((cve) => cve.cveId === cveEntry.cveId))
              continue;
            addCve(ss, {
              applicationId: application.s1_id,
              cveId: cveEntry.cveId,
              baseScore: cveEntry.baseScore ?? null,
              severity: cveEntry.severity,
              detectionDate: cveEntry.detectionDate,
              ransomware: cveEntry.ransomware,
              exploitedInTheWild: cveEntry.exploitedInTheWild,
            });
          }
        }
      }
    }
  }
  if (ss.accounts.count() === 0) {
    ss.accounts.insert({
      s1_id: DEFAULT_ACCOUNT_ID,
      name: DEFAULT_ACCOUNT_NAME,
      accountType: "Paid",
      usageType: "mssp",
      externalId: null,
      billingMode: "subscription",
      expiration: null,
      unlimitedExpiration: true,
      inherits: true,
      licenses: DEFAULT_ACCOUNT_LICENSES,
      policy: null,
      state: "active",
      creator: SYSTEM_USER.fullName,
      creatorId: SYSTEM_USER.id,
    });
  }

  for (const entry of config.users ?? []) {
    if ((entry.id && ss.users.findOneBy("s1_id", entry.id)) || ss.users.findOneBy("email", entry.email.toLowerCase()))
      continue;
    const scope =
      entry.scope ??
      (entry.scopeRoles?.some((role) => role.site)
        ? "site"
        : entry.scopeRoles?.some((role) => role.account)
          ? "account"
          : "tenant");
    const scopeRoles = (entry.scopeRoles ?? []).flatMap((scopeRole) => {
      const role = roleByRef(scopeRole.roleId ?? scopeRole.role);
      const target =
        scopeRole.id ??
        (scopeRole.account
          ? ss.accounts
              .all()
              .find(
                (account) =>
                  account.name.toLowerCase() === scopeRole.account!.toLowerCase() ||
                  account.s1_id === scopeRole.account,
              )?.s1_id
          : undefined) ??
        (scopeRole.site
          ? ss.sites
              .all()
              .find(
                (site) => site.name.toLowerCase() === scopeRole.site!.toLowerCase() || site.s1_id === scopeRole.site,
              )?.s1_id
          : undefined);
      return role && target ? [{ id: target, roleId: role.s1_id }] : [];
    });
    createUser(ss, {
      id: entry.id,
      email: entry.email,
      fullName: entry.fullName,
      scope,
      scopeRoles:
        scope === "tenant"
          ? scopeRoles
          : scopeRoles.length > 0
            ? scopeRoles
            : [{ id: ss.accounts.all()[0].s1_id, roleId: ss.roles.all()[0].s1_id }],
      twoFaEnabled: entry.twoFaEnabled,
      emailVerified: entry.emailVerified,
      canGenerateApiToken: entry.canGenerateApiToken,
      source: entry.source,
    });
  }

  for (const entry of config.api_tokens ?? []) {
    if (!entry.token || ss.apiTokens.findOneBy("token", entry.token)) continue;
    const user = entry.user
      ? (ss.users.findOneBy("email", entry.user.toLowerCase()) ?? ss.users.findOneBy("s1_id", entry.user))
      : undefined;
    ss.apiTokens.insert({
      token: entry.token,
      user_id: user?.s1_id ?? null,
      description: entry.description ?? "API token",
      expires_at: entry.expires_at ?? null,
    });
    if (user)
      ss.users.update(user.id, {
        apiTokenCreatedAt: new Date().toISOString(),
        apiTokenExpiresAt: entry.expires_at ?? null,
        canGenerateApiToken: true,
      });
  }
  if (ss.apiTokens.count() === 0)
    ss.apiTokens.insert({
      token: DEFAULT_API_TOKEN,
      user_id: null,
      description: "Service API token",
      expires_at: null,
    });

  logEvent(ss, "seed.applied", "config", {
    accounts: ss.accounts.count(),
    sites: ss.sites.count(),
    agents: ss.agents.count(),
    users: ss.users.count(),
  });
}

export const sentinelonePlugin: ServicePlugin = {
  name: "sentinelone",
  register(app: Hono<AppEnv>, store: Store, _webhooks: WebhookDispatcher, baseUrl: string, _tokenMap?: TokenMap): void {
    const ss = getS1Store(store);
    const fmt: Fmt = { ss, baseUrl };
    const rc: S1RouteContext = { app, ss, fmt, baseUrl };
    accountRoutes(rc);
    siteRoutes(rc);
    groupRoutes(rc);
    agentRoutes(rc);
    userRoutes(rc);
    threatRoutes(rc);
    riskRoutes(rc);
    protectionRoutes(rc);
    miscRoutes(rc);
    inspectorRoutes(rc);
  },
  seed(store: Store, baseUrl: string): void {
    seedFromConfig(store, baseUrl, DEFAULT_SEED);
  },
};

export default sentinelonePlugin;
export type { S1Store as SentinelOneStore };
