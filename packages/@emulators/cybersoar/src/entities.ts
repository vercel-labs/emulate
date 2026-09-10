import type { Entity } from "@emulators/core";

export const CYBERSOAR_SERVICES = [
  "SENTINELONE",
  "MS365_DEFENDER",
  "SOPHOS",
  "MS365",
  "ACTIVE_DIRECTORY",
  "FIREWALL",
] as const;
export type CybersoarService = (typeof CYBERSOAR_SERVICES)[number];

export const CYBERSOAR_VERDICTS = ["NEW", "TP", "FP", "INDETERMINATE", "OTHER"] as const;
export type CybersoarVerdict = (typeof CYBERSOAR_VERDICTS)[number];

export const CYBERSOAR_STATUSES = ["WAITING_ANALYST", "CLOSED"] as const;
export type CybersoarStatus = (typeof CYBERSOAR_STATUSES)[number];

export const MAIL_SENT_TAG = "MAIL_SENT";

export interface CsApiKey extends Entity {
  api_key: string;
  name: string;
}

export interface CsCustomer extends Entity {
  customer_id: string;
  name: string;
  slug: string;
  msp: string;
  msp_slug: string;
  services: CybersoarService[];
}

export interface CsAlert extends Entity {
  alert_id: string;
  case_id: string;
  customer_id: string;
  customer: string;
  msp: string;
  namespaces: string[];
  created_at_iso: string;
  imported_at: string;
  first_import_at: string;
  ingest_at: string;
  closed_at: string | null;
  criticity: number;
  description: string;
  elastic_id: string;
  rule_id: string;
  rule_name: string;
  rule_runtime: string;
  service: CybersoarService;
  source_ref: string;
  status: CybersoarStatus;
  verdict: CybersoarVerdict;
  tags: string[];
  analyst: string | null;
}

export interface CsEventLog extends Entity {
  type: string;
  subject: string;
  detail: Record<string, unknown>;
}
