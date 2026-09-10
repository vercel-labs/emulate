import type { MachineType, OsType, S1Agent } from "../entities.js";
import { formatAgent, formatPassphrase } from "../formatters.js";
import {
  api,
  bool,
  dataOf,
  filterOf,
  guid,
  list,
  matchesList,
  num,
  oneOf,
  paginate,
  parseJsonBody,
  queryParams,
  route,
  str,
  strOrNull,
  token,
  validation,
  type Body,
  type QueryParams,
} from "../helpers.js";
import { logActivity, logEvent, nextId, type S1Store } from "../store.js";
import {
  agentInScope,
  assignAgentToGroup,
  defaultGroupOf,
  findAgent,
  findGroup,
  findSite,
  scopeFromBody,
  scopeFromParams,
  type S1RouteContext,
  type ScopeSelection,
} from "../route-utils.js";

const OS_TYPES = ["windows", "linux", "macos", "windows_legacy"] as const;
const MACHINE_TYPES = ["server", "laptop", "desktop", "kubernetes node", "unknown"] as const;
const MIGRATION_STATUSES = ["Migrated", "Pending", "N/A", "Failed"] as const;

const OS_NAMES: Record<string, { name: string; revision: string; arch: string }> = {
  windows: { name: "Windows 11 Pro", revision: "22631", arch: "64 bit" },
  linux: { name: "Linux", revision: "Ubuntu 22.04.4 LTS 5.15.0-105-generic", arch: "64 bit" },
  macos: { name: "macOS", revision: "14.4.1", arch: "arm64" },
  windows_legacy: { name: "Windows 7 Professional", revision: "7601", arch: "64 bit" },
};

export interface RegisterAgentInput {
  siteId: string;
  computerName: string;
  osType?: OsType;
  osName?: string;
  osRevision?: string;
  osArch?: string;
  machineType?: MachineType;
  agentVersion?: string;
  domain?: string;
  lastLoggedInUserName?: string;
  externalIp?: string;
  lastIpToMgmt?: string;
  groupId?: string | null;
  isActive?: boolean;
  lastActiveDate?: string;
  registeredAt?: string;
  consoleMigrationStatus?: S1Agent["consoleMigrationStatus"];
  externalId?: string | null;
  tags?: string[];
  uuid?: string;
  id?: string;
  serialNumber?: string;
  cpuCount?: number;
  totalMemory?: number;
  activeThreats?: number;
}

