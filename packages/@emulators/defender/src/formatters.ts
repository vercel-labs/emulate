import type {
  DefAlert,
  DefIndicator,
  DefInvestigation,
  DefLogonUser,
  DefMachine,
  DefMachineAction,
  DefRecommendation,
  DefSoftware,
  DefVulnerability,
  MachineActionStatus,
} from "./entities.js";
import { actionDelays, type DefStore } from "./store.js";

export type Json = Record<string, unknown>;

export interface Fmt {
  ds: DefStore;
  baseUrl: string;
}

export function formatMachine(m: DefMachine): Json {
  return {
    id: m.machine_id,
    mergedIntoMachineId: null,
    isPotentialDuplication: false,
    isExcluded: m.isExcluded,
    exclusionReason: m.exclusionReason,
    computerDnsName: m.computerDnsName,
    firstSeen: m.firstSeen,
    lastSeen: m.lastSeen,
    osPlatform: m.osPlatform,
    osVersion: m.osVersion,
    osProcessor: m.osProcessor,
    version: m.version,
    lastIpAddress: m.lastIpAddress,
    lastExternalIpAddress: m.lastExternalIpAddress,
    agentVersion: m.agentVersion,
    osBuild: m.osBuild,
    healthStatus: m.healthStatus,
    deviceValue: m.deviceValue,
    rbacGroupId: m.rbacGroupId,
    rbacGroupName: m.rbacGroupName,
    riskScore: m.riskScore,
    exposureLevel: m.exposureLevel,
    isAadJoined: m.isAadJoined,
    aadDeviceId: m.aadDeviceId,
    machineTags: m.machineTags,
    defenderAvStatus: m.defenderAvStatus,
    onboardingStatus: m.onboardingStatus,
    osArchitecture: m.osArchitecture,
    managedBy: m.managedBy,
    managedByStatus: m.managedByStatus,
    ipAddresses: m.ipAddresses,
    vmMetadata: m.vmMetadata,
  };
}

export function formatAlert(a: DefAlert): Json {
  return {
    id: a.alert_id,
    incidentId: a.incidentId,
    investigationId: a.investigationId,
    assignedTo: a.assignedTo,
    severity: a.severity,
    status: a.status,
    classification: a.classification,
    determination: a.determination,
    investigationState: a.investigationState,
    detectionSource: a.detectionSource,
    detectorId: a.detectorId,
    category: a.category,
    threatFamilyName: a.threatFamilyName,
    title: a.title,
    description: a.description,
    alertCreationTime: a.alertCreationTime,
    firstEventTime: a.firstEventTime,
    lastEventTime: a.lastEventTime,
    lastUpdateTime: a.lastUpdateTime,
    resolvedTime: a.resolvedTime,
    machineId: a.machine_id,
    computerDnsName: a.computerDnsName,
    rbacGroupName: a.rbacGroupName,
    aadTenantId: a.aadTenantId,
    threatName: a.threatName,
    mitreTechniques: a.mitreTechniques,
    relatedUser: a.relatedUser,
    loggedOnUsers: a.loggedOnUsers,
    comments: a.comments,
    evidence: a.evidence,
    domains: [
      ...new Set(
        a.evidence
          .filter((item) => item.url || ["Url", "Domain", "DomainName"].includes(item.entityType))
          .map((item) => item.domainName)
          .filter((value): value is string => !!value),
      ),
    ],
  };
}

export function liveActionStatus(ds: DefStore, action: DefMachineAction): MachineActionStatus {
  if (
    action.frozen ||
    action.status === "Cancelled" ||
    action.status === "Failed" ||
    action.status === "TimeOut" ||
    action.status === "Succeeded"
  )
    return action.status;
  const delays = actionDelays(ds);
  const age = Date.now() - Date.parse(action.creationDateTimeUtc);
  if (age >= delays.succeeded_after_ms) return "Succeeded";
  if (age >= delays.in_progress_after_ms) return "InProgress";
  return "Pending";
}

export function formatMachineAction(ds: DefStore, a: DefMachineAction): Json {
  const status = liveActionStatus(ds, a);
  return {
    id: a.action_id,
    type: a.type,
    title: a.title,
    requestor: a.requestor,
    requestorComment: a.requestorComment,
    status,
    machineId: a.machine_id,
    computerDnsName: a.computerDnsName,
    creationDateTimeUtc: a.creationDateTimeUtc,
    lastUpdateDateTimeUtc: status === a.status ? a.lastUpdateDateTimeUtc : new Date().toISOString(),
    cancellationRequestor: a.cancellationRequestor,
    cancellationComment: a.cancellationComment,
    cancellationDateTimeUtc: a.cancellationDateTimeUtc,
    errorHResult: 0,
    scope: a.scope,
    externalId: a.externalId,
    requestSource: a.requestSource,
    relatedFileInfo: a.relatedFileInfo,
    commands: a.commands.map((command) => ({
      ...command,
      commandStatus:
        status === "Succeeded" ? "Completed" : status === "Cancelled" ? "Cancelled" : command.commandStatus,
    })),
    troubleshootInfo: a.troubleshootInfo,
  };
}

