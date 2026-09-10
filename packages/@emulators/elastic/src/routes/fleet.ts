import type { AppEnv, Hono } from "@emulators/core";
import type { EsAgent, EsAgentPolicy, EsEnrollmentKey, EsPackagePolicy } from "../entities.js";
import {
  bool,
  fleetRoute,
  guid,
  kibana,
  kibanaBadRequest,
  kibanaConflict,
  kibanaNotFound,
  kueryMatches,
  num,
  obj,
  paginate,
  parseJsonBody,
  parseKuery,
  str,
  stringArray,
  token,
  type Body,
  type Json,
} from "../helpers.js";
import { agentVersions, cluster, logEvent, type EsStore } from "../store.js";

const PACKAGE_TITLES: Record<string, string> = {
  system: "System",
  o365: "Microsoft Office 365",
  m365_defender: "Microsoft Defender XDR",
  sentinel_one: "SentinelOne",
  elastic_agent: "Elastic Agent",
  fleet_server: "Fleet Server",
  windows: "Windows",
  endpoint: "Elastic Defend",
};

export function formatPackagePolicy(p: EsPackagePolicy): Json {
  return {
    id: p.package_policy_id,
    version: `WzE${p.revision}LDFd`,
    name: p.name,
    namespace: p.namespace,
    description: p.description,
    policy_id: p.policy_id,
    policy_ids: p.policy_ids,
    enabled: p.enabled,
    package: {
      name: p.package_name,
      title: p.package_title,
      version: p.package_version,
      requires_root: p.package_name === "system" || p.package_name === "endpoint",
      fips_compatible: true,
    },
    inputs: p.inputs,
    vars: p.vars,
    revision: p.revision,
    created_at: p.created_at,
    created_by: p.created_by,
    updated_at: p.updated_at,
    updated_by: p.updated_by,
    is_managed: false,
    secret_references: [],
    output_id: null,
  };
}

export function formatAgentPolicy(es: EsStore, policy: EsAgentPolicy, includePackagePolicies = true): Json {
  const agents = es.agents.findBy("policy_id", policy.policy_id).filter((agent) => agent.active);
  return {
    id: policy.policy_id,
    version: `WzE${policy.revision}LDFd`,
    space_ids: ["default"],
    name: policy.name,
    description: policy.description,
    namespace: policy.namespace,
    monitoring_enabled: policy.monitoring_enabled,
    inactivity_timeout: policy.inactivity_timeout,
    is_protected: policy.is_protected,
    is_managed: policy.is_managed,
    is_default: policy.is_default,
    is_default_fleet_server: false,
    is_preconfigured: false,
    schema_version: "1.1.1",
    status: policy.status,
    revision: policy.revision,
    updated_at: policy.updated_at,
    updated_by: policy.updated_by,
    global_data_tags: policy.global_data_tags,
    agents: agents.length,
    fips_agents: 0,
    unprivileged_agents: 0,
    keep_monitoring_alive: false,
    supports_agentless: false,
    ...(includePackagePolicies
      ? { package_policies: es.packagePolicies.findBy("policy_id", policy.policy_id).map(formatPackagePolicy) }
      : {}),
  };
}

export function formatEnrollmentKey(key: EsEnrollmentKey): Json {
  return {
    id: key.key_id,
    api_key_id: key.api_key_id,
    api_key: key.api_key,
    name: key.name,
    policy_id: key.policy_id,
    active: key.active,
    hidden: key.hidden,
    created_at: key.created_at,
  };
}

