import type { Entity } from "@emulators/core";

export interface DefTenant extends Entity {
  tenant_id: string;
  name: string;
}

export interface DefApp extends Entity {
  client_id: string;
  client_secret: string;
  name: string;
  tenant_ids: string[] | null;
  roles: string[];
}

export interface DefToken extends Entity {
  token: string;
  tenant_id: string;
  client_id: string;
  roles: string[];
  expires_at: string;
}

export type OnboardingStatus = "Onboarded" | "CanBeOnboarded" | "Unsupported" | "InsufficientInfo";
export type HealthStatus =
  | "Active"
  | "Inactive"
  | "ImpairedCommunication"
  | "NoSensorData"
  | "NoSensorDataImpairedCommunication"
  | "Unknown";
export type RiskScore = "None" | "Informational" | "Low" | "Medium" | "High";
export type ExposureLevel = "None" | "Low" | "Medium" | "High";
export type DeviceValue = "Normal" | "Low" | "High";

export interface DefMachine extends Entity {
  tenant_id: string;
  machine_id: string;
  computerDnsName: string;
  firstSeen: string;
  lastSeen: string;
  osPlatform: string;
  osVersion: string | null;
  osProcessor: string;
  version: string;
  lastIpAddress: string;
  lastExternalIpAddress: string;
  agentVersion: string;
  osBuild: number | null;
  healthStatus: HealthStatus;
  deviceValue: DeviceValue;
  rbacGroupId: number;
  rbacGroupName: string | null;
  riskScore: RiskScore;
  exposureLevel: ExposureLevel;
  isAadJoined: boolean;
  aadDeviceId: string | null;
  machineTags: string[];
  defenderAvStatus: string;
  onboardingStatus: OnboardingStatus;
  osArchitecture: string;
  managedBy: string;
  managedByStatus: string;
  ipAddresses: Array<{ ipAddress: string; macAddress: string | null; type: string; operationalStatus: string }>;
  vmMetadata: { vmId: string; cloudProvider: string; resourceId: string; subscriptionId: string } | null;
  isolated: boolean;
  code_execution_restricted: boolean;
  isExcluded: boolean;
  exclusionReason: string | null;
}

export type AlertSeverity = "UnSpecified" | "Informational" | "Low" | "Medium" | "High";
export type AlertStatus = "Unknown" | "New" | "InProgress" | "Resolved";
export type AlertClassification = "Unknown" | "FalsePositive" | "TruePositive" | "InformationalExpectedActivity" | null;

export interface DefAlertEvidence {
  entityType: string;
  evidenceCreationTime: string;
  sha1: string | null;
  sha256: string | null;
  fileName: string | null;
  filePath: string | null;
  processId: number | null;
  processCommandLine: string | null;
  processCreationTime: string | null;
  parentProcessId: number | null;
  parentProcessCreationTime: string | null;
  parentProcessFileName: string | null;
  parentProcessFilePath: string | null;
  ipAddress: string | null;
  url: string | null;
  registryKey: string | null;
  registryHive: string | null;
  registryValueType: string | null;
  registryValue: string | null;
  registryValueName: string | null;
  accountName: string | null;
  domainName: string | null;
  userSid: string | null;
  aadUserId: string | null;
  userPrincipalName: string | null;
  detectionStatus: string | null;
}

export interface DefAlertComment {
  comment: string;
  createdBy: string;
  createdTime: string;
}

export interface DefAlert extends Entity {
  tenant_id: string;
  alert_id: string;
  incidentId: number;
  investigationId: number | null;
  investigationState: string;
  assignedTo: string | null;
  severity: AlertSeverity;
  status: AlertStatus;
  classification: AlertClassification;
  determination: string | null;
  detectionSource: string;
  detectorId: string;
  category: string;
  threatFamilyName: string | null;
  title: string;
  description: string;
  alertCreationTime: string;
  firstEventTime: string;
  lastEventTime: string;
  lastUpdateTime: string;
  resolvedTime: string | null;
  machine_id: string;
  computerDnsName: string;
  rbacGroupName: string | null;
  aadTenantId: string;
  threatName: string | null;
  mitreTechniques: string[];
  relatedUser: { userName: string; domainName: string } | null;
  loggedOnUsers: Array<{ accountName: string; domainName: string }>;
  comments: DefAlertComment[];
  evidence: DefAlertEvidence[];
}

export type MachineActionType =
  | "RunAntiVirusScan"
  | "Offboard"
  | "CollectInvestigationPackage"
  | "Isolate"
  | "Unisolate"
  | "StopAndQuarantineFile"
  | "RestrictCodeExecution"
  | "UnrestrictCodeExecution"
  | "LiveResponse"
  | "InitiateInvestigation";

export type MachineActionStatus = "Pending" | "InProgress" | "Succeeded" | "Failed" | "TimeOut" | "Cancelled";

