import type { AlertSeverity, DefIndicator, IndicatorAction, IndicatorType } from "../entities.js";
import { formatIndicator } from "../formatters.js";
import {
  api,
  badRequest,
  bool,
  field,
  guid,
  nowIso,
  num,
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
import { findIndicator, tenantRows, type DefRouteContext } from "../route-utils.js";
import { ALERT_SEVERITIES } from "./alerts.js";

const INDICATOR_TYPES = [
  "FileSha1",
  "FileSha256",
  "FileMd5",
  "CertificateThumbprint",
  "IpAddress",
  "DomainName",
  "Url",
] as const;
const INDICATOR_ACTIONS = ["Warn", "Block", "Audit", "Alert", "AlertAndBlock", "BlockAndRemediate", "Allowed"] as const;
const FILE_TYPES = ["FileSha1", "FileSha256", "FileMd5", "CertificateThumbprint"];

interface IndicatorInput {
  tenantId: string;
  clientId: string;
  body: Body;
}

function validateValue(type: IndicatorType, value: string): void {
  const rules: Partial<Record<IndicatorType, RegExp>> = {
    FileSha1: /^[0-9a-f]{40}$/i,
    FileSha256: /^[0-9a-f]{64}$/i,
    FileMd5: /^[0-9a-f]{32}$/i,
    IpAddress: /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]+$/i,
  };
  const rule = rules[type];
  if (rule && !rule.test(value))
    throw badRequest(`indicatorValue '${value}' is not a valid ${type}`, "InvalidParameter");
}

export function upsertIndicator(ds: DefStore, input: IndicatorInput): { indicator: DefIndicator; created: boolean } {
  const { body, tenantId, clientId } = input;
  const value = str(field(body, "indicatorValue"))?.trim();
  if (!value) throw badRequest("indicatorValue is required", "MissingParameter");
  const type = oneOf(field(body, "indicatorType"), INDICATOR_TYPES, "indicatorType");
  if (!type) throw badRequest("indicatorType is required", "MissingParameter");
  const action = oneOf(field(body, "action"), INDICATOR_ACTIONS, "action");
  if (!action) throw badRequest("action is required", "MissingParameter");
  const title = str(field(body, "title"))?.trim();
  if (!title) throw badRequest("title is required", "MissingParameter");
  const description = str(field(body, "description"))?.trim();
  if (!description) throw badRequest("description is required", "MissingParameter");
  validateValue(type as IndicatorType, value);
  const expiration = str(field(body, "expirationTime"));
  if (expiration && Number.isNaN(Date.parse(expiration)))
    throw badRequest("expirationTime must be an ISO 8601 date", "InvalidParameter");
  const generateAlert =
    bool(field(body, "generateAlert")) ?? ["Alert", "AlertAndBlock", "Warn", "Block"].includes(action);
  const now = nowIso();
  const existing = tenantRows(ds.indicators.findBy("indicatorValue", value), tenantId).find(
    (candidate) => candidate.indicatorType === type,
  );
  const fields = {
    indicatorValue: value,
    indicatorType: type as IndicatorType,
    action: action as IndicatorAction,
    application: strOrNull(field(body, "application")),
    expirationTime: expiration ? new Date(expiration).toISOString() : null,
    lastUpdateTime: now,
    lastUpdatedBy: clientId,
    severity: (oneOf(field(body, "severity"), ALERT_SEVERITIES, "severity") ?? "Informational") as AlertSeverity,
    title,
    description,
    recommendedActions: strOrNull(field(body, "recommendedActions")),
    rbacGroupNames: stringArray(field(body, "rbacGroupNames")) ?? [],
    rbacGroupIds: (stringArray(field(body, "rbacGroupIds")) ?? []).map(Number).filter(Number.isFinite),
    generateAlert,
    mitreTechniques: stringArray(field(body, "mitreTechniques")) ?? [],
    category: num(field(body, "category")) ?? null,
    educateUrl: strOrNull(field(body, "educateUrl")),
    lookBackPeriod: num(field(body, "lookBackPeriod")) ?? null,
    historicalDetection: bool(field(body, "historicalDetection")) ?? false,
  };
  if (existing) {
    const updated = ds.indicators.update(existing.id, fields)!;
    logEvent(ds, tenantId, "indicator.updated", updated.indicator_id, { value, type, action });
    return { indicator: updated, created: false };
  }
  const indicator = ds.indicators.insert({
    tenant_id: tenantId,
    indicator_id: String(1000 + ds.indicators.count()),
    source: str(field(body, "source")) ?? "PublicApi",
    sourceType: "AadApp",
    createdBy: clientId,
    createdBySource: "PublicApi",
    createdByDisplayName: str(field(body, "createdByDisplayName")) ?? "Emulate app",
    creationTimeDateTimeUtc: now,
    certificateInfo:
      FILE_TYPES.includes(type) && type === "CertificateThumbprint"
        ? { issuer: "Emulate CA", serial: guid(), subject: value, sha256: null }
        : null,
    version: null,
    ...fields,
  });
  logEvent(ds, tenantId, "indicator.created", indicator.indicator_id, { value, type, action });
  return { indicator, created: true };
}

