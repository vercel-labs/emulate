import { Store, type Collection } from "@emulators/core";
import type {
  EsAgent,
  EsAgentPolicy,
  EsApiKey,
  EsDocument,
  EsEnrollmentKey,
  EsEventLog,
  EsFleetServerHost,
  EsIndex,
  EsPackagePolicy,
} from "./entities.js";

export interface EsStore {
  raw: Store;
  apiKeys: Collection<EsApiKey>;
  agentPolicies: Collection<EsAgentPolicy>;
  packagePolicies: Collection<EsPackagePolicy>;
  enrollmentKeys: Collection<EsEnrollmentKey>;
  fleetServerHosts: Collection<EsFleetServerHost>;
  agents: Collection<EsAgent>;
  indices: Collection<EsIndex>;
  documents: Collection<EsDocument>;
  events: Collection<EsEventLog>;
}

export function getEsStore(store: Store): EsStore {
  return {
    raw: store,
    apiKeys: store.collection<EsApiKey>("elastic.api_keys", ["key_id", "api_key"]),
    agentPolicies: store.collection<EsAgentPolicy>("elastic.agent_policies", ["policy_id", "name"]),
    packagePolicies: store.collection<EsPackagePolicy>("elastic.package_policies", [
      "package_policy_id",
      "policy_id",
      "name",
    ]),
    enrollmentKeys: store.collection<EsEnrollmentKey>("elastic.enrollment_keys", ["key_id", "policy_id", "api_key"]),
    fleetServerHosts: store.collection<EsFleetServerHost>("elastic.fleet_server_hosts", ["host_id"]),
    agents: store.collection<EsAgent>("elastic.agents", ["agent_id", "policy_id", "hostname"]),
    indices: store.collection<EsIndex>("elastic.indices", ["name"]),
    documents: store.collection<EsDocument>("elastic.documents", ["index", "doc_id"]),
    events: store.collection<EsEventLog>("elastic.events", ["type"]),
  };
}

const CLUSTER_KEY = "elastic.cluster";
const VERSIONS_KEY = "elastic.agent_versions";

export interface EsCluster {
  name: string;
  uuid: string;
  version: string;
  kibana_version: string;
}

export const DEFAULT_CLUSTER: EsCluster = {
  name: "emulate-cluster",
  uuid: "emulate-cluster-uuid-000000000001",
  version: "9.1.3",
  kibana_version: "9.1.3",
};
export const DEFAULT_AGENT_VERSIONS = ["9.1.3", "9.1.2", "9.1.0", "9.0.4", "8.19.3", "8.18.6", "8.17.9"];

export function cluster(es: EsStore): EsCluster {
  return es.raw.getData<EsCluster>(CLUSTER_KEY) ?? DEFAULT_CLUSTER;
}

export function setCluster(es: EsStore, value: Partial<EsCluster>): void {
  es.raw.setData(CLUSTER_KEY, { ...cluster(es), ...value });
}

export function agentVersions(es: EsStore): string[] {
  return es.raw.getData<string[]>(VERSIONS_KEY) ?? DEFAULT_AGENT_VERSIONS;
}

export function setAgentVersions(es: EsStore, versions: string[]): void {
  es.raw.setData(VERSIONS_KEY, versions);
}

export function logEvent(es: EsStore, type: string, subject: string, detail: Record<string, unknown>): void {
  es.events.insert({ type, subject, detail });
  const all = es.events.all();
  if (all.length > 1000) for (const stale of all.slice(0, all.length - 1000)) es.events.delete(stale.id);
}
