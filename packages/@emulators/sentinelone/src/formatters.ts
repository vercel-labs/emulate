import type {
  S1Account,
  S1Activity,
  S1Agent,
  S1Application,
  S1Cve,
  S1DeviceRule,
  S1Exclusion,
  S1Filter,
  S1Group,
  S1Restriction,
  S1Role,
  S1Site,
  S1Threat,
  S1User,
} from "./entities.js";
import type { Json } from "./helpers.js";
import { tenant, type S1Store } from "./store.js";

export interface Fmt {
  ss: S1Store;
  baseUrl: string;
}

export function accountName(ss: S1Store, accountId: string | null): string | null {
  return accountId ? (ss.accounts.findOneBy("s1_id", accountId)?.name ?? null) : null;
}

export function siteName(ss: S1Store, siteId: string | null): string | null {
  return siteId ? (ss.sites.findOneBy("s1_id", siteId)?.name ?? null) : null;
}

export function groupName(ss: S1Store, groupId: string | null): string | null {
  return groupId ? (ss.groups.findOneBy("s1_id", groupId)?.name ?? null) : null;
}

export function siteActiveLicenses(ss: S1Store, siteId: string): number {
  return ss.agents.findBy("site_id", siteId).filter((agent) => !agent.isDecommissioned && !agent.isUninstalled).length;
}

export function accountActiveLicenses(ss: S1Store, accountId: string): number {
  return ss.sites.findBy("account_id", accountId).reduce((sum, site) => sum + siteActiveLicenses(ss, site.s1_id), 0);
}

export function formatLicenses(licenses: S1Account["licenses"]): Json {
  return {
    bundles: licenses.bundles.map((bundle) => ({
      name: bundle.name,
      displayName: bundle.name.charAt(0).toUpperCase() + bundle.name.slice(1),
      surfaces: bundle.surfaces.map((surface) => ({ name: surface.name, count: surface.count })),
    })),
    modules: licenses.modules.map((module) => ({
      name: module.name,
      displayName: module.name.charAt(0).toUpperCase() + module.name.slice(1),
    })),
    settings: licenses.settings.map((setting) => ({
      groupName: setting.groupName,
      setting: setting.setting,
      displayName: setting.displayName ?? setting.groupName.replace(/_/g, " "),
      settingGroup: setting.settingGroup ?? setting.groupName,
      settingGroupDisplayName: setting.settingGroupDisplayName ?? setting.groupName.replace(/_/g, " "),
    })),
  };
}

export function formatAccount(f: Fmt, a: S1Account): Json {
  const sites = f.ss.sites.findBy("account_id", a.s1_id).filter((site) => site.state === "active");
  return {
    id: a.s1_id,
    name: a.name,
    accountType: a.accountType,
    usageType: a.usageType,
    externalId: a.externalId,
    billingMode: a.billingMode,
    expiration: a.expiration,
    unlimitedExpiration: a.unlimitedExpiration,
    inherits: a.inherits,
    licenses: formatLicenses(a.licenses),
    state: a.state,
    activeAgents: accountActiveLicenses(f.ss, a.s1_id),
    numberOfSites: sites.length,
    totalLicenses: sites.reduce((sum, site) => sum + (site.unlimitedLicenses ? 0 : site.totalLicenses), 0),
    creator: a.creator,
    creatorId: a.creatorId,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
    skus: [...new Set(sites.map((site) => site.sku))].map((sku) => ({ name: sku })),
  };
}