export function formatAgent(es: EsStore, agent: EsAgent): Json {
  const policy = es.agentPolicies.findOneBy("policy_id", agent.policy_id);
  return {
    id: agent.agent_id,
    type: agent.type,
    namespaces: [policy?.namespace ?? "default"],
    active: agent.active,
    enrolled_at: agent.enrolled_at,
    unenrolled_at: agent.unenrolled_at,
    access_api_key_id: agent.access_api_key_id,
    policy_id: agent.policy_id,
    last_checkin: agent.last_checkin,
    last_checkin_status: agent.last_checkin_status,
    last_checkin_message: agent.last_checkin_message,
    policy_revision: agent.policy_revision,
    sort: [Date.parse(agent.enrolled_at), agent.agent_id],
    outputs: { default: { api_key_id: agent.access_api_key_id, type: "elasticsearch" } },
    components: [
      {
        id: "system/metrics-default",
        type: "system/metrics",
        status: agent.status === "online" ? "HEALTHY" : "DEGRADED",
        message: agent.status === "online" ? "Healthy" : "Degraded",
      },
    ],
    agent: { id: agent.agent_id, version: agent.version },
    local_metadata: {
      elastic: {
        agent: {
          id: agent.agent_id,
          version: agent.version,
          snapshot: false,
          upgradeable: true,
          log_level: "info",
          complete: false,
          unprivileged: false,
          "build.original": `${agent.version} (build: emulate)`,
        },
      },
      host: {
        architecture: agent.architecture,
        hostname: agent.hostname,
        id: agent.host_id,
        ip: agent.ip,
        mac: agent.mac,
        name: agent.hostname,
      },
      os: {
        family: agent.os_family,
        full: agent.os_full,
        kernel: agent.os_kernel,
        name: agent.os_name,
        platform: agent.os_platform,
        version: agent.os_version,
      },
    },
    tags: agent.tags,
    unhealthy_reason: agent.unhealthy_reason,
    last_known_status: agent.status,
    status: agent.status,
    upgrade_details: null,
    upgraded_at: null,
    upgrade_started_at: null,
  };
}

function normalizeInputs(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>;
  const record = obj(raw);
  if (!record) return [];
  return Object.entries(record).map(([key, value]) => {
    const input = obj(value) ?? {};
    const [policyTemplate, type] = key.includes("-")
      ? [key.slice(0, key.indexOf("-")), key.slice(key.indexOf("-") + 1)]
      : [key, key];
    const streams = obj(input.streams) ?? {};
    return {
      type,
      policy_template: policyTemplate,
      enabled: input.enabled !== false,
      vars: Object.fromEntries(
        Object.entries(obj(input.vars) ?? {}).map(([name, varValue]) => [
          name,
          { value: varValue, type: typeof varValue === "boolean" ? "bool" : Array.isArray(varValue) ? "text" : "text" },
        ]),
      ),
      streams: Object.entries(streams).map(([dataset, streamValue]) => {
        const stream = obj(streamValue) ?? {};
        const [dataStreamPackage, ...restDataset] = dataset.split(".");
        return {
          enabled: stream.enabled !== false,
          data_stream: { type: "logs", dataset },
          vars: Object.fromEntries(
            Object.entries(obj(stream.vars) ?? {}).map(([name, varValue]) => [
              name,
              { value: varValue, type: typeof varValue === "boolean" ? "bool" : "text" },
            ]),
          ),
          release: "ga",
          package_dataset: `${dataStreamPackage}.${restDataset.join(".")}`,
        };
      }),
    };
  });
}

