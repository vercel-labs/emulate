import { Store, type Collection } from "@emulators/core";
import type {
  DefAlert,
  DefApp,
  DefEventLog,
  DefIndicator,
  DefInvestigation,
  DefLogonUser,
  DefMachine,
  DefMachineAction,
  DefMachineSoftware,
  DefMachineVulnerability,
  DefRecommendation,
  DefSoftware,
  DefTenant,
  DefToken,
  DefVulnerability,
} from "./entities.js";

export interface DefStore {
  raw: Store;
  tenants: Collection<DefTenant>;
  apps: Collection<DefApp>;
  tokens: Collection<DefToken>;
  machines: Collection<DefMachine>;
  alerts: Collection<DefAlert>;
  actions: Collection<DefMachineAction>;
  vulnerabilities: Collection<DefVulnerability>;
  software: Collection<DefSoftware>;
  machineSoftware: Collection<DefMachineSoftware>;
  machineVulnerabilities: Collection<DefMachineVulnerability>;
  recommendations: Collection<DefRecommendation>;
  indicators: Collection<DefIndicator>;
  investigations: Collection<DefInvestigation>;
  logonUsers: Collection<DefLogonUser>;
  events: Collection<DefEventLog>;
}

export function getDefStore(store: Store): DefStore {
  return {
    raw: store,
    tenants: store.collection<DefTenant>("defender.tenants", ["tenant_id"]),
    apps: store.collection<DefApp>("defender.apps", ["client_id"]),
    tokens: store.collection<DefToken>("defender.tokens", ["token", "tenant_id"]),
    machines: store.collection<DefMachine>("defender.machines", ["tenant_id", "machine_id", "computerDnsName"]),
    alerts: store.collection<DefAlert>("defender.alerts", ["tenant_id", "alert_id", "machine_id"]),
    actions: store.collection<DefMachineAction>("defender.machine_actions", ["tenant_id", "action_id", "machine_id"]),
    vulnerabilities: store.collection<DefVulnerability>("defender.vulnerabilities", ["tenant_id", "cve_id"]),
    software: store.collection<DefSoftware>("defender.software", ["tenant_id", "software_id"]),
    machineSoftware: store.collection<DefMachineSoftware>("defender.machine_software", [
      "tenant_id",
      "machine_id",
      "software_id",
    ]),
    machineVulnerabilities: store.collection<DefMachineVulnerability>("defender.machine_vulnerabilities", [
      "tenant_id",
      "machine_id",
      "cve_id",
    ]),
    recommendations: store.collection<DefRecommendation>("defender.recommendations", [
      "tenant_id",
      "recommendation_id",
    ]),
    indicators: store.collection<DefIndicator>("defender.indicators", ["tenant_id", "indicator_id", "indicatorValue"]),
    investigations: store.collection<DefInvestigation>("defender.investigations", [
      "tenant_id",
      "investigation_id",
      "machine_id",
    ]),
    logonUsers: store.collection<DefLogonUser>("defender.logon_users", ["tenant_id", "machine_id", "user_id"]),
    events: store.collection<DefEventLog>("defender.events", ["tenant_id", "type"]),
  };
}

const ACTION_DELAYS_KEY = "defender.action_delays";

export interface ActionDelays {
  in_progress_after_ms: number;
  succeeded_after_ms: number;
}

export function actionDelays(ds: DefStore): ActionDelays {
  return ds.raw.getData<ActionDelays>(ACTION_DELAYS_KEY) ?? { in_progress_after_ms: 1000, succeeded_after_ms: 3000 };
}

export function setActionDelays(ds: DefStore, delays: ActionDelays): void {
  ds.raw.setData(ACTION_DELAYS_KEY, delays);
}

export function logEvent(
  ds: DefStore,
  tenantId: string,
  type: string,
  subject: string,
  detail: Record<string, unknown>,
): void {
  ds.events.insert({ tenant_id: tenantId, type, subject, detail });
  const all = ds.events.all();
  if (all.length > 1000) for (const stale of all.slice(0, all.length - 1000)) ds.events.delete(stale.id);
}
