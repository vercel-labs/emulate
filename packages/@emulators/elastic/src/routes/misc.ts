import type { AppEnv, Hono } from "@emulators/core";
import type { AgentStatus, EsAgent } from "../entities.js";
import { guid, num, parseJsonBody, str, stringArray, token, type Json } from "../helpers.js";
import { agentVersions, logEvent, type EsStore } from "../store.js";
import { formatAgent } from "./fleet.js";
import { indexDocument } from "./search.js";

const OS_DEFAULTS: Record<
  string,
  { family: string; full: string; kernel: string; name: string; platform: string; version: string }
> = {
  windows: {
    family: "windows",
    full: "Windows Server 2022 Standard(10.0)",
    kernel: "10.0.20348.2402 (WinBuild.160101.0800)",
    name: "Windows Server 2022 Standard",
    platform: "windows",
    version: "10.0",
  },
  linux: {
    family: "debian",
    full: "Ubuntu jammy(22.04.4 LTS (Jammy Jellyfish))",
    kernel: "5.15.0-105-generic",
    name: "Ubuntu",
    platform: "ubuntu",
    version: "22.04.4 LTS (Jammy Jellyfish)",
  },
  darwin: {
    family: "darwin",
    full: "macOS 14.4.1",
    kernel: "23.4.0",
    name: "macOS",
    platform: "darwin",
    version: "14.4.1",
  },
};

export interface EnrollAgentInput {
  policyId: string;
  hostname: string;
  os?: "windows" | "linux" | "darwin";
  version?: string;
  status?: AgentStatus;
  ip?: string[];
  tags?: string[];
  id?: string;
  lastCheckin?: string;
}

export function enrollAgent(es: EsStore, input: EnrollAgentInput): EsAgent {
  const os = OS_DEFAULTS[input.os ?? "windows"] ?? OS_DEFAULTS.windows;
  const policy = es.agentPolicies.findOneBy("policy_id", input.policyId);
  const now = new Date().toISOString();
  const agent = es.agents.insert({
    agent_id: input.id ?? guid(),
    policy_id: input.policyId,
    type: "PERMANENT",
    active: input.status !== "unenrolled",
    status: input.status ?? "online",
    enrolled_at: now,
    unenrolled_at: null,
    last_checkin: input.lastCheckin ?? now,
    last_checkin_status: input.status === "error" ? "ERROR" : input.status === "degraded" ? "DEGRADED" : "online",
    last_checkin_message: input.status === "error" ? "Component failed" : "Running",
    policy_revision: policy?.revision ?? 1,
    access_api_key_id: token(15),
    version: input.version ?? agentVersions(es)[0],
    hostname: input.hostname,
    host_id: guid(),
    ip: input.ip ?? [`10.${(es.agents.count() % 250) + 1}.0.${(es.agents.count() % 200) + 10}`],
    mac: ["00-15-5D-01-02-03"],
    os_family: os.family,
    os_full: os.full,
    os_kernel: os.kernel,
    os_name: os.name,
    os_platform: os.platform,
    os_version: os.version,
    architecture: "x86_64",
    tags: input.tags ?? [],
    unhealthy_reason: input.status === "degraded" || input.status === "error" ? ["input"] : [],
  });
  logEvent(es, "agent.enrolled", agent.agent_id, {
    hostname: agent.hostname,
    policyId: agent.policy_id,
    status: agent.status,
  });
  return agent;
}