export function formatSite(f: Fmt, s: S1Site): Json {
  return {
    id: s.s1_id,
    accountId: s.account_id,
    accountName: accountName(f.ss, s.account_id),
    name: s.name,
    siteType: s.siteType,
    description: s.description,
    externalId: s.externalId,
    healthStatus: s.healthStatus,
    unlimitedExpiration: s.unlimitedExpiration,
    unlimitedLicenses: s.unlimitedLicenses,
    totalLicenses: s.unlimitedLicenses ? 0 : s.totalLicenses,
    activeLicenses: siteActiveLicenses(f.ss, s.s1_id),
    isDefault: s.isDefault,
    inherits: s.inherits,
    expiration: s.expiration,
    licenses: formatLicenses(s.licenses),
    settings: formatLicenses(s.licenses).settings,
    registrationToken: s.registrationToken,
    state: s.state,
    sku: s.sku,
    suite: s.suite,
    irFields: null,
    creator: s.creator,
    creatorId: s.creatorId,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}

export function formatGroup(f: Fmt, g: S1Group): Json {
  return {
    id: g.s1_id,
    siteId: g.site_id,
    name: g.name,
    description: g.description,
    type: g.type,
    rank: g.rank,
    isDefault: g.isDefault,
    inherits: g.inherits,
    filterId: g.filter_id,
    filterName: g.filter_id ? (f.ss.filters.findOneBy("s1_id", g.filter_id)?.name ?? null) : null,
    registrationToken: g.registrationToken,
    totalAgents: f.ss.agents.findBy("group_id", g.s1_id).filter((agent) => !agent.isDecommissioned).length,
    creator: g.creator,
    creatorId: g.creatorId,
    createdAt: g.created_at,
    updatedAt: g.updated_at,
  };
}

export function formatFilter(filter: S1Filter): Json {
  return {
    id: filter.s1_id,
    name: filter.name,
    filterFields: filter.filterFields,
    scopeLevel: filter.scope_level,
    scopeId: filter.scope_id,
    createdAt: filter.created_at,
    updatedAt: filter.updated_at,
  };
}

export function formatAgent(f: Fmt, a: S1Agent): Json {
  const site = f.ss.sites.findOneBy("s1_id", a.site_id);
  return {
    id: a.s1_id,
    uuid: a.uuid,
    computerName: a.computerName,
    domain: a.domain,
    accountId: site?.account_id ?? null,
    accountName: site ? accountName(f.ss, site.account_id) : null,
    siteId: a.site_id,
    siteName: site?.name ?? null,
    groupId: a.group_id,
    groupName: groupName(f.ss, a.group_id),
    groupIp: a.externalIp.split(".").slice(0, 3).join(".") + ".x",
    osType: a.osType,
    osName: a.osName,
    osRevision: a.osRevision,
    osArch: a.osArch,
    osStartTime: a.registeredAt,
    osUsername: a.lastLoggedInUserName,
    machineType: a.machineType,
    agentVersion: a.agentVersion,
    lastActiveDate: a.lastActiveDate,
    registeredAt: a.registeredAt,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
    isActive: a.isActive,
    isDecommissioned: a.isDecommissioned,
    decommissionedAt: a.decommissionedAt,
    isUninstalled: a.isUninstalled,
    isPendingUninstall: a.isPendingUninstall,
    isUpToDate: a.isUpToDate,
    infected: a.infected,
    activeThreats: a.activeThreats,
    externalIp: a.externalIp,
    externalId: a.externalId,
    lastIpToMgmt: a.lastIpToMgmt,
    lastLoggedInUserName: a.lastLoggedInUserName,
    networkStatus: a.networkStatus,
    scanStatus: a.scanStatus,
    scanStartedAt: a.scanStartedAt,
    scanFinishedAt: a.scanFinishedAt,
    scanAbortedAt: null,
    mitigationMode: a.mitigationMode,
    mitigationModeSuspicious: a.mitigationModeSuspicious,
    consoleMigrationStatus: a.consoleMigrationStatus,
    migrationStatus: a.migrationStatus,
    cpuCount: a.cpuCount,
    coreCount: a.coreCount,
    totalMemory: a.totalMemory,
    cpuId: "Emulated CPU",
    serialNumber: a.serialNumber,
    modelName: a.modelName,
    encryptedApplications: a.encryptedApplications,
    firewallEnabled: a.firewallEnabled,
    networkQuarantineEnabled: a.networkQuarantineEnabled,
    operationalState: a.operationalState,
    operationalStateExpiration: null,
    appsVulnerabilityStatus: a.appsVulnerabilityStatus,
    threatRebootRequired: false,
    userActionsNeeded: [],
    missingPermissions: [],
    tags: { sentinelone: a.tags.map((tag) => ({ key: "tag", value: tag })) },
    networkInterfaces: [
      {
        id: `${a.s1_id}-nic`,
        name: "Ethernet",
        inet: [a.lastIpToMgmt],
        inet6: [],
        physical: "00-15-5D-01-02-03",
        gatewayIp: a.lastIpToMgmt.split(".").slice(0, 3).join(".") + ".1",
        gatewayMacAddress: "00-15-5D-00-00-01",
      },
    ],
    activeDirectory: {
      computerDistinguishedName: a.domain
        ? `CN=${a.computerName},OU=Computers,DC=${a.domain.replace(/\./g, ",DC=")}`
        : null,
      computerMemberOf: [],
      lastUserDistinguishedName: null,
      lastUserMemberOf: [],
      mail: null,
      userPrincipalName: null,
    },
    locationType: "not_supported",
    locations: [],
    rangerStatus: "NotApplicable",
    rangerVersion: null,
    remoteProfilingState: "disabled",
    remoteProfilingStateExpiration: null,
    detectionState: null,
    installerType: a.osType === "windows" ? ".exe" : a.osType === "macos" ? ".pkg" : ".deb",
    licenseKey: "",
    policyUpdatedAt: a.updated_at,
    fullDiskScanLastUpdatedAt: a.scanFinishedAt,
    lastSuccessfulScanDate: a.scanFinishedAt,
    inRemoteShellSession: false,
    isAdConnector: false,
    allowRemoteShell: true,
    storageType: null,
    storageName: null,
    cloudProviders: {},
    containerizedWorkloadCounts: null,
    proxyStates: null,
    showAlertIcon: a.activeThreats > 0,
  };
}

export function formatPassphrase(a: S1Agent): Json {
  return {
    id: a.s1_id,
    uuid: a.uuid,
    computerName: a.computerName,
    domain: a.domain,
    lastLoggedInUserName: a.lastLoggedInUserName,
    passphrase: a.passphrase,
  };
}

export function formatUser(f: Fmt, u: S1User): Json {
  const roleName = (roleId: string) => f.ss.roles.findOneBy("s1_id", roleId)?.name ?? null;
  const scopeRoles = u.scopeRoles.map((scopeRole) => {
    const account = f.ss.accounts.findOneBy("s1_id", scopeRole.id);
    const site = account ? undefined : f.ss.sites.findOneBy("s1_id", scopeRole.id);
    return {
      id: scopeRole.id,
      roleId: scopeRole.roleId,
      roleName: roleName(scopeRole.roleId),
      name: account?.name ?? site?.name ?? null,
      accountName: account?.name ?? (site ? accountName(f.ss, site.account_id) : null),
      roles: [roleName(scopeRole.roleId)].filter(Boolean),
    };
  });
  const lowest =
    scopeRoles
      .map((entry) => entry.roleName)
      .filter(Boolean)
      .sort()[0] ?? null;
  return {
    id: u.s1_id,
    email: u.email,
    fullName: u.fullName,
    scope: u.scope,
    scopeRoles,
    tenantRoles: [],
    siteRoles: scopeRoles
      .filter((entry) => f.ss.sites.findOneBy("s1_id", entry.id))
      .map((entry) => ({ id: entry.id, roleId: entry.roleId, roleName: entry.roleName, siteName: entry.name })),
    source: u.source,
    lowestRole: lowest,
    emailVerified: u.emailVerified,
    emailReadOnly: u.source !== "mgmt",
    fullNameReadOnly: u.source !== "mgmt",
    groupsReadOnly: u.source === "scim",
    twoFaEnabled: u.twoFaEnabled,
    twoFaEnabledReadOnly: false,
    twoFaConfigured: u.twoFaConfigured,
    twoFaStatus: u.twoFaConfigured ? "configured" : u.twoFaEnabled ? "pending" : "disabled",
    primaryTwoFaMethod: u.primaryTwoFaMethod,
    canGenerateApiToken: u.canGenerateApiToken,
    apiToken:
      f.ss.apiTokens.findBy("user_id", u.s1_id).length > 0
        ? { createdAt: u.apiTokenCreatedAt, expiresAt: u.apiTokenExpiresAt }
        : null,
    apiTokenCreatedAt: u.apiTokenCreatedAt,
    apiTokenExpiresAt: u.apiTokenExpiresAt,
    dateJoined: u.dateJoined,
    firstLogin: u.firstLogin,
    lastLogin: u.lastLogin,
    isSystem: u.isSystem,
    createdAt: u.created_at,
    updatedAt: u.updated_at,
  };
}

export function formatRole(f: Fmt, r: S1Role): Json {
  const usersInRoles = f.ss.users
    .all()
    .filter((user) => user.scopeRoles.some((scopeRole) => scopeRole.roleId === r.s1_id)).length;
  const account = r.scope === "account" && r.scope_id ? f.ss.accounts.findOneBy("s1_id", r.scope_id) : undefined;
  const site = r.scope === "site" && r.scope_id ? f.ss.sites.findOneBy("s1_id", r.scope_id) : undefined;
  return {
    id: r.s1_id,
    name: r.name,
    description: r.description,
    scope: r.scope,
    scopeId: r.scope_id ?? "",
    accountName: account?.name ?? (site ? accountName(f.ss, site.account_id) : null),
    siteName: site?.name ?? null,
    predefinedRole: r.predefinedRole,
    usersInRoles,
    creator: r.creator,
    createdAt: r.predefinedRole ? null : r.created_at,
    updatedAt: r.predefinedRole ? null : r.updated_at,
  };
}

export function formatThreat(f: Fmt, t: S1Threat): Json {
  const agent = f.ss.agents.findOneBy("s1_id", t.agent_id);
  const site = agent ? f.ss.sites.findOneBy("s1_id", agent.site_id) : undefined;
  return {
    id: t.s1_id,
    threatInfo: {
      threatId: t.s1_id,
      threatName: t.threatName,
      classification: t.classification,
      classificationSource: t.classificationSource,
      confidenceLevel: t.confidenceLevel,
      mitigationStatus: t.mitigationStatus,
      mitigationStatusDescription:
        t.mitigationStatus === "mitigated"
          ? "Mitigated"
          : t.mitigationStatus === "marked_as_benign"
            ? "Marked as benign"
            : "Not mitigated",
      incidentStatus: t.incidentStatus,
      incidentStatusDescription: t.incidentStatus.replace("_", " "),
      analystVerdict: t.analystVerdict,
      analystVerdictDescription: t.analystVerdict.replace("_", " "),
      sha1: t.sha1,
      sha256: t.sha256,
      md5: null,
      filePath: t.filePath,
      fileSize: t.fileSize,
      fileExtension: t.filePath.split(".").pop() ?? null,
      fileExtensionType: "Executable",
      originatorProcess: t.originatorProcess,
      processUser: t.processUser,
      initiatedBy: t.initiatedBy,
      initiatedByDescription: t.initiatedBy,
      detectionType: t.detectionType,
      engines: t.engines,
      identifiedAt: t.identifiedAt,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
      mitigatedPreemptively: false,
      pendingActions: false,
      rebootRequired: t.rebootRequired,
      storyline: t.storyline,
      threatDetectionSource: "Emulate",
      externalTicketId: null,
      externalTicketExists: false,
      automaticallyResolved: false,
      failedActions: false,
      isFileless: false,
      isValidCertificate: false,
      certificateId: null,
      publisherName: null,
      collectionId: null,
      cloudFilesHashVerdict: t.confidenceLevel === "malicious" ? "black" : "provider_unknown",
      maliciousProcessArguments: null,
      browserType: null,
      reachedEventsLimit: false,
    },
    agentRealtimeInfo: agent
      ? {
          agentId: agent.s1_id,
          agentUuid: agent.uuid,
          agentComputerName: agent.computerName,
          agentDomain: agent.domain,
          agentOsType: agent.osType,
          agentOsName: agent.osName,
          agentOsRevision: agent.osRevision,
          agentVersion: agent.agentVersion,
          agentMachineType: agent.machineType,
          agentIsActive: agent.isActive,
          agentIsDecommissioned: agent.isDecommissioned,
          agentInfected: agent.infected,
          agentMitigationMode: agent.mitigationMode,
          agentNetworkStatus: agent.networkStatus,
          activeThreats: agent.activeThreats,
          accountId: site?.account_id ?? null,
          accountName: site ? accountName(f.ss, site.account_id) : null,
          siteId: agent.site_id,
          siteName: site?.name ?? null,
          groupId: agent.group_id,
          groupName: groupName(f.ss, agent.group_id),
          networkInterfaces: [
            {
              id: `${agent.s1_id}-nic`,
              name: "Ethernet",
              inet: [agent.lastIpToMgmt],
              inet6: [],
              physical: "00-15-5D-01-02-03",
            },
          ],
          operationalState: agent.operationalState,
          rebootRequired: false,
          scanStatus: agent.scanStatus,
          scanStartedAt: agent.scanStartedAt,
          scanFinishedAt: agent.scanFinishedAt,
          scanAbortedAt: null,
          storageName: null,
          storageType: null,
          userActionsNeeded: [],
        }
      : null,
    agentDetectionInfo: agent
      ? {
          agentUuid: agent.uuid,
          agentComputerName: agent.computerName,
          agentDomain: agent.domain,
          agentIpV4: agent.lastIpToMgmt,
          agentIpV6: null,
          agentLastLoggedInUserName: agent.lastLoggedInUserName,
          agentLastLoggedInUpn: null,
          agentLastLoggedInUserMail: null,
          agentMitigationMode: agent.mitigationMode,
          agentOsName: agent.osName,
          agentOsRevision: agent.osRevision,
          agentRegisteredAt: agent.registeredAt,
          agentVersion: agent.agentVersion,
          agentDetectionState: null,
          accountId: site?.account_id ?? null,
          accountName: site ? accountName(f.ss, site.account_id) : null,
          siteId: agent.site_id,
          siteName: site?.name ?? null,
          groupId: agent.group_id,
          groupName: groupName(f.ss, agent.group_id),
          externalIp: agent.externalIp,
          cloudProviders: {},
        }
      : null,
    mitigationStatus: t.mitigations.map((mitigation) => ({
      action: mitigation.action,
      status: mitigation.status,
      mitigationStartedAt: mitigation.startedAt,
      mitigationEndedAt: mitigation.startedAt,
      agentSupportsReport: true,
      groupNotFound: false,
      lastUpdate: mitigation.startedAt,
      latestReport: null,
      reportId: null,
      actionsCounters: null,
    })),
    indicators: t.engines.map((engine, index) => ({
      category: "General",
      categoryId: index,
      description: `${engine} engine detected ${t.threatName}`,
      ids: [index],
      tactics: [],
    })),
    kubernetesInfo: null,
    containerInfo: null,
    ecsInfo: null,
    whiteningOptions: ["hash", "path"],
    notes: t.notes,
    mitigatedAt: t.mitigatedAt,
    resolvedAt: t.resolvedAt,
  };
}

export function formatApplication(f: Fmt, a: S1Application): Json {
  const agent = f.ss.agents.findOneBy("s1_id", a.agent_id);
  const site = agent ? f.ss.sites.findOneBy("s1_id", agent.site_id) : undefined;
  return {
    id: a.s1_id,
    application: a.name,
    applicationName: a.name,
    applicationVendor: a.vendor,
    applicationVersion: a.version,
    applicationType: a.applicationType,
    highestSeverity: a.highestSeverity,
    highestNvdBaseScore: a.highestNvdBaseScore,
    cveCount: a.cveCount,
    detectionDate: a.detectionDate,
    lastScanDate: a.lastScanDate,
    lastScanResult: a.lastScanResult,
    endpointId: agent?.s1_id ?? a.agent_id,
    endpointName: agent?.computerName ?? null,
    endpointType: agent?.machineType ?? null,
    osType: agent?.osType ?? null,
    accountId: site?.account_id ?? null,
    accountName: site ? accountName(f.ss, site.account_id) : null,
    siteId: agent?.site_id ?? null,
    siteName: site?.name ?? null,
    groupId: agent?.group_id ?? null,
    groupName: agent ? groupName(f.ss, agent.group_id) : null,
    isDeleted: a.isDeleted,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  };
}

export function formatCve(f: Fmt, cve: S1Cve): Json {
  const application = f.ss.applications.findOneBy("s1_id", cve.application_id);
  const agent = application ? f.ss.agents.findOneBy("s1_id", application.agent_id) : undefined;
  const site = agent ? f.ss.sites.findOneBy("s1_id", agent.site_id) : undefined;
  return {
    id: cve.s1_id,
    cveId: cve.cveId,
    baseScore: cve.baseScore,
    nvdBaseScore: cve.nvdBaseScore,
    cvssVersion: cve.cvssVersion,
    severity: cve.severity,
    nvdCvssSeverity: cve.severity,
    description: cve.description,
    detectionDate: cve.detectionDate,
    publishedDate: cve.publishedDate,
    lastScanDate: application?.lastScanDate ?? cve.updated_at,
    daysDetected: cve.daysDetected,
    ransomware: cve.ransomware,
    exploitedInTheWild: cve.exploitedInTheWild,
    analystVerdict: cve.analystVerdict,
    status: cve.status,
    application: application?.name ?? null,
    applicationName: application?.name ?? null,
    applicationVendor: application?.vendor ?? null,
    applicationVersion: application?.version ?? null,
    applicationType: application?.applicationType ?? null,
    endpointId: agent?.s1_id ?? application?.agent_id ?? null,
    endpointName: agent?.computerName ?? null,
    endpointType: agent?.machineType ?? null,
    osType: agent?.osType ?? null,
    accountId: site?.account_id ?? null,
    accountName: site ? accountName(f.ss, site.account_id) : null,
    siteId: agent?.site_id ?? null,
    siteName: site?.name ?? null,
    groupId: agent?.group_id ?? null,
    groupName: agent ? groupName(f.ss, agent.group_id) : null,
    riskScore: cve.baseScore,
    mitreUrl: null,
    nvdUrl: `https://nvd.nist.gov/vuln/detail/${cve.cveId}`,
    remediationLevel: null,
    reportConfidence: null,
    createdAt: cve.created_at,
    updatedAt: cve.updated_at,
  };
}

function scopeFields(f: Fmt, level: string, id: string | null): { scope: Json; scopeName: string; scopePath: string } {
  if (level === "tenant" || !id)
    return {
      scope: { tenant: true, accountIds: [], siteIds: [], groupIds: [] },
      scopeName: tenant(f.ss).name,
      scopePath: tenant(f.ss).name,
    };
  if (level === "account") {
    const name = accountName(f.ss, id) ?? id;
    return { scope: { tenant: false, accountIds: [id], siteIds: [], groupIds: [] }, scopeName: name, scopePath: name };
  }
  if (level === "site") {
    const site = f.ss.sites.findOneBy("s1_id", id);
    const account = site ? accountName(f.ss, site.account_id) : null;
    return {
      scope: { tenant: false, accountIds: site ? [site.account_id] : [], siteIds: [id], groupIds: [] },
      scopeName: site?.name ?? id,
      scopePath: [account, site?.name ?? id].filter(Boolean).join(" / "),
    };
  }
  const group = f.ss.groups.findOneBy("s1_id", id);
  const site = group ? f.ss.sites.findOneBy("s1_id", group.site_id) : undefined;
  const account = site ? accountName(f.ss, site.account_id) : null;
  return {
    scope: {
      tenant: false,
      accountIds: site ? [site.account_id] : [],
      siteIds: site ? [site.s1_id] : [],
      groupIds: [id],
    },
    scopeName: group?.name ?? id,
    scopePath: [account, site?.name, group?.name ?? id].filter(Boolean).join(" / "),
  };
}

export function formatExclusion(f: Fmt, e: S1Exclusion): Json {
  const scope = scopeFields(f, e.scope_level, e.scope_id);
  const base: Json = {
    id: e.s1_id,
    osType: e.osType,
    type: e.type,
    value: e.value,
    description: e.description,
    actions: e.actions.length > 0 ? e.actions : null,
    source: e.source,
    pathExclusionType: e.pathExclusionType,
    includeChildren: e.includeChildren,
    includeParents: e.includeParents,
    inject: e.inject,
    applicationName: e.applicationName,
    notRecommended: e.notRecommended,
    imported: e.imported,
    inAppInventory: e.inAppInventory,
    userId: e.user_id,
    userName: e.userName,
    scope: scope.scope,
    scopeName: scope.scopeName,
    scopePath: scope.scopePath,
    createdAt: e.created_at,
    updatedAt: e.updated_at,
  };
  if (!e.unified) return { ...base, mode: e.mode };
  return {
    ...base,
    exclusionName: e.exclusionName,
    threatType: e.threatType,
    reason: e.reason,
    recommendation: e.recommendation ?? "",
    interactionLevel: e.interactionLevel,
    modeType: e.modeType,
    tagIds: e.tagIds,
    engines: e.engines,
  };
}

export function formatRestriction(f: Fmt, r: S1Restriction): Json {
  const scope = scopeFields(f, r.scope_level, r.scope_id);
  return {
    id: r.s1_id,
    osType: r.osType,
    type: r.type,
    value: r.value,
    sha256Value: r.sha256Value,
    description: r.description,
    source: r.source,
    includeChildren: r.includeChildren,
    includeParents: r.includeParents,
    imported: r.imported,
    notRecommended: r.notRecommended,
    userId: r.user_id,
    userName: r.userName,
    scope: scope.scope,
    scopeName: scope.scopeName,
    scopePath: scope.scopePath,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function formatDeviceRule(f: Fmt, rule: S1DeviceRule): Json {
  const scope = scopeFields(f, rule.scope_level, rule.scope_id);
  return {
    id: rule.s1_id,
    order: rule.order,
    interface: rule.interface,
    ruleName: rule.ruleName,
    ruleType: rule.ruleType,
    action: rule.action,
    status: rule.status,
    deviceId: rule.deviceId,
    deviceClass: rule.deviceClass,
    deviceClassName: rule.deviceClass
      ? { readOnly: rule.accessPermission === "Read-Only", description: rule.deviceClass }
      : null,
    vendorId: rule.vendorId,
    productId: rule.productId,
    uid: rule.uid,
    version: rule.version,
    minorClasses: rule.minorClasses,
    accessPermission: rule.accessPermission,
    bluetoothAddress: rule.bluetoothAddress,
    gattService: rule.gattService,
    manufacturerName: rule.manufacturerName,
    deviceName: rule.deviceName,
    deviceInformationServiceInfoKey: rule.deviceInformationServiceInfoKey,
    deviceInformationServiceInfoValue: rule.deviceInformationServiceInfoValue,
    scope: rule.scope_level === "tenant" ? "global" : rule.scope_level,
    scopeId: rule.scope_id ?? "",
    scopeName: scope.scopeName,
    editable: true,
    creator: rule.creator,
    creatorId: rule.creatorId,
    createdAt: rule.created_at,
    updatedAt: rule.updated_at,
  };
}

export function formatActivity(f: Fmt, a: S1Activity): Json {
  return {
    id: a.s1_id,
    activityType: a.activityType,
    primaryDescription: a.primaryDescription,
    secondaryDescription: a.secondaryDescription,
    accountId: a.account_id,
    accountName: accountName(f.ss, a.account_id),
    siteId: a.site_id,
    siteName: siteName(f.ss, a.site_id),
    groupId: a.group_id,
    groupName: groupName(f.ss, a.group_id),
    agentId: a.agent_id,
    threatId: a.threat_id,
    userId: a.user_id,
    data: a.data,
    hash: null,
    osFamily: null,
    comments: null,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  };
}