export function indicatorRoutes(rc: DefRouteContext): void {
  const { app, ds, baseUrl } = rc;

  route(
    app,
    "get",
    "/api/indicators",
    api(ds, (c, auth) =>
      odataCollection(
        c,
        baseUrl,
        "Indicators",
        tenantRows(ds.indicators.all(), auth.tenantId).map(formatIndicator),
        odataOptions(c),
      ),
    ),
  );

  route(
    app,
    "post",
    "/api/indicators",
    api(ds, async (c, auth) => {
      const body = await parseJsonBody(c);
      const { indicator, created } = upsertIndicator(ds, {
        tenantId: auth.tenantId,
        clientId: auth.token.client_id,
        body,
      });
      if (created) c.status(201);
      return odataEntity(c, baseUrl, "Indicators", formatIndicator(indicator));
    }),
  );

  route(
    app,
    "post",
    "/api/indicators/import",
    api(ds, async (c, auth) => {
      const body = await parseJsonBody(c);
      const entries = field(body, "Indicators");
      if (!Array.isArray(entries) || entries.length === 0)
        throw badRequest("Indicators must contain at least one indicator", "InvalidParameter");
      if (entries.length > 500) throw badRequest("A single import supports at most 500 indicators", "InvalidParameter");
      const results = entries.map((entry) => {
        const item = (entry && typeof entry === "object" ? entry : {}) as Body;
        try {
          const { indicator } = upsertIndicator(ds, {
            tenantId: auth.tenantId,
            clientId: auth.token.client_id,
            body: item,
          });
          return {
            id: indicator.indicator_id,
            indicator: indicator.indicatorValue,
            isFailed: false,
            failureReason: null,
          };
        } catch (error) {
          return {
            id: null,
            indicator: str(field(item, "indicatorValue")) ?? null,
            isFailed: true,
            failureReason: error instanceof Error ? error.message : "Invalid indicator",
          };
        }
      });
      return c.json({
        "@odata.context": `${baseUrl}/api/$metadata#Collection(microsoft.windowsDefenderATP.api.ImportTiIndicatorResult)`,
        value: results,
      });
    }),
  );

  route(
    app,
    "get",
    "/api/indicators/:id",
    api(ds, (c, auth) =>
      odataEntity(c, baseUrl, "Indicators", formatIndicator(findIndicator(ds, auth.tenantId, c.req.param("id")))),
    ),
  );

  route(
    app,
    "delete",
    "/api/indicators/:id",
    api(ds, (c, auth) => {
      const indicator = findIndicator(ds, auth.tenantId, c.req.param("id"));
      ds.indicators.delete(indicator.id);
      logEvent(ds, auth.tenantId, "indicator.deleted", indicator.indicator_id, { value: indicator.indicatorValue });
      return c.body(null, 204);
    }),
  );

  route(
    app,
    "delete",
    "/api/indicators",
    api(ds, async (c, auth) => {
      const body = await parseJsonBody(c);
      const ids = stringArray(field(body, "IndicatorIds")) ?? [];
      if (ids.length === 0) throw badRequest("IndicatorIds must contain at least one indicator id", "InvalidParameter");
      const results = ids.map((id) => {
        const indicator = tenantRows(ds.indicators.findBy("indicator_id", id), auth.tenantId)[0];
        if (!indicator) return { id, isFailed: true, failureReason: "Indicator not found" };
        ds.indicators.delete(indicator.id);
        return { id, isFailed: false, failureReason: null };
      });
      return c.json({
        "@odata.context": `${baseUrl}/api/$metadata#Collection(microsoft.windowsDefenderATP.api.DeleteTiIndicatorResult)`,
        value: results,
      });
    }),
  );
}