export function registerAgent(ss: S1Store, input: RegisterAgentInput): S1Agent {
  const site = findSite(ss, input.siteId);
  if (site.state !== "active") throw validation(`Site ${site.name} is not active`);
  if (
    !site.unlimitedLicenses &&
    ss.agents.findBy("site_id", site.s1_id).filter((agent) => !agent.isDecommissioned).length >= site.totalLicenses
  )
    throw validation(`Site ${site.name} has no license left for a new agent`);
  const computerName = input.computerName.trim();
  if (!computerName) throw validation("computerName is required");
  const osType = input.osType ?? "windows";
  const defaults = OS_NAMES[osType];
  const now = new Date().toISOString();
  const lastIp = input.lastIpToMgmt ?? `10.${(ss.agents.count() % 250) + 1}.0.${(ss.agents.count() % 200) + 10}`;
  const agent = ss.agents.insert({
    s1_id: input.id ?? nextId(ss),
    uuid: input.uuid ?? guid(),
    site_id: site.s1_id,
    group_id: input.groupId ?? defaultGroupOf(ss, site.s1_id).s1_id,
    computerName,
    domain: input.domain ?? "WORKGROUP",
    osType,
    osName: input.osName ?? defaults.name,
    osRevision: input.osRevision ?? defaults.revision,
    osArch: input.osArch ?? defaults.arch,
    machineType: input.machineType ?? (osType === "linux" ? "server" : "laptop"),
    agentVersion: input.agentVersion ?? "24.1.3.271",
    lastActiveDate: input.lastActiveDate ?? now,
    registeredAt: input.registeredAt ?? now,
    isActive: input.isActive ?? true,
    isDecommissioned: false,
    decommissionedAt: null,
    isUninstalled: false,
    isPendingUninstall: false,
    isUpToDate: true,
    infected: (input.activeThreats ?? 0) > 0,
    activeThreats: input.activeThreats ?? 0,
    externalIp: input.externalIp ?? "203.0.113.42",
    lastIpToMgmt: lastIp,
    lastLoggedInUserName: input.lastLoggedInUserName ?? "user",
    networkStatus: input.isActive === false ? "disconnected" : "connected",
    scanStatus: "finished",
    scanStartedAt: input.registeredAt ?? now,
    scanFinishedAt: input.registeredAt ?? now,
    mitigationMode: "protect",
    mitigationModeSuspicious: "detect",
    consoleMigrationStatus: input.consoleMigrationStatus ?? "N/A",
    migrationStatus: input.consoleMigrationStatus ?? "N/A",
    cpuCount: input.cpuCount ?? 4,
    coreCount: input.cpuCount ?? 4,
    totalMemory: input.totalMemory ?? 16384,
    serialNumber: input.serialNumber ?? `EMU-${token(8).toUpperCase()}`,
    modelName:
      osType === "macos" ? "MacBook Pro" : input.machineType === "server" ? "Virtual Machine" : "Latitude 5540",
    encryptedApplications: osType !== "linux",
    firewallEnabled: true,
    networkQuarantineEnabled: false,
    operationalState: "na",
    passphrase: Array.from({ length: 6 }, () => WORDS[Math.floor(Math.random() * WORDS.length)]).join(" "),
    appsVulnerabilityStatus: "not_applicable",
    externalId: input.externalId ?? null,
    tags: input.tags ?? [],
  });
  const assigned = input.groupId ? agent : assignAgentToGroup(ss, agent);
  logActivity(ss, {
    activityType: 3001,
    primaryDescription: `Agent ${assigned.computerName} was registered in site ${site.name}`,
    accountId: site.account_id,
    siteId: site.s1_id,
    groupId: assigned.group_id,
    agentId: assigned.s1_id,
  });
  logEvent(ss, "agent.registered", assigned.s1_id, {
    computerName: assigned.computerName,
    siteId: site.s1_id,
    osType: assigned.osType,
    machineType: assigned.machineType,
  });
  return assigned;
}

const WORDS = [
  "amber",
  "brook",
  "cedar",
  "delta",
  "ember",
  "frost",
  "grove",
  "harbor",
  "iris",
  "juniper",
  "kestrel",
  "lumen",
  "meadow",
  "nectar",
  "orbit",
  "pebble",
  "quartz",
  "ridge",
  "summit",
  "timber",
];

