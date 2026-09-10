import type { Entity } from "@emulators/core";

export type S1Policy = Record<string, unknown>;

export interface S1ApiToken extends Entity {
  token: string;
  user_id: string | null;
  description: string;
  expires_at: string | null;
}

export type SiteType = "Paid" | "Trial";
export type UsageType = "customer" | "ir" | "mssp";
export type BillingMode = "subscription" | "consumption";
export type ScopeLevel = "tenant" | "account" | "site" | "group";
export type ScopeState = "active" | "deleted" | "expired";

export interface S1LicenseSurface {
  name: string;
  count: number;
}

export interface S1LicenseBundle {
  name: string;
  surfaces: S1LicenseSurface[];
}

export interface S1Licenses {
  bundles: S1LicenseBundle[];
  modules: Array<{ name: string }>;
  settings: Array<{
    groupName: string;
    setting: string;
    displayName?: string;
    settingGroup?: string;
    settingGroupDisplayName?: string;
  }>;
}

export interface S1Account extends Entity {
  s1_id: string;
  name: string;
  accountType: SiteType | null;
  usageType: UsageType | null;
  externalId: string | null;
  billingMode: BillingMode | null;
  expiration: string | null;
  unlimitedExpiration: boolean;
  inherits: boolean;
  licenses: S1Licenses;
  policy: S1Policy | null;
  state: ScopeState;
  creator: string;
  creatorId: string;
}

export interface S1Site extends Entity {
  s1_id: string;
  account_id: string;
  name: string;
  siteType: SiteType;
  description: string | null;
  externalId: string | null;
  healthStatus: boolean;
  unlimitedExpiration: boolean;
  unlimitedLicenses: boolean;
  totalLicenses: number;
  isDefault: boolean;
  inherits: boolean;
  expiration: string | null;
  licenses: S1Licenses;
  registrationToken: string;
  policy: S1Policy | null;
  state: ScopeState;
  sku: string;
  suite: string;
  creator: string;
  creatorId: string;
}

export type GroupType = "static" | "pinned" | "dynamic";

export interface S1Group extends Entity {
  s1_id: string;
  site_id: string;
  name: string;
  description: string | null;
  type: GroupType;
  rank: number;
  isDefault: boolean;
  inherits: boolean;
  filter_id: string | null;
  registrationToken: string;
  policy: S1Policy | null;
  creator: string;
  creatorId: string;
}

export interface S1Filter extends Entity {
  s1_id: string;
  scope_level: "site" | "account";
  scope_id: string;
  name: string;
  filterFields: Record<string, unknown>;
}

export type OsType = "windows" | "linux" | "macos" | "windows_legacy";
export type MachineType = "server" | "laptop" | "desktop" | "kubernetes node" | "unknown";
export type MigrationStatus = "Migrated" | "Pending" | "N/A" | "Failed";
export type ScanStatus = "aborted" | "finished" | "none" | "started";
export type NetworkStatus = "connected" | "connecting" | "disconnected" | "disconnecting";

export interface S1Agent extends Entity {
  s1_id: string;
  uuid: string;
  site_id: string;
  group_id: string;
  computerName: string;
  domain: string;
  osType: OsType;
  osName: string;
  osRevision: string;
  osArch: string;
  machineType: MachineType;
  agentVersion: string;
  lastActiveDate: string;
  registeredAt: string;
  isActive: boolean;
  isDecommissioned: boolean;
  decommissionedAt: string | null;
  isUninstalled: boolean;
  isPendingUninstall: boolean;
  isUpToDate: boolean;
  infected: boolean;
  activeThreats: number;
  externalIp: string;
  lastIpToMgmt: string;
  lastLoggedInUserName: string;
  networkStatus: NetworkStatus;
  scanStatus: ScanStatus;
  scanStartedAt: string | null;
  scanFinishedAt: string | null;
  mitigationMode: "detect" | "protect";
  mitigationModeSuspicious: "detect" | "protect";
  consoleMigrationStatus: MigrationStatus;
  migrationStatus: MigrationStatus;
  cpuCount: number;
  coreCount: number;
  totalMemory: number;
  serialNumber: string;
  modelName: string;
  encryptedApplications: boolean;
  firewallEnabled: boolean;
  networkQuarantineEnabled: boolean;
  operationalState: string;
  passphrase: string;
  appsVulnerabilityStatus: "patch_required" | "up_to_date" | "not_applicable";
  externalId: string | null;
  tags: string[];
}

export type UserScope = "tenant" | "account" | "site";

export interface S1ScopeRole {
  id: string;
  roleId: string;
}

export interface S1User extends Entity {
  s1_id: string;
  email: string;
  fullName: string;
  scope: UserScope;
  scopeRoles: S1ScopeRole[];
  source: "mgmt" | "sso" | "scim";
  emailVerified: boolean;
  twoFaEnabled: boolean;
  twoFaConfigured: boolean;
  primaryTwoFaMethod: string | null;
  canGenerateApiToken: boolean;
  apiTokenCreatedAt: string | null;
  apiTokenExpiresAt: string | null;
  dateJoined: string;
  firstLogin: string | null;
  lastLogin: string | null;
  isSystem: boolean;
  onboardingEmailsSent: number;
  resetPasswordEmailsSent: number;
}