export function miscRoutes(app: Hono<AppEnv>, es: EsStore): void {
  app.post("/_elastic/simulate/enroll", async (c) => {
    const body = await parseJsonBody(c);
    const enrollmentToken = str(body.enrollmentToken) ?? str(body.enrollment_token);
    const key = enrollmentToken ? es.enrollmentKeys.findOneBy("api_key", enrollmentToken) : undefined;
    const policyId =
      str(body.policyId) ??
      str(body.policy_id) ??
      key?.policy_id ??
      es.agentPolicies.all().find((policy) => policy.name === str(body.policyName))?.policy_id;
    if (!policyId || !es.agentPolicies.findOneBy("policy_id", policyId))
      return c.json(
        {
          statusCode: 404,
          error: "Not Found",
          message: "Agent policy not found; pass policyId, policyName, or a valid enrollmentToken",
        },
        404,
      );
    if (key && !key.active)
      return c.json({ statusCode: 401, error: "Unauthorized", message: "Enrollment API key is not active" }, 401);
    const agent = enrollAgent(es, {
      policyId,
      hostname: str(body.hostname) ?? `host-${token(4)}`,
      os: str(body.os) as EnrollAgentInput["os"],
      version: str(body.version),
      status: str(body.status) as AgentStatus | undefined,
      ip: stringArray(body.ip),
      tags: stringArray(body.tags),
    });
    return c.json({ item: formatAgent(es, agent) }, 201);
  });

  app.post("/_elastic/simulate/checkin", async (c) => {
    const body = await parseJsonBody(c);
    const reference = str(body.agentId) ?? str(body.hostname);
    if (!reference)
      return c.json({ statusCode: 400, error: "Bad Request", message: "agentId or hostname is required" }, 400);
    const agent = es.agents.findOneBy("agent_id", reference) ?? es.agents.findOneBy("hostname", reference);
    if (!agent) return c.json({ statusCode: 404, error: "Not Found", message: `Agent ${reference} not found` }, 404);
    const status = (str(body.status) as AgentStatus | undefined) ?? "online";
    const policy = es.agentPolicies.findOneBy("policy_id", agent.policy_id);
    const updated = es.agents.update(agent.id, {
      status,
      active: status !== "unenrolled",
      last_checkin: new Date().toISOString(),
      last_checkin_status: status === "online" ? "online" : status.toUpperCase(),
      last_checkin_message: str(body.message) ?? (status === "online" ? "Running" : `Agent is ${status}`),
      version: str(body.version) ?? agent.version,
      policy_revision: policy?.revision ?? agent.policy_revision,
      unhealthy_reason:
        status === "degraded" || status === "error" ? (stringArray(body.unhealthyReason) ?? ["input"]) : [],
    })!;
    logEvent(es, "agent.checkin", updated.agent_id, { hostname: updated.hostname, status });
    return c.json({ item: formatAgent(es, updated) });
  });

  app.post("/_elastic/simulate/documents", async (c) => {
    const body = await parseJsonBody(c);
    const index = str(body.index);
    if (!index) return c.json({ statusCode: 400, error: "Bad Request", message: "index is required" }, 400);
    const documents = Array.isArray(body.documents)
      ? (body.documents as Json[])
      : body.document
        ? [body.document as Json]
        : [];
    if (documents.length === 0)
      return c.json(
        { statusCode: 400, error: "Bad Request", message: "documents must contain at least one document" },
        400,
      );
    const results = documents.map((document) => {
      const source = { "@timestamp": new Date().toISOString(), ...document };
      const { doc } = indexDocument(es, index, source, str(document._id));
      return { _index: doc.index, _id: doc.doc_id };
    });
    logEvent(es, "documents.simulated", index, { count: results.length });
    return c.json({ indexed: results.length, items: results }, 201);
  });

  app.post("/_elastic/simulate/service-status", async (c) => {
    const body = await parseJsonBody(c);
    const integrationId = str(body.integrationId) ?? str(body.integration_id);
    const service = str(body.service);
    const status = str(body.status);
    if (!integrationId || !service || !status)
      return c.json(
        { statusCode: 400, error: "Bad Request", message: "integrationId, service, and status are required" },
        400,
      );
    const index = str(body.index) ?? "services-monitoring";
    const { doc } = indexDocument(es, index, {
      "@timestamp": str(body.timestamp) ?? new Date().toISOString(),
      integration_id: integrationId,
      service,
      status,
      namespace: str(body.namespace) ?? "default",
      latest_log: str(body.latestLog) ?? new Date().toISOString(),
      message: str(body.message) ?? `${service} integration ${integrationId} is ${status}`,
    });
    logEvent(es, "service_status.simulated", integrationId, { service, status });
    return c.json({ _index: doc.index, _id: doc.doc_id, status }, 201);
  });

  app.get("/_elastic/events", (c) => {
    const type = c.req.query("type");
    const limit = Math.min(num(c.req.query("limit")) ?? 100, 1000);
    const events = [...es.events.all()]
      .filter((event) => !type || event.type === type)
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
    return c.json({
      events: events.map((event) => ({
        id: event.id,
        type: event.type,
        subject: event.subject,
        detail: event.detail,
        created_at: event.created_at,
      })),
    });
  });

  app.delete("/_elastic/events", (c) => {
    es.events.clear();
    return c.json({ ok: true });
  });
}
