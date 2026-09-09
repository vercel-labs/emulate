import type { AlertClassification, AlertSeverity, AlertStatus, DefAlert, DefAlertEvidence } from "../entities.js";
import { formatAlert, formatLogonUser, formatMachine } from "../formatters.js";
import {
  alertId,
  api,
  badRequest,
  field,
  guid,
  nowIso,
  odataCollection,
  odataEntity,
  odataOptions,
  oneOf,
  parseJsonBody,
  route,
  str,
  strOrNull,
  stringArray,
  type Body,
} from "../helpers.js";
import { logEvent, type DefStore } from "../store.js";
import { findAlert, findMachine, tenantRows, type DefRouteContext } from "../route-utils.js";

export const ALERT_STATUSES = ["Unknown", "New", "InProgress", "Resolved"] as const;
export const ALERT_SEVERITIES = ["UnSpecified", "Informational", "Low", "Medium", "High"] as const;
export const ALERT_CLASSIFICATIONS = [
  "Unknown",
  "FalsePositive",
  "TruePositive",
  "InformationalExpectedActivity",
] as const;
export const ALERT_DETERMINATIONS = [
  "NotAvailable",
  "Apt",
  "Malware",
  "SecurityPersonnel",
  "SecurityTesting",
  "UnwantedSoftware",
  "Other",
  "MultiStagedAttack",
  "CompromisedUser",
  "Phishing",
  "MaliciousUserActivity",
  "Clean",
  "InsufficientData",
  "ConfirmedUserActivity",
  "LineOfBusinessApplication",
] as const;

export interface CreateAlertInput {
  tenantId: string;
  machineId: string;
  title: string;
  description?: string;
  severity?: AlertSeverity;
  category?: string;
  status?: AlertStatus;
  detectionSource?: string;
  detectorId?: string;
  threatName?: string | null;
  threatFamilyName?: string | null;
  mitreTechniques?: string[];
  eventTime?: string;
  evidence?: Array<Partial<DefAlertEvidence>>;
  relatedUser?: { userName: string; domainName: string } | null;
  recommendedAction?: string;
  incidentId?: number;
}

export function emptyEvidence(overrides: Partial<DefAlertEvidence>): DefAlertEvidence {
  return {
    entityType: "File",
    evidenceCreationTime: nowIso(),
    sha1: null,
    sha256: null,
    fileName: null,
    filePath: null,
    processId: null,
    processCommandLine: null,
    processCreationTime: null,
    parentProcessId: null,
    parentProcessCreationTime: null,
    parentProcessFileName: null,
    parentProcessFilePath: null,
    ipAddress: null,
    url: null,
    registryKey: null,
    registryHive: null,
    registryValueType: null,
    registryValue: null,
    registryValueName: null,
    accountName: null,
    domainName: null,
    userSid: null,
    aadUserId: null,
    userPrincipalName: null,
    detectionStatus: "Detected",
    ...overrides,
  };
}

export function createAlert(ds: DefStore, input: CreateAlertInput): DefAlert {
  const machine = findMachine(ds, input.tenantId, input.machineId);
  const now = nowIso();
  const eventTime = input.eventTime ?? now;
  const incidentId = input.incidentId ?? 1000 + ds.alerts.count();
  const alert = ds.alerts.insert({
    tenant_id: input.tenantId,
    alert_id: alertId(),
    incidentId,
    investigationId: null,
    investigationState: "UnsupportedAlertType",
    assignedTo: null,
    severity: input.severity ?? "Medium",
    status: input.status ?? "New",
    classification: null,
    determination: null,
    detectionSource: input.detectionSource ?? "WindowsDefenderAtp",
    detectorId: input.detectorId ?? guid(),
    category: input.category ?? "SuspiciousActivity",
    threatFamilyName: input.threatFamilyName ?? null,
    title: input.title,
    description: input.description ?? input.recommendedAction ?? "",
    alertCreationTime: now,
    firstEventTime: eventTime,
    lastEventTime: eventTime,
    lastUpdateTime: now,
    resolvedTime: null,
    machine_id: machine.machine_id,
    computerDnsName: machine.computerDnsName,
    rbacGroupName: machine.rbacGroupName,
    aadTenantId: input.tenantId,
    threatName: input.threatName ?? null,
    mitreTechniques: input.mitreTechniques ?? [],
    relatedUser: input.relatedUser ?? null,
    loggedOnUsers: ds.logonUsers
      .findBy("machine_id", machine.machine_id)
      .map((user) => ({ accountName: user.accountName, domainName: user.accountDomain })),
    comments: [],
    evidence: (input.evidence ?? []).map((item) => emptyEvidence(item)),
  });
  ds.machines.update(machine.id, {
    riskScore: alert.severity === "High" ? "High" : machine.riskScore === "None" ? "Medium" : machine.riskScore,
  });
  logEvent(ds, input.tenantId, "alert.created", alert.alert_id, {
    title: alert.title,
    severity: alert.severity,
    machine_id: machine.machine_id,
  });
  return alert;
}