function applyAgentFilters(ss: S1Store, params: QueryParams, rows: S1Agent[]): S1Agent[] {
  const scope = scopeFromParams(params);
  const ids = params.list("ids");
  const uuids = params.list("uuids") ?? params.list("uuid");
  const migration =
    params.list("consoleMigrationStatuses") ??
    (params.get("migrationStatus") ? [params.get("migrationStatus")!] : undefined);
  const computerNames = params.list("computerName") ?? params.list("computerName__contains");
  const query = params.list("query");
  const infected = params.bool("infected");
  const isActive = params.bool("isActive");
  const isDecommissioned = params.bool("isDecommissioned");
  const isUpToDate = params.bool("isUpToDate");
  const osTypes = params.list("osTypes");
  const machineTypes = params.list("machineTypes");
  const networkStatuses = params.list("networkStatuses");
  const scanStatuses =
    params.list("scanStatuses") ?? (params.get("scanStatus") ? [params.get("scanStatus")!] : undefined);
  const activeThreats = params.num("activeThreats");
  const activeThreatsGt = params.num("activeThreats__gt");
  const lastActiveGt = params.get("lastActiveDate__gt") ?? params.get("lastActiveDate__gte");
  const lastActiveLt = params.get("lastActiveDate__lt") ?? params.get("lastActiveDate__lte");
  const versionGte = params.get("agentVersion__gte");
  const externalIds = params.list("externalId") ?? params.list("externalIds");
  return rows
    .filter((agent) => agentInScope(ss, agent, scope))
    .filter((agent) => matchesList(agent.s1_id, ids))
    .filter((agent) => matchesList(agent.uuid, uuids))
    .filter((agent) => matchesList(agent.consoleMigrationStatus, migration))
    .filter((agent) =>
      computerNames
        ? computerNames.some((name) => agent.computerName.toLowerCase().includes(name.toLowerCase()))
        : true,
    )
    .filter((agent) =>
      query
        ? query.some((fragment) =>
            `${agent.computerName} ${agent.lastLoggedInUserName} ${agent.osName} ${agent.externalIp} ${agent.lastIpToMgmt} ${agent.uuid}`
              .toLowerCase()
              .includes(fragment.toLowerCase()),
          )
        : true,
    )
    .filter((agent) => (infected === undefined ? true : agent.infected === infected))
    .filter((agent) => (isActive === undefined ? true : agent.isActive === isActive))
    .filter((agent) =>
      isDecommissioned === undefined ? !agent.isDecommissioned : agent.isDecommissioned === isDecommissioned,
    )
    .filter((agent) => (isUpToDate === undefined ? true : agent.isUpToDate === isUpToDate))
    .filter((agent) => matchesList(agent.osType, osTypes))
    .filter((agent) => matchesList(agent.machineType, machineTypes))
    .filter((agent) => matchesList(agent.networkStatus, networkStatuses))
    .filter((agent) => matchesList(agent.scanStatus, scanStatuses))
    .filter((agent) => (activeThreats === undefined ? true : agent.activeThreats === activeThreats))
    .filter((agent) => (activeThreatsGt === undefined ? true : agent.activeThreats > activeThreatsGt))
    .filter((agent) => (lastActiveGt ? agent.lastActiveDate >= lastActiveGt : true))
    .filter((agent) => (lastActiveLt ? agent.lastActiveDate <= lastActiveLt : true))
    .filter((agent) => (versionGte ? compareVersions(agent.agentVersion, versionGte) >= 0 : true))
    .filter((agent) => matchesList(agent.externalId, externalIds));
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function selectAgents(ss: S1Store, body: Body): S1Agent[] {
  const filter = filterOf(body);
  const scope: ScopeSelection = scopeFromBody(filter);
  const ids = list(filter.ids);
  const uuids = list(filter.uuids);
  const migration =
    list(filter.consoleMigrationStatuses) ??
    (str(filter.migrationStatus) ? [String(filter.migrationStatus)] : undefined);
  const hasSelection =
    (ids && ids.length > 0) ||
    (uuids && uuids.length > 0) ||
    (scope.siteIds && scope.siteIds.length > 0) ||
    (scope.groupIds && scope.groupIds.length > 0) ||
    (scope.accountIds && scope.accountIds.length > 0) ||
    filter.tenant === true ||
    str(filter.query) !== undefined;
  if (!hasSelection)
    throw validation("filter must select agents with ids, uuids, siteIds, groupIds, accountIds, or tenant");
  const query = str(filter.query)?.toLowerCase();
  return ss.agents
    .all()
    .filter((agent) => agentInScope(ss, agent, scope))
    .filter((agent) => matchesList(agent.s1_id, ids))
    .filter((agent) => matchesList(agent.uuid, uuids))
    .filter((agent) => matchesList(agent.consoleMigrationStatus, migration))
    .filter((agent) => (query ? agent.computerName.toLowerCase().includes(query) : true))
    .filter((agent) =>
      bool(filter.isDecommissioned) === undefined
        ? !agent.isDecommissioned
        : agent.isDecommissioned === bool(filter.isDecommissioned),
    );
}

const AGENT_SORTABLE = [
  "id",
  "computerName",
  "createdAt",
  "updatedAt",
  "lastActiveDate",
  "registeredAt",
  "agentVersion",
  "osType",
  "osName",
  "machineType",
  "siteId",
  "siteName",
  "accountName",
  "groupId",
  "groupName",
  "activeThreats",
  "infected",
  "isActive",
  "isDecommissioned",
  "isUpToDate",
  "networkStatus",
  "scanStatus",
  "externalIp",
  "domain",
  "lastLoggedInUserName",
  "consoleMigrationStatus",
  "uuid",
  "mitigationMode",
  "totalMemory",
  "cpuCount",
  "coreCount",
  "serialNumber",
];

export function agentRoutes(rc: S1RouteContext): void {
  const { app, ss, fmt } = rc;

  route(
    app,
    "get",
    "/agents",
    api(ss, (c) => {
      const rows = applyAgentFilters(ss, queryParams(c), ss.agents.all())
        .sort((a, b) => a.id - b.id)
        .map((agent) => formatAgent(fmt, agent));
      return c.json(paginate(c, rows, { sortable: AGENT_SORTABLE }));
    }),
  );

  route(
    app,
    "get",
    "/agents/count",
    api(ss, (c) => c.json({ data: { total: applyAgentFilters(ss, queryParams(c), ss.agents.all()).length } })),
  );

  route(
    app,
    "get",
    "/agents/passphrases",
    api(ss, (c) => {
      const rows = applyAgentFilters(ss, queryParams(c), ss.agents.all())
        .sort((a, b) => a.id - b.id)
        .map(formatPassphrase);
      return c.json(paginate(c, rows, { sortable: ["id", "computerName"] }));
    }),
  );

  route(
    app,
    "get",
    "/agents/applications",
    api(ss, (c) => {
      const params = queryParams(c);
      const ids = params.list("ids");
      if (!ids || ids.length === 0) throw validation("ids is required");
      const rows = ids.flatMap((id) => {
        const agent = findAgent(ss, id);
        return ss.applications.findBy("agent_id", agent.s1_id).map((application) => ({
          name: application.name,
          publisher: application.vendor,
          version: application.version,
          size: 0,
          installedDate: application.detectionDate,
          riskLevel: application.highestSeverity.toLowerCase(),
          type: application.applicationType,
          agentId: agent.s1_id,
          agentComputerName: agent.computerName,
        }));
      });
      return c.json({ data: rows });
    }),
  );

  route(
    app,
    "get",
    "/agents/:id",
    api(ss, (c) => c.json({ data: formatAgent(fmt, findAgent(ss, c.req.param("id"))) })),
  );

  const action = (path: string, apply: (agent: S1Agent, data: Body) => Partial<S1Agent> | null, activity: string) => {
    route(
      app,
      "post",
      `/agents/actions/${path}`,
      api(ss, async (c) => {
        const body = await parseJsonBody(c);
        const agents = selectAgents(ss, body);
        const data = dataOf(body);
        let affected = 0;
        for (const agent of agents) {
          const updates = apply(agent, data);
          if (!updates) continue;
          ss.agents.update(agent.id, updates);
          affected += 1;
          logActivity(ss, {
            activityType: 3100,
            primaryDescription: `${activity} on ${agent.computerName}`,
            siteId: agent.site_id,
            groupId: agent.group_id,
            agentId: agent.s1_id,
          });
        }
        logEvent(ss, `agent.${path}`, String(affected), { affected, ids: agents.map((agent) => agent.s1_id) });
        return c.json({ data: { affected } });
      }),
    );
  };

  action(
    "decommission",
    (agent) =>
      agent.isDecommissioned
        ? null
        : {
            isDecommissioned: true,
            isActive: false,
            networkStatus: "disconnected",
            decommissionedAt: new Date().toISOString(),
          },
    "Decommission requested",
  );
  action(
    "recommission",
    (agent) =>
      agent.isDecommissioned
        ? {
            isDecommissioned: false,
            isActive: true,
            networkStatus: "connected",
            decommissionedAt: null,
            lastActiveDate: new Date().toISOString(),
          }
        : null,
    "Recommission requested",
  );
  action(
    "initiate-scan",
    () => ({ scanStatus: "started", scanStartedAt: new Date().toISOString(), scanFinishedAt: null }),
    "Full disk scan initiated",
  );
  action(
    "abort-scan",
    (agent) => (agent.scanStatus === "started" ? { scanStatus: "aborted" } : null),
    "Full disk scan aborted",
  );
  action(
    "disconnect",
    (agent) =>
      agent.networkStatus === "disconnected" ? null : { networkStatus: "disconnected", networkQuarantineEnabled: true },
    "Disconnected from network",
  );
  action(
    "connect",
    (agent) =>
      agent.networkStatus === "connected" ? null : { networkStatus: "connected", networkQuarantineEnabled: false },
    "Reconnected to network",
  );
  action("fetch-logs", () => ({}), "Logs fetch requested");
  action("restart-machine", () => ({ lastActiveDate: new Date().toISOString() }), "Restart requested");
  action("shutdown", () => ({ isActive: false, networkStatus: "disconnected" }), "Shutdown requested");
  action(
    "uninstall",
    (agent) => (agent.isPendingUninstall ? null : { isPendingUninstall: true }),
    "Uninstall requested",
  );
  action(
    "approve-uninstall",
    (agent) =>
      agent.isPendingUninstall
        ? {
            isPendingUninstall: false,
            isUninstalled: true,
            isActive: false,
            isDecommissioned: true,
            decommissionedAt: new Date().toISOString(),
          }
        : null,
    "Uninstall approved",
  );
  action(
    "reject-uninstall",
    (agent) => (agent.isPendingUninstall ? { isPendingUninstall: false } : null),
    "Uninstall rejected",
  );
  action(
    "update-software",
    (_agent, data) => ({ agentVersion: str(data.agentVersion) ?? "24.2.2.118", isUpToDate: true }),
    "Agent update requested",
  );
  action("set-external-id", (_agent, data) => ({ externalId: strOrNull(data.externalId) }), "External id updated");
  action(
    "enable-agent",
    (agent) => (agent.operationalState === "na" ? null : { operationalState: "na" }),
    "Agent enabled",
  );
  action(
    "disable-agent",
    (agent) => (agent.operationalState === "na" ? { operationalState: "disabled_by_user" } : null),
    "Agent disabled",
  );

  route(
    app,
    "post",
    "/agents/actions/move-to-site",
    api(ss, async (c) => {
      const body = await parseJsonBody(c);
      const data = dataOf(body);
      const targetSiteId = str(data.targetSiteId);
      if (!targetSiteId) throw validation("data.targetSiteId is required");
      const site = findSite(ss, targetSiteId);
      const agents = selectAgents(ss, body);
      for (const agent of agents) {
        const moved = ss.agents.update(agent.id, {
          site_id: site.s1_id,
          group_id: defaultGroupOf(ss, site.s1_id).s1_id,
        })!;
        assignAgentToGroup(ss, moved);
      }
      logEvent(ss, "agent.move-to-site", site.s1_id, { affected: agents.length });
      return c.json({ data: { affected: agents.length } });
    }),
  );

  route(
    app,
    "post",
    "/agents/actions/move-to-group",
    api(ss, async (c) => {
      const body = await parseJsonBody(c);
      const data = dataOf(body);
      const targetGroupId = str(data.targetGroupId) ?? str(data.groupId);
      if (!targetGroupId) throw validation("data.targetGroupId is required");
      const group = findGroup(ss, targetGroupId);
      const agents = selectAgents(ss, body).filter((agent) => agent.site_id === group.site_id);
      for (const agent of agents) ss.agents.update(agent.id, { group_id: group.s1_id });
      return c.json({ data: { affected: agents.length } });
    }),
  );

  route(
    app,
    "put",
    "/agents/:id",
    api(ss, async (c) => {
      const agent = findAgent(ss, c.req.param("id"));
      const data = dataOf(await parseJsonBody(c));
      const updated = ss.agents.update(agent.id, {
        externalId: data.externalId !== undefined ? strOrNull(data.externalId) : agent.externalId,
        tags: Array.isArray(data.tags) ? data.tags.map(String) : agent.tags,
        lastLoggedInUserName: str(data.lastLoggedInUserName) ?? agent.lastLoggedInUserName,
        machineType:
          data.machineType !== undefined
            ? (oneOf(data.machineType, MACHINE_TYPES, "machineType") ?? agent.machineType)
            : agent.machineType,
        consoleMigrationStatus:
          data.consoleMigrationStatus !== undefined
            ? (oneOf(data.consoleMigrationStatus, MIGRATION_STATUSES, "consoleMigrationStatus") ??
              agent.consoleMigrationStatus)
            : agent.consoleMigrationStatus,
      })!;
      return c.json({ data: formatAgent(fmt, updated) });
    }),
  );

  app.post("/_sentinelone/simulate/agent", async (c) => {
    const body = await parseJsonBody(c);
    const registrationToken = str(body.registrationToken);
    const siteByToken = registrationToken ? ss.sites.findOneBy("registrationToken", registrationToken) : undefined;
    const groupByToken =
      registrationToken && !siteByToken ? ss.groups.findOneBy("registrationToken", registrationToken) : undefined;
    const siteId =
      str(body.siteId) ??
      siteByToken?.s1_id ??
      groupByToken?.site_id ??
      ss.sites
        .all()
        .find((site) => site.state === "active" && site.name.toLowerCase() === (str(body.siteName) ?? "").toLowerCase())
        ?.s1_id;
    if (!siteId)
      return c.json(
        {
          errors: [
            {
              code: 4000010,
              detail: "siteId, siteName, or a registrationToken is required",
              title: "Validation Error",
            },
          ],
        },
        400,
      );
    try {
      const agent = registerAgent(ss, {
        siteId,
        computerName: str(body.computerName) ?? `EMU-${token(6).toUpperCase()}`,
        osType: oneOf(body.osType, OS_TYPES, "osType"),
        osName: str(body.osName),
        osRevision: str(body.osRevision),
        machineType: oneOf(body.machineType, MACHINE_TYPES, "machineType"),
        agentVersion: str(body.agentVersion),
        domain: str(body.domain),
        lastLoggedInUserName: str(body.lastLoggedInUserName),
        externalIp: str(body.externalIp),
        lastIpToMgmt: str(body.lastIpToMgmt),
        groupId: groupByToken?.s1_id ?? strOrNull(body.groupId) ?? undefined,
        isActive: bool(body.isActive),
        lastActiveDate: str(body.lastActiveDate),
        consoleMigrationStatus: oneOf(body.consoleMigrationStatus, MIGRATION_STATUSES, "consoleMigrationStatus"),
        externalId: strOrNull(body.externalId),
        tags: list(body.tags),
        activeThreats: num(body.activeThreats),
      });
      return c.json({ data: formatAgent(fmt, agent) }, 201);
    } catch (error) {
      if (error instanceof Error && "errors" in error)
        return c.json(
          { errors: (error as { errors: unknown }).errors },
          ((error as { status?: number }).status ?? 400) as 400 | 404,
        );
      throw error;
    }
  });

  app.post("/_sentinelone/simulate/agent-checkin", async (c) => {
    const body = await parseJsonBody(c);
    const id = str(body.agentId) ?? str(body.id) ?? str(body.uuid) ?? str(body.computerName);
    if (!id)
      return c.json({ errors: [{ code: 4000010, detail: "agentId is required", title: "Validation Error" }] }, 400);
    const agent =
      ss.agents.findOneBy("s1_id", id) ??
      ss.agents.findOneBy("uuid", id) ??
      ss.agents.all().find((candidate) => candidate.computerName.toLowerCase() === id.toLowerCase());
    if (!agent)
      return c.json(
        { errors: [{ code: 4040010, detail: `Agent ${id} was not found`, title: "Resource not found" }] },
        404,
      );
    const updated = ss.agents.update(agent.id, {
      lastActiveDate: str(body.lastActiveDate) ?? new Date().toISOString(),
      isActive: bool(body.isActive) ?? true,
      networkStatus: bool(body.isActive) === false ? "disconnected" : "connected",
      agentVersion: str(body.agentVersion) ?? agent.agentVersion,
      isUpToDate: bool(body.isUpToDate) ?? agent.isUpToDate,
      osRevision: str(body.osRevision) ?? agent.osRevision,
      osName: str(body.osName) ?? agent.osName,
      lastLoggedInUserName: str(body.lastLoggedInUserName) ?? agent.lastLoggedInUserName,
      scanStatus: agent.scanStatus === "started" ? "finished" : agent.scanStatus,
      scanFinishedAt: agent.scanStatus === "started" ? new Date().toISOString() : agent.scanFinishedAt,
    })!;
    logEvent(ss, "agent.checkin", updated.s1_id, {
      computerName: updated.computerName,
      lastActiveDate: updated.lastActiveDate,
    });
    return c.json({ data: formatAgent(fmt, updated) });
  });
}