export function createAgentPolicy(
  es: EsStore,
  input: {
    name: string;
    description?: string;
    namespace?: string;
    monitoring_enabled?: string[];
    inactivity_timeout?: number;
    is_protected?: boolean;
    global_data_tags?: Array<{ name: string; value: string }>;
    sysMonitoring?: boolean;
    id?: string;
    is_default?: boolean;
  },
): EsAgentPolicy {
  const name = input.name.trim();
  if (!name)
    throw kibanaBadRequest("[request body.name]: value has length [0] but it must have a minimum length of [1].");
  if (es.agentPolicies.findOneBy("name", name))
    throw kibanaConflict(`An agent policy with the name '${name}' already exists.`);
  const policy = es.agentPolicies.insert({
    policy_id: input.id ?? guid(),
    name,
    description: input.description ?? "",
    namespace: input.namespace ?? "default",
    monitoring_enabled: input.monitoring_enabled ?? ["logs", "metrics"],
    inactivity_timeout: input.inactivity_timeout ?? 1209600,
    is_protected: input.is_protected ?? false,
    is_managed: false,
    is_default: input.is_default ?? false,
    global_data_tags: input.global_data_tags ?? [],
    revision: 1,
    updated_by: "emulate",
    status: "active",
    deleted: false,
  });
  es.enrollmentKeys.insert({
    key_id: guid(),
    api_key_id: token(15),
    api_key: token(48),
    name: `Default (${policy.policy_id.slice(0, 8)})`,
    policy_id: policy.policy_id,
    active: true,
    hidden: false,
  });
  if (input.sysMonitoring) {
    es.packagePolicies.insert({
      package_policy_id: guid(),
      policy_id: policy.policy_id,
      policy_ids: [policy.policy_id],
      name: `system-${es.packagePolicies.findBy("package_name", "system").length + 1}`,
      description: "",
      namespace: policy.namespace,
      enabled: true,
      package_name: "system",
      package_title: "System",
      package_version: "2.9.1",
      inputs: [
        {
          type: "logfile",
          policy_template: "system",
          enabled: true,
          streams: [
            { enabled: true, data_stream: { type: "logs", dataset: "system.auth" } },
            { enabled: true, data_stream: { type: "logs", dataset: "system.syslog" } },
          ],
        },
        {
          type: "system/metrics",
          policy_template: "system",
          enabled: true,
          streams: [{ enabled: true, data_stream: { type: "metrics", dataset: "system.cpu" } }],
        },
      ],
      vars: {},
      revision: 1,
      created_by: "emulate",
      updated_by: "emulate",
    });
  }
  logEvent(es, "agent_policy.created", policy.policy_id, {
    name: policy.name,
    sysMonitoring: input.sysMonitoring ?? false,
  });
  return policy;
}

export function createPackagePolicy(es: EsStore, body: Body): EsPackagePolicy {
  const name = str(body.name)?.trim();
  if (!name) throw kibanaBadRequest("[request body.name]: expected value of type [string] but got [undefined]");
  const policyIds = stringArray(body.policy_ids) ?? (str(body.policy_id) ? [String(body.policy_id)] : []);
  if (policyIds.length === 0)
    throw kibanaBadRequest("[request body.policy_id]: expected value of type [string] but got [undefined]");
  for (const policyId of policyIds)
    if (
      !es.agentPolicies.findOneBy("policy_id", policyId) ||
      es.agentPolicies.findOneBy("policy_id", policyId)!.deleted
    )
      throw kibanaNotFound(`Agent policy ${policyId} not found`);
  const pkg = obj(body.package);
  const packageName = str(pkg?.name);
  if (!packageName)
    throw kibanaBadRequest("[request body.package.name]: expected value of type [string] but got [undefined]");
  if (es.packagePolicies.findOneBy("name", name))
    throw kibanaConflict(
      `An integration policy with the name ${name} already exists. Please rename it or choose a different name.`,
    );
  const packagePolicy = es.packagePolicies.insert({
    package_policy_id: str(body.id) ?? guid(),
    policy_id: policyIds[0],
    policy_ids: policyIds,
    name,
    description: str(body.description) ?? "",
    namespace: str(body.namespace) ?? es.agentPolicies.findOneBy("policy_id", policyIds[0])?.namespace ?? "default",
    enabled: bool(body.enabled) ?? true,
    package_name: packageName,
    package_title: str(pkg?.title) ?? PACKAGE_TITLES[packageName] ?? packageName,
    package_version: str(pkg?.version) ?? "1.0.0",
    inputs: normalizeInputs(body.inputs),
    vars: obj(body.vars) ?? {},
    revision: 1,
    created_by: "emulate",
    updated_by: "emulate",
  });
  for (const policyId of policyIds) {
    const policy = es.agentPolicies.findOneBy("policy_id", policyId)!;
    es.agentPolicies.update(policy.id, { revision: policy.revision + 1 });
  }
  logEvent(es, "package_policy.created", packagePolicy.package_policy_id, {
    name,
    package: packageName,
    version: packagePolicy.package_version,
    policyIds,
  });
  return packagePolicy;
}