export interface S1Role extends Entity {
  s1_id: string;
  name: string;
  description: string;
  scope: UserScope;
  scope_id: string | null;
  predefinedRole: boolean;
  creator: string;
}

export type ThreatMitigationStatus = "not_mitigated" | "mitigated" | "marked_as_benign";
export type ThreatIncidentStatus = "unresolved" | "in_progress" | "resolved";
export type ThreatAnalystVerdict = "undefined" | "true_positive" | "false_positive" | "suspicious";
export type ThreatConfidence = "malicious" | "suspicious" | "n/a";

export interface S1Threat extends Entity {
  s1_id: string;
  agent_id: string;
  threatName: string;
  classification: string;
  classificationSource: string;
  confidenceLevel: ThreatConfidence;
  mitigationStatus: ThreatMitigationStatus;
  incidentStatus: ThreatIncidentStatus;
  analystVerdict: ThreatAnalystVerdict;
  sha1: string;
  sha256: string | null;
  filePath: string;
  fileSize: number;
  originatorProcess: string;
  processUser: string;
  initiatedBy: string;
  detectionType: "static" | "dynamic";
  engines: string[];
  identifiedAt: string;
  mitigatedAt: string | null;
  resolvedAt: string | null;
  storyline: string;
  rebootRequired: boolean;
  notes: string[];
  mitigations: Array<{ action: string; status: string; startedAt: string }>;
}

export type RiskSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "NONE";

export interface S1Application extends Entity {
  s1_id: string;
  agent_id: string;
  name: string;
  vendor: string;
  version: string;
  applicationType: string;
  highestSeverity: RiskSeverity;
  highestNvdBaseScore: number | null;
  cveCount: number;
  detectionDate: string;
  lastScanDate: string;
  lastScanResult: string;
  isDeleted: boolean;
}

export interface S1Cve extends Entity {
  s1_id: string;
  application_id: string;
  cveId: string;
  baseScore: number | null;
  severity: RiskSeverity;
  nvdBaseScore: number | null;
  cvssVersion: string;
  detectionDate: string;
  publishedDate: string;
  ransomware: boolean;
  exploitedInTheWild: boolean;
  analystVerdict: "Default" | "Added CVE" | "False positive" | "Not applicable";
  description: string;
  daysDetected: number;
  status: "Active" | "Resolved";
}

export type ExclusionType = "browser" | "certificate" | "file_type" | "path" | "white_hash";

export interface S1Exclusion extends Entity {
  s1_id: string;
  unified: boolean;
  scope_level: ScopeLevel;
  scope_id: string | null;
  osType: OsType;
  type: ExclusionType;
  value: string | null;
  description: string | null;
  exclusionName: string | null;
  mode: string | null;
  modeType: string | null;
  interactionLevel: string | null;
  threatType: "EDR" | "IDR";
  reason: string | null;
  recommendation: string | null;
  pathExclusionType: string | null;
  actions: string[];
  source: string;
  tagIds: string[];
  includeChildren: boolean;
  includeParents: boolean;
  inject: boolean;
  applicationName: string;
  notRecommended: string;
  imported: boolean;
  inAppInventory: boolean;
  engines: string | null;
  user_id: string | null;
  userName: string;
}

export interface S1Restriction extends Entity {
  s1_id: string;
  scope_level: ScopeLevel;
  scope_id: string | null;
  osType: OsType;
  type: string;
  value: string | null;
  sha256Value: string | null;
  description: string;
  source: string;
  includeChildren: boolean;
  includeParents: boolean;
  imported: boolean;
  notRecommended: string;
  user_id: string | null;
  userName: string;
}

export interface S1DeviceRule extends Entity {
  s1_id: string;
  scope_level: ScopeLevel;
  scope_id: string | null;
  order: number;
  interface: "Bluetooth" | "SDCard" | "Thunderbolt" | "USB";
  ruleName: string;
  ruleType: string;
  action: "Allow" | "Block";
  status: "Enabled" | "Disabled";
  deviceId: string | null;
  deviceClass: string | null;
  vendorId: string | null;
  productId: string | null;
  uid: string | null;
  version: string | null;
  minorClasses: string[];
  accessPermission: "Read-Only" | "Not-Applicable" | "Read-Write";
  bluetoothAddress: string | null;
  gattService: string[];
  manufacturerName: string | null;
  deviceName: string | null;
  deviceInformationServiceInfoKey: string | null;
  deviceInformationServiceInfoValue: string | null;
  creator: string;
  creatorId: string;
}

export interface S1Activity extends Entity {
  s1_id: string;
  activityType: number;
  primaryDescription: string;
  secondaryDescription: string | null;
  account_id: string | null;
  site_id: string | null;
  group_id: string | null;
  agent_id: string | null;
  threat_id: string | null;
  user_id: string | null;
  data: Record<string, unknown>;
}

export interface S1EventLog extends Entity {
  type: string;
  subject: string;
  detail: Record<string, unknown>;
}