export function formatVulnerability(v: DefVulnerability): Json {
  return {
    id: v.cve_id,
    name: v.name,
    description: v.description,
    severity: v.severity,
    cvssV3: v.cvssV3,
    cvssVector: v.cvssVector,
    exposedMachines: v.exposedMachines,
    publishedOn: v.publishedOn,
    updatedOn: v.updatedOn,
    firstDetected: v.firstDetected,
    publicExploit: v.publicExploit,
    exploitVerified: v.exploitVerified,
    exploitInKit: v.exploitInKit,
    exploitTypes: v.exploitTypes,
    exploitUris: v.exploitUris,
    cveSupportability: v.cveSupportability,
    tags: v.tags,
    epss: v.epss,
  };
}

export function formatSoftware(s: DefSoftware): Json {
  return {
    id: s.software_id,
    name: s.name,
    vendor: s.vendor,
    weaknesses: s.weaknesses,
    publicExploit: s.publicExploit,
    activeAlert: s.activeAlert,
    exposedMachines: s.exposedMachines,
    impactScore: s.impactScore,
  };
}

export function formatRecommendation(r: DefRecommendation): Json {
  return {
    id: r.recommendation_id,
    productName: r.productName,
    recommendationName: r.recommendationName,
    weaknesses: r.weaknesses,
    vendor: r.vendor,
    recommendedVersion: r.recommendedVersion,
    recommendedVendor: r.recommendedVendor,
    recommendedProgram: r.recommendedProgram,
    recommendationCategory: r.recommendationCategory,
    subCategory: r.subCategory,
    severityScore: r.severityScore,
    publicExploit: r.publicExploit,
    activeAlert: r.activeAlert,
    associatedThreats: r.associatedThreats,
    remediationType: r.remediationType,
    status: r.status,
    configScoreImpact: r.configScoreImpact,
    exposureImpact: r.exposureImpact,
    totalMachineCount: r.totalMachineCount,
    exposedMachinesCount: r.exposedMachinesCount,
    nonProductivityImpactedAssets: r.nonProductivityImpactedAssets,
    relatedComponent: r.relatedComponent,
    hasUserImpact: false,
    isAllowed: false,
  };
}

export function formatIndicator(i: DefIndicator): Json {
  return {
    id: i.indicator_id,
    indicatorValue: i.indicatorValue,
    indicatorType: i.indicatorType,
    action: i.action,
    application: i.application,
    source: i.source,
    sourceType: i.sourceType,
    createdBy: i.createdBy,
    createdBySource: i.createdBySource,
    createdByDisplayName: i.createdByDisplayName,
    creationTimeDateTimeUtc: i.creationTimeDateTimeUtc,
    expirationTime: i.expirationTime,
    lastUpdateTime: i.lastUpdateTime,
    lastUpdatedBy: i.lastUpdatedBy,
    severity: i.severity,
    title: i.title,
    description: i.description,
    recommendedActions: i.recommendedActions,
    rbacGroupNames: i.rbacGroupNames,
    rbacGroupIds: i.rbacGroupIds,
    generateAlert: i.generateAlert,
    mitreTechniques: i.mitreTechniques,
    category: i.category,
    educateUrl: i.educateUrl,
    certificateInfo: i.certificateInfo,
    version: i.version,
    historicalDetection: i.historicalDetection,
    lookBackPeriod: i.lookBackPeriod,
  };
}

export function formatInvestigation(i: DefInvestigation): Json {
  return {
    id: i.investigation_id,
    startTime: i.startTime,
    endTime: i.endTime,
    state: i.state,
    cancelledBy: i.cancelledBy,
    statusDetails: i.statusDetails,
    machineId: i.machine_id,
    computerDnsName: i.computerDnsName,
    triggeringAlertId: i.triggeringAlertId,
  };
}

export function formatLogonUser(u: DefLogonUser): Json {
  return {
    id: u.user_id,
    accountName: u.accountName,
    accountDomain: u.accountDomain,
    accountSid: u.accountSid,
    firstSeen: u.firstSeen,
    lastSeen: u.lastSeen,
    logonTypes: u.logonTypes,
    logOnMachinesCount: u.logOnMachinesCount,
    isDomainAdmin: u.isDomainAdmin,
    isOnlyNetworkUser: u.isOnlyNetworkUser,
  };
}