export function fleetRoutes(app: Hono<AppEnv>, es: EsStore): void {
  const findPolicy = (id: string) => {
    const policy = es.agentPolicies.findOneBy("policy_id", id);
    if (!policy || policy.deleted) throw kibanaNotFound(`Agent policy ${id} not found`);
    return policy;
  };
  const findPackagePolicy = (id: string) => {
    const packagePolicy = es.packagePolicies.findOneBy("package_policy_id", id);
    if (!packagePolicy) throw kibanaNotFound(`Package policy ${id} not found`);
    return packagePolicy;
  };
  const findAgent = (id: string) => {
    const agent = es.agents.findOneBy("agent_id", id);
    if (!agent) throw kibanaNotFound(`Agent ${id} not found`);
    return agent;
  };

  fleetRoute(
    app,
    "get",
    "/status",
    kibana(es, (c) =>
      c.json({
        name: "kibana",
        uuid: cluster(es).uuid,
        version: { number: cluster(es).kibana_version, build_hash: "emulate", build_number: 1, build_snapshot: false },
        status: { overall: { level: "available", summary: "All services are available" } },
      }),
    ),
  );

  fleetRoute(
    app,
    "get",
    "/fleet/agent_policies",
    kibana(es, (c) => {
      const clauses = parseKuery(c.req.query("kuery"));
      const rows = es.agentPolicies
        .all()
        .filter((policy) => !policy.deleted)
        .sort((a, b) => a.id - b.id)
        .map((policy) => formatAgentPolicy(es, policy, c.req.query("full") !== "false"))
        .filter((policy) => kueryMatches(policy, clauses));
      return c.json(paginate(c, rows));
    }),
  );

  fleetRoute(
    app,
    "post",
    "/fleet/agent_policies",
    kibana(es, async (c) => {
      const body = await parseJsonBody(c);
      const name = str(body.name);
      if (!name) throw kibanaBadRequest("[request body.name]: expected value of type [string] but got [undefined]");
      const policy = createAgentPolicy(es, {
        name,
        description: str(body.description),
        namespace: str(body.namespace),
        monitoring_enabled: stringArray(body.monitoring_enabled),
        inactivity_timeout: num(body.inactivity_timeout),
        is_protected: bool(body.is_protected),
        global_data_tags: Array.isArray(body.global_data_tags)
          ? (body.global_data_tags as Array<{ name: string; value: string }>).map((tag) => ({
              name: String(tag.name),
              value: String(tag.value),
            }))
          : undefined,
        sysMonitoring: bool(c.req.query("sys_monitoring")) ?? false,
        id: str(body.id),
      });
      return c.json({ item: formatAgentPolicy(es, policy) });
    }),
  );

  fleetRoute(
    app,
    "get",
    "/fleet/agent_policies/:id",
    kibana(es, (c) => c.json({ item: formatAgentPolicy(es, findPolicy(c.req.param("id"))) })),
  );

  fleetRoute(
    app,
    "put",
    "/fleet/agent_policies/:id",
    kibana(es, async (c) => {
      const policy = findPolicy(c.req.param("id"));
      const body = await parseJsonBody(c);
      const name = str(body.name)?.trim();
      if (!name) throw kibanaBadRequest("[request body.name]: expected value of type [string] but got [undefined]");
      if (!str(body.namespace))
        throw kibanaBadRequest("[request body.namespace]: expected value of type [string] but got [undefined]");
      const clash = es.agentPolicies.findOneBy("name", name);
      if (clash && clash.id !== policy.id && !clash.deleted)
        throw kibanaConflict(`An agent policy with the name '${name}' already exists.`);
      const updated = es.agentPolicies.update(policy.id, {
        name,
        namespace: String(body.namespace),
        description: body.description !== undefined ? (str(body.description) ?? "") : policy.description,
        monitoring_enabled: stringArray(body.monitoring_enabled) ?? policy.monitoring_enabled,
        inactivity_timeout: num(body.inactivity_timeout) ?? policy.inactivity_timeout,
        is_protected: bool(body.is_protected) ?? policy.is_protected,
        global_data_tags: Array.isArray(body.global_data_tags)
          ? (body.global_data_tags as Array<{ name: string; value: string }>).map((tag) => ({
              name: String(tag.name),
              value: String(tag.value),
            }))
          : policy.global_data_tags,
        revision: policy.revision + 1,
      })!;
      logEvent(es, "agent_policy.updated", updated.policy_id, {
        name: updated.name,
        globalDataTags: updated.global_data_tags,
      });
      return c.json({ item: formatAgentPolicy(es, updated) });
    }),
  );

  fleetRoute(
    app,
    "post",
    "/fleet/agent_policies/delete",
    kibana(es, async (c) => {
      const body = await parseJsonBody(c);
      const policyId = str(body.agentPolicyId);
      if (!policyId)
        throw kibanaBadRequest("[request body.agentPolicyId]: expected value of type [string] but got [undefined]");
      const policy = findPolicy(policyId);
      const enrolled = es.agents.findBy("policy_id", policy.policy_id).filter((agent) => agent.active);
      if (enrolled.length > 0 && bool(body.force) !== true)
        throw kibanaBadRequest(`Cannot delete an agent policy that is assigned to any active or inactive agents`);
      for (const agent of enrolled)
        es.agents.update(agent.id, { active: false, status: "unenrolled", unenrolled_at: new Date().toISOString() });
      for (const packagePolicy of es.packagePolicies.findBy("policy_id", policy.policy_id))
        es.packagePolicies.delete(packagePolicy.id);
      for (const key of es.enrollmentKeys.findBy("policy_id", policy.policy_id))
        es.enrollmentKeys.update(key.id, { active: false });
      es.agentPolicies.update(policy.id, { deleted: true, status: "inactive" });
      logEvent(es, "agent_policy.deleted", policy.policy_id, { name: policy.name });
      return c.json({ id: policy.policy_id, name: policy.name });
    }),
  );

  fleetRoute(
    app,
    "delete",
    "/fleet/agent_policies/:id",
    kibana(es, (c) => {
      const policy = findPolicy(c.req.param("id"));
      es.agentPolicies.update(policy.id, { deleted: true, status: "inactive" });
      return c.json({ id: policy.policy_id, name: policy.name });
    }),
  );

  fleetRoute(
    app,
    "get",
    "/fleet/agent_policies/:id/full",
    kibana(es, (c) => {
      const policy = findPolicy(c.req.param("id"));
      return c.json({
        item: {
          id: policy.policy_id,
          revision: policy.revision,
          outputs: { default: { type: "elasticsearch", hosts: ["http://localhost:9200"] } },
          inputs: es.packagePolicies.findBy("policy_id", policy.policy_id).flatMap((packagePolicy) =>
            packagePolicy.inputs.map((input) => ({
              ...input,
              name: packagePolicy.name,
              package_policy_id: packagePolicy.package_policy_id,
            })),
          ),
          agent: {
            monitoring: {
              enabled: policy.monitoring_enabled.length > 0,
              namespace: policy.namespace,
              logs: policy.monitoring_enabled.includes("logs"),
              metrics: policy.monitoring_enabled.includes("metrics"),
            },
            protection: { enabled: policy.is_protected },
          },
        },
      });
    }),
  );

  fleetRoute(
    app,
    "get",
    "/fleet/package_policies",
    kibana(es, (c) => {
      const clauses = parseKuery(c.req.query("kuery"));
      const rows = es.packagePolicies
        .all()
        .sort((a, b) => a.id - b.id)
        .map(formatPackagePolicy)
        .filter((packagePolicy) => kueryMatches(packagePolicy, clauses));
      return c.json(paginate(c, rows));
    }),
  );

  fleetRoute(
    app,
    "post",
    "/fleet/package_policies",
    kibana(es, async (c) => {
      const body = await parseJsonBody(c);
      const packagePolicy = createPackagePolicy(es, body);
      return c.json({ item: formatPackagePolicy(packagePolicy) });
    }),
  );

  fleetRoute(
    app,
    "get",
    "/fleet/package_policies/:id",
    kibana(es, (c) => c.json({ item: formatPackagePolicy(findPackagePolicy(c.req.param("id"))) })),
  );

  fleetRoute(
    app,
    "put",
    "/fleet/package_policies/:id",
    kibana(es, async (c) => {
      const packagePolicy = findPackagePolicy(c.req.param("id"));
      const body = await parseJsonBody(c);
      const name = str(body.name)?.trim() ?? packagePolicy.name;
      const clash = es.packagePolicies.findOneBy("name", name);
      if (clash && clash.id !== packagePolicy.id)
        throw kibanaConflict(
          `An integration policy with the name ${name} already exists. Please rename it or choose a different name.`,
        );
      const policyIds =
        stringArray(body.policy_ids) ?? (str(body.policy_id) ? [String(body.policy_id)] : packagePolicy.policy_ids);
      for (const policyId of policyIds) findPolicy(policyId);
      const pkg = obj(body.package);
      const updated = es.packagePolicies.update(packagePolicy.id, {
        name,
        description: body.description !== undefined ? (str(body.description) ?? "") : packagePolicy.description,
        namespace: str(body.namespace) ?? packagePolicy.namespace,
        policy_id: policyIds[0],
        policy_ids: policyIds,
        enabled: bool(body.enabled) ?? packagePolicy.enabled,
        package_version: str(pkg?.version) ?? packagePolicy.package_version,
        inputs: body.inputs !== undefined ? normalizeInputs(body.inputs) : packagePolicy.inputs,
        vars: obj(body.vars) ?? packagePolicy.vars,
        revision: packagePolicy.revision + 1,
      })!;
      logEvent(es, "package_policy.updated", updated.package_policy_id, {
        name: updated.name,
        version: updated.package_version,
      });
      return c.json({ item: formatPackagePolicy(updated) });
    }),
  );

  fleetRoute(
    app,
    "delete",
    "/fleet/package_policies/:id",
    kibana(es, (c) => {
      const packagePolicy = findPackagePolicy(c.req.param("id"));
      es.packagePolicies.delete(packagePolicy.id);
      logEvent(es, "package_policy.deleted", packagePolicy.package_policy_id, {
        name: packagePolicy.name,
        package: packagePolicy.package_name,
      });
      return c.json({ id: packagePolicy.package_policy_id, name: packagePolicy.name, success: true });
    }),
  );

  fleetRoute(
    app,
    "post",
    "/fleet/package_policies/delete",
    kibana(es, async (c) => {
      const body = await parseJsonBody(c);
      const ids = stringArray(body.packagePolicyIds) ?? [];
      const results = ids.map((id) => {
        const packagePolicy = es.packagePolicies.findOneBy("package_policy_id", id);
        if (!packagePolicy)
          return { id, success: false, statusCode: 404, body: { message: `Package policy ${id} not found` } };
        es.packagePolicies.delete(packagePolicy.id);
        return { id, name: packagePolicy.name, success: true };
      });
      return c.json(results);
    }),
  );

  fleetRoute(
    app,
    "get",
    "/fleet/agents",
    kibana(es, (c) => {
      const clauses = parseKuery(c.req.query("kuery"));
      const showInactive = bool(c.req.query("showInactive")) ?? false;
      const rows = es.agents
        .all()
        .filter((agent) => showInactive || (agent.active && agent.status !== "unenrolled"))
        .sort((a, b) => a.id - b.id)
        .map((agent) => formatAgent(es, agent))
        .filter((agent) => kueryMatches(agent, clauses));
      const page = paginate(c, rows);
      return c.json({
        ...page,
        statusSummary: rows.reduce<Record<string, number>>(
          (summary, agent) => ({ ...summary, [String(agent.status)]: (summary[String(agent.status)] ?? 0) + 1 }),
          {},
        ),
      });
    }),
  );

  fleetRoute(
    app,
    "get",
    "/fleet/agents/available_versions",
    kibana(es, (c) => c.json({ items: agentVersions(es) })),
  );

  fleetRoute(
    app,
    "get",
    "/fleet/agent_status",
    kibana(es, (c) => {
      const policyId = c.req.query("policyId");
      const agents = es.agents.all().filter((agent) => !policyId || agent.policy_id === policyId);
      const count = (status: string) => agents.filter((agent) => agent.status === status).length;
      return c.json({
        results: {
          events: 0,
          total: agents.filter((agent) => agent.active).length,
          online: count("online"),
          error: count("error") + count("degraded"),
          offline: count("offline"),
          updating: count("updating") + count("enrolling") + count("unenrolling"),
          inactive: count("inactive"),
          unenrolled: count("unenrolled"),
          other: 0,
          all: agents.length,
          active: agents.filter((agent) => agent.active).length,
        },
      });
    }),
  );

  fleetRoute(
    app,
    "get",
    "/fleet/agents/:id",
    kibana(es, (c) => c.json({ item: formatAgent(es, findAgent(c.req.param("id"))) })),
  );

  fleetRoute(
    app,
    "post",
    "/fleet/agents/:id/unenroll",
    kibana(es, async (c) => {
      const agent = findAgent(c.req.param("id"));
      const body = await parseJsonBody(c);
      const revoke = bool(body.revoke) ?? false;
      es.agents.update(
        agent.id,
        revoke
          ? { active: false, status: "unenrolled", unenrolled_at: new Date().toISOString() }
          : { status: "unenrolling" },
      );
      logEvent(es, "agent.unenrolled", agent.agent_id, { hostname: agent.hostname, revoke });
      return c.json({});
    }),
  );

  fleetRoute(
    app,
    "post",
    "/fleet/agents/bulk_unenroll",
    kibana(es, async (c) => {
      const body = await parseJsonBody(c);
      const ids = stringArray(body.agents) ?? [];
      const revoke = bool(body.revoke) ?? false;
      for (const id of ids) {
        const agent = es.agents.findOneBy("agent_id", id);
        if (agent)
          es.agents.update(
            agent.id,
            revoke
              ? { active: false, status: "unenrolled", unenrolled_at: new Date().toISOString() }
              : { status: "unenrolling" },
          );
      }
      return c.json({ actionId: guid() });
    }),
  );

  fleetRoute(
    app,
    "put",
    "/fleet/agents/:id/reassign",
    kibana(es, async (c) => {
      const agent = findAgent(c.req.param("id"));
      const body = await parseJsonBody(c);
      const policy = findPolicy(str(body.policy_id) ?? "");
      es.agents.update(agent.id, { policy_id: policy.policy_id, policy_revision: policy.revision, status: "updating" });
      return c.json({});
    }),
  );

  fleetRoute(
    app,
    "get",
    "/fleet/enrollment_api_keys",
    kibana(es, (c) => {
      const clauses = parseKuery(c.req.query("kuery"));
      const rows = es.enrollmentKeys
        .all()
        .filter((key) => key.active)
        .sort((a, b) => a.id - b.id)
        .map(formatEnrollmentKey)
        .filter((key) => kueryMatches(key, clauses));
      return c.json({ ...paginate(c, rows), list: rows });
    }),
  );

  fleetRoute(
    app,
    "post",
    "/fleet/enrollment_api_keys",
    kibana(es, async (c) => {
      const body = await parseJsonBody(c);
      const policy = findPolicy(str(body.policy_id) ?? "");
      const key = es.enrollmentKeys.insert({
        key_id: guid(),
        api_key_id: token(15),
        api_key: token(48),
        name: str(body.name) ?? `Enrollment key (${policy.name})`,
        policy_id: policy.policy_id,
        active: true,
        hidden: false,
      });
      logEvent(es, "enrollment_key.created", key.key_id, { policyId: policy.policy_id });
      return c.json({ item: formatEnrollmentKey(key), action: "created" });
    }),
  );

  fleetRoute(
    app,
    "get",
    "/fleet/enrollment_api_keys/:id",
    kibana(es, (c) => {
      const key = es.enrollmentKeys.findOneBy("key_id", c.req.param("id"));
      if (!key) throw kibanaNotFound(`Enrollment API key ${c.req.param("id")} not found`);
      return c.json({ item: formatEnrollmentKey(key) });
    }),
  );

  fleetRoute(
    app,
    "delete",
    "/fleet/enrollment_api_keys/:id",
    kibana(es, (c) => {
      const key = es.enrollmentKeys.findOneBy("key_id", c.req.param("id"));
      if (!key) throw kibanaNotFound(`Enrollment API key ${c.req.param("id")} not found`);
      es.enrollmentKeys.update(key.id, { active: false });
      return c.json({ action: "deleted" });
    }),
  );

  fleetRoute(
    app,
    "get",
    "/fleet/fleet_server_hosts",
    kibana(es, (c) =>
      c.json(
        paginate(
          c,
          es.fleetServerHosts.all().map((host) => ({
            id: host.host_id,
            name: host.name,
            is_default: host.is_default,
            host_urls: host.host_urls,
            is_preconfigured: host.is_preconfigured,
            is_internal: false,
          })),
        ),
      ),
    ),
  );

  fleetRoute(
    app,
    "get",
    "/fleet/fleet_server_hosts/:id",
    kibana(es, (c) => {
      const host =
        es.fleetServerHosts.findOneBy("host_id", c.req.param("id")) ??
        (c.req.param("id") === "default"
          ? es.fleetServerHosts.all().find((candidate) => candidate.is_default)
          : undefined);
      if (!host) throw kibanaNotFound(`Fleet server host ${c.req.param("id")} not found`);
      return c.json({
        item: {
          id: host.host_id,
          name: host.name,
          is_default: host.is_default,
          host_urls: host.host_urls,
          is_preconfigured: host.is_preconfigured,
          is_internal: false,
        },
      });
    }),
  );

  fleetRoute(
    app,
    "get",
    "/fleet/epm/packages/:name",
    kibana(es, (c) => {
      const name = c.req.param("name");
      const installed = es.packagePolicies.all().find((packagePolicy) => packagePolicy.package_name === name);
      return c.json({
        item: {
          name,
          title: PACKAGE_TITLES[name] ?? name,
          version: installed?.package_version ?? "1.0.0",
          latestVersion: installed?.package_version ?? "1.0.0",
          status: installed ? "installed" : "not_installed",
          release: "ga",
          owner: { github: "elastic/integrations" },
        },
      });
    }),
  );

  fleetRoute(
    app,
    "get",
    "/fleet/setup",
    kibana(es, (c) => c.json({ isInitialized: true, nonFatalErrors: [] })),
  );
  fleetRoute(
    app,
    "post",
    "/fleet/setup",
    kibana(es, (c) => c.json({ isInitialized: true, nonFatalErrors: [] })),
  );
}
