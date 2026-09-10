import type { AppEnv, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import type { AgentStatus } from "./entities.js";
import { guid, token, type Json } from "./helpers.js";
import { createAgentPolicy, createPackagePolicy, fleetRoutes } from "./routes/fleet.js";
import { inspectorRoutes } from "./routes/inspector.js";
import { enrollAgent, miscRoutes } from "./routes/misc.js";
import { ensureIndex, indexDocument, searchRoutes } from "./routes/search.js";
import { getEsStore, logEvent, setAgentVersions, setCluster, type EsCluster, type EsStore } from "./store.js";

export { getEsStore, type EsStore } from "./store.js";
export * from "./entities.js";
export { matchesQuery, runAggregations } from "./query.js";
export { enrollAgent, type EnrollAgentInput } from "./routes/misc.js";

export interface ElasticSeedConfig {
  port?: number;
  baseUrl?: string;
  cluster?: Partial<EsCluster>;
  api_keys?: Array<{ id?: string; api_key: string; name?: string }>;
  agent_versions?: string[];
  fleet_server_hosts?: Array<{ id?: string; name: string; host_urls: string[]; is_default?: boolean }>;
  agent_policies?: Array<{
    id?: string;
    name: string;
    description?: string;
    namespace?: string;
    monitoring_enabled?: string[];
    global_data_tags?: Array<{ name: string; value: string }>;
    enrollment_token?: string;
    sys_monitoring?: boolean;
    package_policies?: Array<{
      id?: string;
      name: string;
      package: string;
      version?: string;
      description?: string;
      enabled?: boolean;
      inputs?: unknown;
      vars?: Record<string, unknown>;
    }>;
    agents?: Array<{
      id?: string;
      hostname: string;
      os?: "windows" | "linux" | "darwin";
      version?: string;
      status?: AgentStatus;
      ip?: string[];
      tags?: string[];
      last_checkin?: string;
    }>;
  }>;
  indices?: Array<{
    name: string;
    aliases?: string[];
    mappings?: Record<string, unknown>;
    documents?: Array<Record<string, unknown>>;
  }>;
}

export const DEFAULT_API_KEY_ID = "emulate-elastic-key";
export const DEFAULT_API_KEY = "test_emulate_elastic_api_key";
export const DEFAULT_ENCODED_API_KEY = Buffer.from(`${DEFAULT_API_KEY_ID}:${DEFAULT_API_KEY}`).toString("base64");
export const DEFAULT_FLEET_SERVER_HOST_ID = "fleet-default-fleet-server-host";
export const DEFAULT_POLICY_IDS = [
  "00000000-0000-4000-8000-00000000e001",
  "00000000-0000-4000-8000-00000000e002",
  "00000000-0000-4000-8000-00000000e003",
  "00000000-0000-4000-8000-00000000e004",
  "00000000-0000-4000-8000-00000000e005",
] as const;
export const DEFAULT_ENROLLMENT_TOKEN = "emulate-enrollment-token-pool-1";
export const DEFAULT_STATUS_INDEX = "services-monitoring";
export const DEFAULT_O365_INDEX = "logs-o365.audit-default";
export const DEFAULT_FIREWALL_INDEX = "logs-firewall.log-default";
export const DEFAULT_CUSTOMER_NAMESPACE = "nimbus-msp__acme-corp";
export const DEFAULT_O365_INTEGRATION_ID = "00000000-0000-4000-8000-00000000f001";
export const DEFAULT_DEFENDER_INTEGRATION_ID = "00000000-0000-4000-8000-00000000f002";

const DAY = 86400000;
const ago = (days: number, hours = 0) => new Date(Date.now() - days * DAY - hours * 3600000).toISOString();

function o365Docs(): Array<Record<string, unknown>> {
  const users = [
    "alice@acme-corp.example",
    "bob@acme-corp.example",
    "carol@acme-corp.example",
    "dave@acme-corp.example",
    "admin@acmecorp.onmicrosoft.com",
  ];
  const operations = ["UserLoggedIn", "FileAccessed", "MailItemsAccessed", "Set-Mailbox", "UserLoginFailed"];
  return users.flatMap((email, userIndex) =>
    operations.slice(0, 3 + (userIndex % 3)).map((operation, index) => ({
      "@timestamp": ago(index + userIndex, 3),
      event: {
        action: operation,
        category: ["authentication"],
        outcome: operation === "UserLoginFailed" ? "failure" : "success",
        dataset: "o365.audit",
      },
      user: { email, name: email.split("@")[0], domain: email.split("@")[1], id: `user-${userIndex}` },
      source: { ip: `203.0.113.${10 + userIndex}` },
      o365: {
        audit: {
          Operation: operation,
          Workload: operation.startsWith("Mail") || operation.startsWith("Set") ? "Exchange" : "AzureActiveDirectory",
          ResultStatus: operation === "UserLoginFailed" ? "Failed" : "Succeeded",
        },
      },
      cyna: {
        msp__customer: DEFAULT_CUSTOMER_NAMESPACE,
        msp: "Nimbus MSP",
        customer: "Acme Corp",
        customerId: "11111111-1111-4111-8111-111111111111",
      },
      client_countries: ["France"],
    })),
  );
}

function firewallDocs(): Array<Record<string, unknown>> {
  const devices = [
    { tech: "fortinet", serial: "FGT60F0000000001", hostname: "fw-paris-01" },
    { tech: "fortinet", serial: "FGT60F0000000002", hostname: "fw-lyon-01" },
    { tech: "stormshield", serial: "SN310A00000000A1", hostname: "sns-nantes-01" },
  ];
  const rows: Array<Record<string, unknown>> = devices.flatMap((device, deviceIndex) =>
    Array.from({ length: 4 }, (_, index) => ({
      "@timestamp": ago(index + deviceIndex, 6),
      event: { action: index % 2 === 0 ? "deny" : "accept", category: ["network"], dataset: `${device.tech}.firewall` },
      observer: {
        vendor: device.tech,
        serial_number: device.serial,
        hostname: device.hostname,
        product: device.tech === "fortinet" ? "FortiGate" : "SNS",
      },
      source: { ip: `192.168.${deviceIndex}.${index + 10}`, port: 50000 + index },
      destination: { ip: "198.51.100.7", port: [443, 80, 22, 53][index] },
      network: { transport: index === 3 ? "udp" : "tcp" },
      cyna: {
        msp__customer: DEFAULT_CUSTOMER_NAMESPACE,
        msp: "Nimbus MSP",
        customer: "Acme Corp",
        firewall_tech: device.tech,
        firewall_identifier: device.serial,
      },
    })),
  );
  rows.push({
    "@timestamp": ago(1),
    event: { dataset: "firewall.unknown" },
    cyna: { msp__customer: DEFAULT_CUSTOMER_NAMESPACE, firewall_identifier: "UNKNOWN-0001" },
    error: { message: "Unable to parse syslog line" },
    "cyna.parse_error": true,
  });
  return rows;
}

export const DEFAULT_SEED: ElasticSeedConfig = {
  cluster: { name: "emulate-cluster" },
  api_keys: [{ id: DEFAULT_API_KEY_ID, api_key: DEFAULT_API_KEY, name: "emulate" }],
  fleet_server_hosts: [
    {
      id: DEFAULT_FLEET_SERVER_HOST_ID,
      name: "Default",
      host_urls: ["https://fleet.emulate.local:8220"],
      is_default: true,
    },
  ],
  agent_policies: [
    ...DEFAULT_POLICY_IDS.map((id, index) => ({
      id,
      name: `Cyna SOC collectors ${index + 1}`,
      description: "Pooled agent policy for hosted integrations",
      namespace: "default",
      monitoring_enabled: ["logs", "traces"],
      enrollment_token: index === 0 ? DEFAULT_ENROLLMENT_TOKEN : undefined,
      package_policies:
        index === 0
          ? [
              {
                id: DEFAULT_O365_INTEGRATION_ID,
                name: "O365_ACME-CORP",
                package: "o365",
                version: "3.8.1",
                inputs: {
                  "o365-cel": {
                    enabled: true,
                    streams: {
                      "o365.audit": {
                        enabled: true,
                        vars: {
                          azure_tenant_id: "00000000-0000-4000-8000-00000000c0de",
                          interval: "3m",
                          tags: ["acme-corp"],
                        },
                      },
                    },
                  },
                },
              },
              {
                id: DEFAULT_DEFENDER_INTEGRATION_ID,
                name: "MS365_DEFENDER_ACME-CORP",
                package: "m365_defender",
                version: "3.5.0",
                inputs: {
                  "m365_defender-httpjson": {
                    enabled: true,
                    vars: { tenant_id: "00000000-0000-4000-8000-00000000c0de" },
                    streams: { "m365_defender.alert": { enabled: true }, "m365_defender.incident": { enabled: true } },
                  },
                },
              },
            ]
          : [],
      agents:
        index === 0
          ? [
              { hostname: "soc-collector-01", os: "linux" as const, status: "online" as AgentStatus },
              { hostname: "soc-collector-02", os: "linux" as const, status: "online" as AgentStatus },
            ]
          : [],
    })),
    {
      id: "00000000-0000-4000-8000-00000000e101",
      name: "ACME-CORP Active Directory",
      description: "Domain controllers",
      namespace: "acme-corp",
      global_data_tags: [{ name: "cyna.customer", value: "Acme Corp" }],
      enrollment_token: "emulate-enrollment-token-acme-ad",
      package_policies: [
        {
          name: "system-event-log-ACME-CORP",
          package: "system",
          version: "2.9.1",
          inputs: [
            {
              type: "winlog",
              policy_template: "system",
              enabled: true,
              streams: [{ enabled: true, data_stream: { type: "logs", dataset: "system.security" } }],
            },
          ],
        },
      ],
      agents: [
        { hostname: "ACME-DC-01", os: "windows", status: "online" },
        { hostname: "ACME-DC-02", os: "windows", status: "degraded", last_checkin: ago(0, 2) },
      ],
    },
  ],
  indices: [
    {
      name: DEFAULT_STATUS_INDEX,
      mappings: {
        properties: {
          "@timestamp": { type: "date" },
          integration_id: { type: "keyword" },
          service: { type: "keyword" },
          status: { type: "keyword" },
          namespace: { type: "keyword" },
          latest_log: { type: "date" },
        },
      },
      documents: [
        {
          "@timestamp": ago(0, 1),
          integration_id: DEFAULT_O365_INTEGRATION_ID,
          service: "o365",
          status: "operational",
          namespace: DEFAULT_CUSTOMER_NAMESPACE,
          latest_log: ago(0, 1),
        },
        {
          "@timestamp": ago(1),
          integration_id: DEFAULT_O365_INTEGRATION_ID,
          service: "o365",
          status: "integration_in_progress",
          namespace: DEFAULT_CUSTOMER_NAMESPACE,
          latest_log: ago(1),
        },
        {
          "@timestamp": ago(0, 2),
          integration_id: DEFAULT_DEFENDER_INTEGRATION_ID,
          service: "m365_defender",
          status: "consent_required",
          namespace: DEFAULT_CUSTOMER_NAMESPACE,
          latest_log: ago(0, 2),
        },
        {
          "@timestamp": ago(0, 3),
          integration_id: "00000000-0000-4000-8000-00000000e101",
          service: "system",
          status: "log_reception_error",
          namespace: "acme-corp",
          latest_log: ago(2),
        },
        {
          "@timestamp": ago(0, 4),
          integration_id: "2250000000000000101",
          service: "sentinel_one",
          status: "operational",
          namespace: DEFAULT_CUSTOMER_NAMESPACE,
          latest_log: ago(0, 4),
        },
      ],
    },
    {
      name: DEFAULT_O365_INDEX,
      aliases: ["logs-o365.audit"],
      mappings: {
        properties: {
          "@timestamp": { type: "date" },
          "user.email": { type: "keyword" },
          "user.domain": { type: "keyword" },
          "cyna.msp__customer": { type: "keyword" },
        },
      },
      documents: o365Docs(),
    },
    {
      name: DEFAULT_FIREWALL_INDEX,
      aliases: ["logs-firewall.log"],
      mappings: {
        properties: {
          "@timestamp": { type: "date" },
          "cyna.firewall_tech": { type: "keyword" },
          "cyna.firewall_identifier": { type: "keyword" },
          "observer.serial_number": { type: "keyword" },
        },
      },
      documents: firewallDocs(),
    },
  ],
};

export function seedFromConfig(
  store: Store,
  _baseUrl: string,
  config: ElasticSeedConfig,
  _webhooks?: WebhookDispatcher,
): void {
  const es = getEsStore(store);
  if (config.cluster) setCluster(es, config.cluster);
  if (config.agent_versions) setAgentVersions(es, config.agent_versions);
  for (const entry of config.api_keys ?? []) {
    if (!entry.api_key || es.apiKeys.findOneBy("api_key", entry.api_key)) continue;
    es.apiKeys.insert({ key_id: entry.id ?? token(12), api_key: entry.api_key, name: entry.name ?? "elastic" });
  }
  if (es.apiKeys.count() === 0)
    es.apiKeys.insert({ key_id: DEFAULT_API_KEY_ID, api_key: DEFAULT_API_KEY, name: "emulate" });
  for (const entry of config.fleet_server_hosts ?? []) {
    if (
      (entry.id && es.fleetServerHosts.findOneBy("host_id", entry.id)) ||
      es.fleetServerHosts.all().some((host) => host.name === entry.name)
    )
      continue;
    es.fleetServerHosts.insert({
      host_id: entry.id ?? guid(),
      name: entry.name,
      is_default: entry.is_default ?? es.fleetServerHosts.count() === 0,
      host_urls: entry.host_urls,
      is_preconfigured: true,
    });
  }
  if (es.fleetServerHosts.count() === 0)
    es.fleetServerHosts.insert({
      host_id: DEFAULT_FLEET_SERVER_HOST_ID,
      name: "Default",
      is_default: true,
      host_urls: ["https://fleet.emulate.local:8220"],
      is_preconfigured: true,
    });
  for (const entry of config.agent_policies ?? []) {
    const existing =
      (entry.id && es.agentPolicies.findOneBy("policy_id", entry.id)) || es.agentPolicies.findOneBy("name", entry.name);
    const policy =
      existing ??
      createAgentPolicy(es, {
        id: entry.id,
        name: entry.name,
        description: entry.description,
        namespace: entry.namespace,
        monitoring_enabled: entry.monitoring_enabled,
        global_data_tags: entry.global_data_tags,
        sysMonitoring: entry.sys_monitoring ?? false,
      });
    if (entry.enrollment_token && !es.enrollmentKeys.findOneBy("api_key", entry.enrollment_token)) {
      const defaultKey = es.enrollmentKeys.findBy("policy_id", policy.policy_id)[0];
      if (defaultKey) es.enrollmentKeys.update(defaultKey.id, { api_key: entry.enrollment_token });
      else
        es.enrollmentKeys.insert({
          key_id: guid(),
          api_key_id: token(15),
          api_key: entry.enrollment_token,
          name: `Default (${policy.policy_id.slice(0, 8)})`,
          policy_id: policy.policy_id,
          active: true,
          hidden: false,
        });
    }
    for (const packageEntry of entry.package_policies ?? []) {
      if (
        (packageEntry.id && es.packagePolicies.findOneBy("package_policy_id", packageEntry.id)) ||
        es.packagePolicies.findOneBy("name", packageEntry.name)
      )
        continue;
      createPackagePolicy(es, {
        id: packageEntry.id,
        name: packageEntry.name,
        description: packageEntry.description ?? "",
        policy_id: policy.policy_id,
        enabled: packageEntry.enabled ?? true,
        package: { name: packageEntry.package, version: packageEntry.version ?? "1.0.0" },
        inputs: packageEntry.inputs ?? [],
        vars: packageEntry.vars ?? {},
      });
    }
    for (const agentEntry of entry.agents ?? []) {
      if (
        (agentEntry.id && es.agents.findOneBy("agent_id", agentEntry.id)) ||
        es.agents.findOneBy("hostname", agentEntry.hostname)
      )
        continue;
      enrollAgent(es, {
        id: agentEntry.id,
        policyId: policy.policy_id,
        hostname: agentEntry.hostname,
        os: agentEntry.os,
        version: agentEntry.version,
        status: agentEntry.status,
        ip: agentEntry.ip,
        tags: agentEntry.tags,
        lastCheckin: agentEntry.last_checkin,
      });
    }
  }
  for (const entry of config.indices ?? []) {
    ensureIndex(es, entry.name);
    const index = es.indices.findOneBy("name", entry.name)!;
    if (entry.aliases || entry.mappings)
      es.indices.update(index.id, {
        aliases: entry.aliases ?? index.aliases,
        mappings: entry.mappings ?? index.mappings,
      });
    if (es.documents.findBy("index", entry.name).length === 0)
      for (const document of entry.documents ?? [])
        indexDocument(es, entry.name, document as Json, typeof document._id === "string" ? document._id : undefined);
  }
  logEvent(es, "seed.applied", "config", {
    agentPolicies: es.agentPolicies.count(),
    packagePolicies: es.packagePolicies.count(),
    agents: es.agents.count(),
    indices: es.indices.count(),
    documents: es.documents.count(),
  });
}

export const elasticPlugin: ServicePlugin = {
  name: "elastic",
  register(app: Hono<AppEnv>, store: Store, _webhooks: WebhookDispatcher, baseUrl: string, _tokenMap?: TokenMap): void {
    const es: EsStore = getEsStore(store);
    inspectorRoutes(app, es, baseUrl);
    miscRoutes(app, es);
    fleetRoutes(app, es);
    searchRoutes(app, es);
  },
  seed(store: Store, baseUrl: string): void {
    seedFromConfig(store, baseUrl, DEFAULT_SEED);
  },
};

export default elasticPlugin;