function parseEvidence(body: Body): Array<Partial<DefAlertEvidence>> {
  const raw = field(body, "evidence");
  if (!Array.isArray(raw)) return [];
  return raw.filter((item) => item && typeof item === "object").map((item) => item as Partial<DefAlertEvidence>);
}

export function alertRoutes(rc: DefRouteContext): void {
  const { app, ds, baseUrl } = rc;

  route(
    app,
    "get",
    "/api/alerts",
    api(ds, (c, auth) =>
      odataCollection(
        c,
        baseUrl,
        "Alerts",
        tenantRows(ds.alerts.all(), auth.tenantId)
          .sort((a, b) => b.id - a.id)
          .map(formatAlert),
        odataOptions(c),
      ),
    ),
  );

  route(
    app,
    "post",
    "/api/alerts/CreateAlertByReference",
    api(ds, async (c, auth) => {
      const body = await parseJsonBody(c);
      const machineId = str(field(body, "machineId"));
      if (!machineId) throw badRequest("machineId is required", "MissingParameter");
      const title = str(field(body, "title"))?.trim();
      if (!title) throw badRequest("title is required", "MissingParameter");
      const eventTime = str(field(body, "eventTime"));
      if (!eventTime || Number.isNaN(Date.parse(eventTime)))
        throw badRequest("eventTime must be an ISO 8601 date", "InvalidParameter");
      const reportId = str(field(body, "reportId"));
      if (!reportId) throw badRequest("reportId is required", "MissingParameter");
      const alert = createAlert(ds, {
        tenantId: auth.tenantId,
        machineId,
        title,
        description: str(field(body, "description")),
        severity: oneOf(field(body, "severity"), ALERT_SEVERITIES, "severity"),
        category: str(field(body, "category")),
        detectionSource: "CustomerTI",
        eventTime: new Date(eventTime).toISOString(),
        recommendedAction: str(field(body, "recommendedAction")),
        evidence: parseEvidence(body),
      });
      c.status(201);
      return odataEntity(c, baseUrl, "Alerts", formatAlert(alert));
    }),
  );

  route(
    app,
    "post",
    "/api/alerts/batchUpdate",
    api(ds, async (c, auth) => {
      const body = await parseJsonBody(c);
      const ids = stringArray(field(body, "alertIds")) ?? [];
      if (ids.length === 0) throw badRequest("alertIds must contain at least one alert id", "InvalidParameter");
      const alerts = ids.map((id) => findAlert(ds, auth.tenantId, id));
      const updated = alerts.map((alert) => applyAlertUpdate(ds, alert, body, auth.token.client_id));
      return c.json({ "@odata.context": `${baseUrl}/api/$metadata#Alerts`, value: updated.map(formatAlert) });
    }),
  );

  route(
    app,
    "get",
    "/api/alerts/:id",
    api(ds, (c, auth) =>
      odataEntity(c, baseUrl, "Alerts", formatAlert(findAlert(ds, auth.tenantId, c.req.param("id")))),
    ),
  );

  route(
    app,
    "patch",
    "/api/alerts/:id",
    api(ds, async (c, auth) => {
      const alert = findAlert(ds, auth.tenantId, c.req.param("id"));
      const body = await parseJsonBody(c);
      if (Object.keys(body).length === 0)
        throw badRequest(
          "At least one of status, assignedTo, classification, determination, or comment is required",
          "InvalidRequestBody",
        );
      const updated = applyAlertUpdate(ds, alert, body, auth.token.client_id);
      return odataEntity(c, baseUrl, "Alerts", formatAlert(updated));
    }),
  );

  route(
    app,
    "get",
    "/api/alerts/:id/machine",
    api(ds, (c, auth) => {
      const alert = findAlert(ds, auth.tenantId, c.req.param("id"));
      return odataEntity(c, baseUrl, "Machines", formatMachine(findMachine(ds, auth.tenantId, alert.machine_id)));
    }),
  );

  route(
    app,
    "get",
    "/api/alerts/:id/user",
    api(ds, (c, auth) => {
      const alert = findAlert(ds, auth.tenantId, c.req.param("id"));
      const user = alert.relatedUser
        ? ds.logonUsers
            .findBy("machine_id", alert.machine_id)
            .find((candidate) => candidate.accountName.toLowerCase() === alert.relatedUser!.userName.toLowerCase())
        : undefined;
      if (!user)
        return c.json({
          "@odata.context": `${baseUrl}/api/$metadata#Users/$entity`,
          ...(alert.relatedUser
            ? {
                id: `${alert.relatedUser.domainName}\\${alert.relatedUser.userName}`,
                accountName: alert.relatedUser.userName,
                accountDomain: alert.relatedUser.domainName,
              }
            : {}),
        });
      return odataEntity(c, baseUrl, "Users", formatLogonUser(user));
    }),
  );

  route(
    app,
    "get",
    "/api/alerts/:id/files",
    api(ds, (c, auth) => {
      const alert = findAlert(ds, auth.tenantId, c.req.param("id"));
      const files = alert.evidence
        .filter((item) => item.sha1 || item.sha256)
        .map((item) => ({
          sha1: item.sha1,
          sha256: item.sha256,
          md5: null,
          globalPrevalence: 1,
          globalFirstObserved: item.evidenceCreationTime,
          globalLastObserved: item.evidenceCreationTime,
          size: null,
          fileType: null,
          isPeFile: item.fileName?.toLowerCase().endsWith(".exe") ?? false,
          filePublisher: null,
          fileProductName: null,
          signer: null,
          issuer: null,
          signerHash: null,
          isValidCertificate: null,
          determinationType: "Unknown",
          determinationValue: null,
        }));
      return c.json({ "@odata.context": `${baseUrl}/api/$metadata#Files`, value: files });
    }),
  );

  route(
    app,
    "get",
    "/api/alerts/:id/ips",
    api(ds, (c, auth) => {
      const alert = findAlert(ds, auth.tenantId, c.req.param("id"));
      return c.json({
        "@odata.context": `${baseUrl}/api/$metadata#Ips`,
        value: alert.evidence.filter((item) => item.ipAddress).map((item) => ({ id: item.ipAddress })),
      });
    }),
  );

  route(
    app,
    "get",
    "/api/alerts/:id/domains",
    api(ds, (c, auth) => {
      const alert = findAlert(ds, auth.tenantId, c.req.param("id"));
      const hosts = alert.evidence
        .filter((item) => item.url || ["Url", "Domain", "DomainName"].includes(item.entityType))
        .map((item) => item.domainName ?? safeHost(item.url));
      return c.json({
        "@odata.context": `${baseUrl}/api/$metadata#Domains`,
        value: [...new Set(hosts.filter((host): host is string => !!host))].map((host) => ({ host })),
      });
    }),
  );
}

function safeHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function applyAlertUpdate(ds: DefStore, alert: DefAlert, body: Body, clientId: string): DefAlert {
  const status = oneOf(field(body, "status"), ALERT_STATUSES, "status");
  const classification = oneOf(field(body, "classification"), ALERT_CLASSIFICATIONS, "classification");
  const determination = oneOf(field(body, "determination"), ALERT_DETERMINATIONS, "determination");
  const assignedTo = field(body, "assignedTo") !== undefined ? strOrNull(field(body, "assignedTo")) : undefined;
  const comment = str(field(body, "comment"))?.trim();
  const now = nowIso();
  const updates: Partial<DefAlert> = { lastUpdateTime: now };
  if (status) {
    updates.status = status as AlertStatus;
    updates.resolvedTime = status === "Resolved" ? now : null;
  }
  if (classification) updates.classification = classification as AlertClassification;
  if (determination) updates.determination = determination;
  if (assignedTo !== undefined) updates.assignedTo = assignedTo;
  if (comment) updates.comments = [...alert.comments, { comment, createdBy: `${clientId}@emulate`, createdTime: now }];
  const updated = ds.alerts.update(alert.id, updates)!;
  logEvent(ds, alert.tenant_id, "alert.updated", alert.alert_id, {
    status: updated.status,
    classification: updated.classification,
    determination: updated.determination,
    assignedTo: updated.assignedTo,
    comment: comment ?? null,
  });
  return updated;
}
