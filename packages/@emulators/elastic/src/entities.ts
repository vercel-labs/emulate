import type { Entity } from "@emulators/core";

export interface EsApiKey extends Entity {
  key_id: string;
  api_key: string;
  name: string;
}

export interface EsAgentPolicy extends Entity {
  policy_id: string;
  name: string;
  description: string;
  namespace: string;
  monitoring_enabled: string[];
  inactivity_timeout: number;
  is_protected: boolean;
  is_managed: boolean;
  is_default: boolean;
  global_data_tags: Array<{ name: string; value: string }>;
  revision: number;
  updated_by: string;
  status: "active" | "inactive";
  deleted: boolean;
}

export interface EsPackagePolicy extends Entity {
  package_policy_id: string;
  policy_id: string;
  policy_ids: string[];
  name: string;
  description: string;
  namespace: string;
  enabled: boolean;
  package_name: string;
  package_title: string;
  package_version: string;
  inputs: Array<Record<string, unknown>>;
  vars: Record<string, unknown>;
  revision: number;
  created_by: string;
  updated_by: string;
}

export interface EsEnrollmentKey extends Entity {
  key_id: string;
  api_key_id: string;
  api_key: string;
  name: string;
  policy_id: string;
  active: boolean;
  hidden: boolean;
}

export interface EsFleetServerHost extends Entity {
  host_id: string;
  name: string;
  is_default: boolean;
  host_urls: string[];
  is_preconfigured: boolean;
}

export type AgentStatus =
  | "online"
  | "offline"
  | "error"
  | "degraded"
  | "updating"
  | "enrolling"
  | "unenrolling"
  | "unenrolled"
  | "inactive"
  | "orphaned"
  | "uninstalled";

export interface EsAgent extends Entity {
  agent_id: string;
  policy_id: string;
  type: string;
  active: boolean;
  status: AgentStatus;
  enrolled_at: string;
  unenrolled_at: string | null;
  last_checkin: string;
  last_checkin_status: string;
  last_checkin_message: string;
  policy_revision: number;
  access_api_key_id: string;
  version: string;
  hostname: string;
  host_id: string;
  ip: string[];
  mac: string[];
  os_family: string;
  os_full: string;
  os_kernel: string;
  os_name: string;
  os_platform: string;
  os_version: string;
  architecture: string;
  tags: string[];
  unhealthy_reason: string[];
}

export interface EsIndex extends Entity {
  name: string;
  mappings: Record<string, unknown>;
  settings: Record<string, unknown>;
  aliases: string[];
}

export interface EsDocument extends Entity {
  index: string;
  doc_id: string;
  source: Record<string, unknown>;
  version: number;
}

export interface EsEventLog extends Entity {
  type: string;
  subject: string;
  detail: Record<string, unknown>;
}
