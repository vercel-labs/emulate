import type { S1Policy } from "./entities.js";
import type { Json } from "./helpers.js";
import { globalPolicy, type S1Store } from "./store.js";

export const DEFAULT_POLICY: S1Policy = {
  mitigationMode: "protect",
  mitigationModeSuspicious: "detect",
  autoMitigationAction: "mitigation.quarantineThreat",
  agentNotification: true,
  agentUiOn: true,
  agentLoggingOn: true,
  antiTamperingOn: true,
  allowRemoteShell: false,
  allowUnprotectByApprovedProcess: false,
  autoDecommissionOn: false,
  autoDecommissionDays: 30,
  autoImmuneOn: true,
  cloudValidationOn: { default: true, description: "Enabled" },
  driverBlocking: false,
  signedDriverBlockingOn: false,
  unsignedDriverBlockingOn: false,
  fwForNetworkQuarantineEnabled: true,
  identityOn: false,
  identityEndpointReporting: "moderate",
  ioc: true,
  iocSupported: true,
  isDvPolicyPerEventType: false,
  monitorOnExecute: true,
  monitorOnWrite: true,
  networkQuarantineOn: false,
  removeMacros: false,
  researchOn: true,
  scanNewAgents: true,
  snapshotsOn: true,
  engines: {
    preExecution: "on",
    preExecutionSuspicious: "on",
    applicationControl: "off",
    exploits: "on",
    pup: "on",
    lateralMovement: "on",
    executables: "on",
    idr: "off",
    driftDetection: "off",
    penetration: "on",
    remoteShell: "off",
    reputation: "on",
    dataFiles: "on",
  },
  agentUi: {
    showSupport: true,
    showAgentWarnings: true,
    showSuspicious: true,
    showQuarantineTab: true,
    showDeviceTab: true,
    threatPopUpNotifications: true,
    devicePopUpNotifications: true,
    agentUiOn: true,
    maxEventAgeDays: 30,
    contactCompany: "Emulate MSSP",
    contactEmail: "soc@example.com",
    contactPhoneNumber: null,
    contactSupportWebsite: null,
    contactFreeText: null,
    contactOther: null,
    contactDirectMessage: null,
  },
  iocAttributes: {
    windowsEventLogsExtended: false,
    dns: true,
    autoInstallBrowserExtensions: false,
    userSubstitution: true,
    url: true,
    behavioralIndicators: true,
    dataMasking: false,
    profileActivity: false,
    fds: false,
    driver: true,
    windowsEventLogs: true,
    ip: true,
    process: true,
    namedPipeExtended: false,
    smartFileMonitoring: true,
    dllModuleLoad: true,
    commandScripts: true,
    openDirectoryActivity: false,
    login: true,
    namedPipe: true,
    registry: true,
    scheduledTask: true,
    file: true,
    crossProcess: true,
  },
  autoFileUpload: {
    enabled: true,
    includeBenignFiles: false,
    maxFileSize: 20,
    maxFileSizeLimit: 20,
    maxDailyFileUpload: 1000,
    maxDailyFileUploadLimit: 1000,
    maxLocalDiskUsage: 500,
    maxLocalDiskUsageLimit: 500,
  },
  remoteOpsForensics: {
    enabled: false,
    cpuLimit: 25,
    maximumDailyUpload: 5000,
    maximumDailyUploadLimit: 5000,
    maximumFileSizeUpload: 500,
    maximumFileSizeUploadLimit: 500,
    parsedArtifactsDestination: "cloud",
  },
  remoteScriptOrchestration: {
    alwaysUploadStreamToCloud: false,
    maxDailyFileDownload: 5000,
    maxDailyFileDownloadLimit: 5000,
    maxDailyFileUpload: 5000,
    maxDailyFileUploadLimit: 5000,
    maxFileSize: 500,
    maxFileSizeLimit: 500,
    maxLocalPackageDiskUsage: 500,
    maxLocalPackageDiskUsageLimit: 500,
  },
  forensicsAutoTriggering: {
    windowsEnabled: false,
    macosEnabled: false,
    linuxEnabled: false,
    windowsProfileId: null,
    windowsProfileName: null,
    macosProfileId: null,
    macosProfileName: null,
    linuxProfileId: null,
    linuxProfileName: null,
  },
  identityConfigurationSettings: {
    identityMaxCpuThreshold: 10,
    identityMaxMemoryLimit: 1024,
    identityMaxDefinedMemoryLimit: 1024,
    identityMaxMemoryUsage: 512,
    identityThresholdMonitoring: true,
  },
  identityReportInterval: 60,
  identityThrottlingInterval: 30,
  identityUpdateInterval: 60,
};

function isPlainObject(value: unknown): value is Json {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function mergePolicy(base: S1Policy, override: S1Policy | null | undefined): S1Policy {
  if (!override) return { ...base };
  const result: S1Policy = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(result[key]))
      result[key] = mergePolicy(result[key] as S1Policy, value as S1Policy);
    else result[key] = value;
  }
  return result;
}

export const POLICY_META_KEYS = new Set([
  "inheritedFrom",
  "createdAt",
  "updatedAt",
  "userId",
  "userFullName",
  "isDefault",
  "id",
]);

export function stripPolicyMeta(policy: S1Policy): S1Policy {
  return Object.fromEntries(Object.entries(policy).filter(([key]) => !POLICY_META_KEYS.has(key)));
}

export interface ResolvedPolicy {
  policy: S1Policy;
  inheritedFrom: "global" | "account" | "site" | "group";
}

export function accountPolicy(ss: S1Store, accountId: string): ResolvedPolicy {
  const account = ss.accounts.findOneBy("s1_id", accountId);
  const base = mergePolicy(DEFAULT_POLICY, globalPolicy(ss));
  if (!account || account.inherits || !account.policy) return { policy: base, inheritedFrom: "global" };
  return { policy: mergePolicy(base, account.policy), inheritedFrom: "account" };
}

export function sitePolicy(ss: S1Store, siteId: string): ResolvedPolicy {
  const site = ss.sites.findOneBy("s1_id", siteId);
  if (!site) return accountPolicy(ss, "");
  const parent = accountPolicy(ss, site.account_id);
  if (site.inherits || !site.policy) return parent;
  return { policy: mergePolicy(parent.policy, site.policy), inheritedFrom: "site" };
}

export function groupPolicy(ss: S1Store, groupId: string): ResolvedPolicy {
  const group = ss.groups.findOneBy("s1_id", groupId);
  if (!group) return { policy: mergePolicy(DEFAULT_POLICY, globalPolicy(ss)), inheritedFrom: "global" };
  const parent = sitePolicy(ss, group.site_id);
  if (group.inherits || !group.policy) return parent;
  return { policy: mergePolicy(parent.policy, group.policy), inheritedFrom: "group" };
}

export function formatPolicy(
  resolved: ResolvedPolicy,
  updatedAt: string,
  user?: { id: string; fullName: string },
): Json {
  return {
    ...resolved.policy,
    inheritedFrom: resolved.inheritedFrom,
    createdAt: updatedAt,
    updatedAt,
    userId: user?.id ?? null,
    userFullName: user?.fullName ?? null,
    isDefault: resolved.inheritedFrom === "global",
  };
}