export interface DefMachineAction extends Entity {
  tenant_id: string;
  action_id: string;
  type: MachineActionType;
  title: string | null;
  requestor: string;
  requestorComment: string;
  status: MachineActionStatus;
  machine_id: string;
  computerDnsName: string;
  creationDateTimeUtc: string;
  lastUpdateDateTimeUtc: string;
  cancellationRequestor: string | null;
  cancellationComment: string | null;
  cancellationDateTimeUtc: string | null;
  scope: string | null;
  externalId: string | null;
  requestSource: string;
  relatedFileInfo: { fileIdentifier: string; fileIdentifierType: string } | null;
  commands: Array<{
    index: number;
    startTime: string | null;
    endTime: string | null;
    commandStatus: string;
    errors: string[];
    command: { type: string; params: Array<{ key: string; value: string }> };
  }>;
  troubleshootInfo: string | null;
  frozen: boolean;
}

export interface DefVulnerability extends Entity {
  tenant_id: string;
  cve_id: string;
  name: string;
  description: string;
  severity: "Low" | "Medium" | "High" | "Critical";
  cvssV3: number;
  cvssVector: string | null;
  exposedMachines: number;
  publishedOn: string;
  updatedOn: string;
  firstDetected: string | null;
  publicExploit: boolean;
  exploitVerified: boolean;
  exploitInKit: boolean;
  exploitTypes: string[];
  exploitUris: string[];
  cveSupportability: string;
  tags: string[];
  epss: number | null;
}

export interface DefSoftware extends Entity {
  tenant_id: string;
  software_id: string;
  name: string;
  vendor: string;
  weaknesses: number;
  publicExploit: boolean;
  activeAlert: boolean;
  exposedMachines: number;
  impactScore: number;
}

export interface DefMachineSoftware extends Entity {
  tenant_id: string;
  machine_id: string;
  software_id: string;
  version: string;
  installed_on: string;
}

export interface DefMachineVulnerability extends Entity {
  tenant_id: string;
  machine_id: string;
  cve_id: string;
  software_id: string | null;
  fixing_kb_id: string | null;
  product_version: string | null;
}

export interface DefRecommendation extends Entity {
  tenant_id: string;
  recommendation_id: string;
  productName: string;
  recommendationName: string;
  weaknesses: number;
  vendor: string;
  recommendedVersion: string;
  recommendedVendor: string;
  recommendedProgram: string;
  recommendationCategory: string;
  subCategory: string;
  severityScore: number;
  publicExploit: boolean;
  activeAlert: boolean;
  associatedThreats: string[];
  remediationType: string;
  status: "Active" | "Exception";
  configScoreImpact: number;
  exposureImpact: number;
  totalMachineCount: number;
  exposedMachinesCount: number;
  nonProductivityImpactedAssets: number;
  relatedComponent: string;
  software_id: string | null;
  cve_ids: string[];
}

export type IndicatorType =
  | "FileSha1"
  | "FileSha256"
  | "FileMd5"
  | "CertificateThumbprint"
  | "IpAddress"
  | "DomainName"
  | "Url";
export type IndicatorAction = "Warn" | "Block" | "Audit" | "Alert" | "AlertAndBlock" | "BlockAndRemediate" | "Allowed";

export interface DefIndicator extends Entity {
  tenant_id: string;
  indicator_id: string;
  indicatorValue: string;
  indicatorType: IndicatorType;
  action: IndicatorAction;
  application: string | null;
  source: string;
  sourceType: string;
  createdBy: string;
  createdBySource: string;
  createdByDisplayName: string;
  creationTimeDateTimeUtc: string;
  expirationTime: string | null;
  lastUpdateTime: string;
  lastUpdatedBy: string;
  severity: AlertSeverity;
  title: string;
  description: string;
  recommendedActions: string | null;
  rbacGroupNames: string[];
  rbacGroupIds: number[];
  generateAlert: boolean;
  mitreTechniques: string[];
  category: number | null;
  educateUrl: string | null;
  certificateInfo: unknown | null;
  version: string | null;
  historicalDetection: boolean;
  lookBackPeriod: number | null;
}

export interface DefInvestigation extends Entity {
  tenant_id: string;
  investigation_id: string;
  startTime: string;
  endTime: string | null;
  state: string;
  cancelledBy: string | null;
  statusDetails: string | null;
  machine_id: string;
  computerDnsName: string;
  triggeringAlertId: string | null;
}

export interface DefLogonUser extends Entity {
  tenant_id: string;
  machine_id: string;
  user_id: string;
  accountName: string;
  accountDomain: string;
  accountSid: string | null;
  firstSeen: string;
  lastSeen: string;
  logonTypes: string;
  logOnMachinesCount: number;
  isDomainAdmin: boolean;
  isOnlyNetworkUser: boolean;
}

export interface DefEventLog extends Entity {
  tenant_id: string;
  type: string;
  subject: string;
  detail: Record<string, unknown>;
}
