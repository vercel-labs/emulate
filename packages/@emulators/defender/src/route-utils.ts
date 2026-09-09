import type { AppEnv, Hono } from "@emulators/core";
import type {
  DefAlert,
  DefIndicator,
  DefInvestigation,
  DefMachine,
  DefMachineAction,
  MachineActionType,
  DefRecommendation,
  DefSoftware,
  DefVulnerability,
  MachineActionStatus,
} from "./entities.js";
import type { Fmt } from "./formatters.js";
import { liveActionStatus } from "./formatters.js";
import { conflict, guid, notFound, nowIso } from "./helpers.js";
import { logEvent, type DefStore } from "./store.js";

export interface DefRouteContext {
  app: Hono<AppEnv>;
  ds: DefStore;
  fmt: Fmt;
  baseUrl: string;
}

export function tenantRows<T extends { tenant_id: string }>(rows: T[], tenantId: string): T[] {
  return rows.filter((row) => row.tenant_id === tenantId);
}

export function findMachine(ds: DefStore, tenantId: string, id: string): DefMachine {
  const machine = ds.machines.findBy("machine_id", id).find((candidate) => candidate.tenant_id === tenantId);
  if (!machine) throw notFound(`Machine ${id} was not found`, "ResourceNotFound");
  return machine;
}

export function findAlert(ds: DefStore, tenantId: string, id: string): DefAlert {
  const alert = ds.alerts.findBy("alert_id", id).find((candidate) => candidate.tenant_id === tenantId);
  if (!alert) throw notFound(`Alert ${id} was not found`, "ResourceNotFound");
  return alert;
}

export function findAction(ds: DefStore, tenantId: string, id: string): DefMachineAction {
  const action = ds.actions.findBy("action_id", id).find((candidate) => candidate.tenant_id === tenantId);
  if (!action) throw notFound(`Machine action ${id} was not found`, "ResourceNotFound");
  return action;
}

export function findVulnerability(ds: DefStore, tenantId: string, id: string): DefVulnerability {
  const vulnerability =
    ds.vulnerabilities.findBy("cve_id", id).find((candidate) => candidate.tenant_id === tenantId) ??
    ds.vulnerabilities
      .all()
      .find((candidate) => candidate.tenant_id === tenantId && candidate.cve_id.toLowerCase() === id.toLowerCase());
  if (!vulnerability) throw notFound(`Vulnerability ${id} was not found`, "ResourceNotFound");
  return vulnerability;
}

export function findSoftware(ds: DefStore, tenantId: string, id: string): DefSoftware {
  const software = ds.software.findBy("software_id", id).find((candidate) => candidate.tenant_id === tenantId);
  if (!software) throw notFound(`Software ${id} was not found`, "ResourceNotFound");
  return software;
}

export function findRecommendation(ds: DefStore, tenantId: string, id: string): DefRecommendation {
  const recommendation = ds.recommendations
    .findBy("recommendation_id", id)
    .find((candidate) => candidate.tenant_id === tenantId);
  if (!recommendation) throw notFound(`Recommendation ${id} was not found`, "ResourceNotFound");
  return recommendation;
}

export function findIndicator(ds: DefStore, tenantId: string, id: string): DefIndicator {
  const indicator = ds.indicators.findBy("indicator_id", id).find((candidate) => candidate.tenant_id === tenantId);
  if (!indicator) throw notFound(`Indicator ${id} was not found`, "ResourceNotFound");
  return indicator;
}

export function findInvestigation(ds: DefStore, tenantId: string, id: string): DefInvestigation {
  const investigation = ds.investigations
    .findBy("investigation_id", id)
    .find((candidate) => candidate.tenant_id === tenantId);
  if (!investigation) throw notFound(`Investigation ${id} was not found`, "ResourceNotFound");
  return investigation;
}

export type ActionKind = MachineActionType;

export interface CreateActionInput {
  type: ActionKind;
  machine: DefMachine;
  requestor: string;
  comment: string;
  title?: string | null;
  scope?: string | null;
  externalId?: string | null;
  relatedFileInfo?: DefMachineAction["relatedFileInfo"];
  commands?: DefMachineAction["commands"];
  initialStatus?: MachineActionStatus;
  frozen?: boolean;
}

export function createMachineAction(ds: DefStore, input: CreateActionInput): DefMachineAction {
  const active = ds.actions
    .findBy("machine_id", input.machine.machine_id)
    .filter((candidate) => candidate.tenant_id === input.machine.tenant_id && candidate.type === input.type)
    .find((candidate) => ["Pending", "InProgress"].includes(liveActionStatus(ds, candidate)));
  if (active)
    throw conflict(
      `An active ${input.type} request already exists for machine ${input.machine.machine_id} (action ${active.action_id})`,
    );
  const now = nowIso();
  const action = ds.actions.insert({
    tenant_id: input.machine.tenant_id,
    action_id: guid(),
    type: input.type,
    title: input.title ?? null,
    requestor: input.requestor,
    requestorComment: input.comment,
    status: input.initialStatus ?? "Pending",
    machine_id: input.machine.machine_id,
    computerDnsName: input.machine.computerDnsName,
    creationDateTimeUtc: now,
    lastUpdateDateTimeUtc: now,
    cancellationRequestor: null,
    cancellationComment: null,
    cancellationDateTimeUtc: null,
    scope: input.scope ?? null,
    externalId: input.externalId ?? null,
    requestSource: "PublicApi",
    relatedFileInfo: input.relatedFileInfo ?? null,
    commands: input.commands ?? [],
    troubleshootInfo: null,
    frozen: input.frozen ?? false,
  });
  logEvent(ds, action.tenant_id, "machine_action.created", action.action_id, {
    type: action.type,
    machine_id: action.machine_id,
    comment: action.requestorComment,
  });
  return action;
}
