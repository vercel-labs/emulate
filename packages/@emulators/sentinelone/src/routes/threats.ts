import type {
  S1Threat,
  ThreatAnalystVerdict,
  ThreatConfidence,
  ThreatIncidentStatus,
  ThreatMitigationStatus,
} from "../entities.js";
import { formatThreat } from "../formatters.js";
import {
  api,
  bool,
  containsAny,
  dataOf,
  filterOf,
  list,
  matchesList,
  oneOf,
  paginate,
  parseJsonBody,
  queryParams,
  route,
  sha1Hex,
  str,
  validation,
  type Body,
} from "../helpers.js";
import { logActivity, logEvent, nextId, type S1Store } from "../store.js";
import { agentInScope, findAgent, scopeFromBody, scopeFromParams, type S1RouteContext } from "../route-utils.js";

const MITIGATION_ACTIONS = [
  "kill",
  "quarantine",
  "remediate",
  "rollback-remediation",
  "un-quarantine",
  "network-quarantine",
] as const;
const INCIDENT_STATUSES = ["unresolved", "in_progress", "resolved"] as const;
const ANALYST_VERDICTS = ["undefined", "true_positive", "false_positive", "suspicious"] as const;
const CONFIDENCE_LEVELS = ["malicious", "suspicious", "n/a"] as const;

export interface CreateThreatInput {
  agentId: string;
  threatName: string;
  classification?: string;
  confidenceLevel?: ThreatConfidence;
  filePath?: string;
  sha1?: string;
  fileSize?: number;
  originatorProcess?: string;
  processUser?: string;
  initiatedBy?: string;
  detectionType?: "static" | "dynamic";
  engines?: string[];
  mitigationStatus?: ThreatMitigationStatus;
  incidentStatus?: ThreatIncidentStatus;
  analystVerdict?: ThreatAnalystVerdict;
  identifiedAt?: string;
  id?: string;
}

export function createThreat(ss: S1Store, input: CreateThreatInput): S1Threat {
  const agent = findAgent(ss, input.agentId);
  const now = new Date().toISOString();
  const mitigated =
    input.mitigationStatus ??
    (agent.mitigationMode === "protect" && (input.confidenceLevel ?? "malicious") === "malicious"
      ? "mitigated"
      : "not_mitigated");
  const threat = ss.threats.insert({
    s1_id: input.id ?? nextId(ss),
    agent_id: agent.s1_id,
    threatName: input.threatName,
    classification: input.classification ?? "Malware",
    classificationSource: "Cloud",
    confidenceLevel: input.confidenceLevel ?? "malicious",
    mitigationStatus: mitigated,
    incidentStatus: input.incidentStatus ?? "unresolved",
    analystVerdict: input.analystVerdict ?? "undefined",
    sha1: input.sha1 ?? sha1Hex(),
    sha256: null,
    filePath:
      input.filePath ??
      (agent.osType === "windows"
        ? `C:\\Users\\${agent.lastLoggedInUserName}\\Downloads\\${input.threatName}`
        : `/home/${agent.lastLoggedInUserName}/Downloads/${input.threatName}`),
    fileSize: input.fileSize ?? 245760,
    originatorProcess: input.originatorProcess ?? (agent.osType === "windows" ? "explorer.exe" : "bash"),
    processUser: input.processUser ?? `${agent.domain}\\${agent.lastLoggedInUserName}`,
    initiatedBy: input.initiatedBy ?? "agent_policy",
    detectionType: input.detectionType ?? "static",
    engines: input.engines ?? ["SentinelOne Cloud", "On-Write Static AI"],
    identifiedAt: input.identifiedAt ?? now,
    mitigatedAt: mitigated === "mitigated" ? now : null,
    resolvedAt: (input.incidentStatus ?? "unresolved") === "resolved" ? now : null,
    storyline: `S1-${sha1Hex().slice(0, 16)}`,
    rebootRequired: false,
    notes: [],
    mitigations:
      mitigated === "mitigated"
        ? [
            { action: "quarantine", status: "success", startedAt: now },
            { action: "kill", status: "success", startedAt: now },
          ]
        : [],
  });
  refreshAgentThreatCounters(ss, agent.s1_id);
  logActivity(ss, {
    activityType: 19,
    primaryDescription: `Threat ${threat.threatName} detected on ${agent.computerName}`,
    siteId: agent.site_id,
    groupId: agent.group_id,
    agentId: agent.s1_id,
    threatId: threat.s1_id,
  });
  logEvent(ss, "threat.detected", threat.s1_id, {
    threatName: threat.threatName,
    agentId: agent.s1_id,
    mitigationStatus: threat.mitigationStatus,
  });
  return threat;
}

export function refreshAgentThreatCounters(ss: S1Store, agentId: string): void {
  const agent = ss.agents.findOneBy("s1_id", agentId);
  if (!agent) return;
  const active = ss.threats
    .findBy("agent_id", agentId)
    .filter((threat) => threat.incidentStatus !== "resolved" && threat.mitigationStatus === "not_mitigated").length;
  ss.agents.update(agent.id, { activeThreats: active, infected: active > 0 });
}

function selectThreats(ss: S1Store, body: Body): S1Threat[] {
  const filter = filterOf(body);
  const ids = list(filter.ids);
  const scope = scopeFromBody(filter);
  const hasSelection =
    (ids && ids.length > 0) ||
    scope.siteIds ||
    scope.groupIds ||
    scope.accountIds ||
    scope.tenant ||
    list(filter.agentIds);
  if (!hasSelection)
    throw validation("filter must select threats with ids, agentIds, siteIds, groupIds, accountIds, or tenant");
  const agentIds = list(filter.agentIds);
  return ss.threats
    .all()
    .filter((threat) => matchesList(threat.s1_id, ids))
    .filter((threat) => matchesList(threat.agent_id, agentIds))
    .filter((threat) => {
      const agent = ss.agents.findOneBy("s1_id", threat.agent_id);
      return !!agent && agentInScope(ss, agent, scope);
    })
    .filter((threat) => matchesList(threat.incidentStatus, list(filter.incidentStatuses)))
    .filter((threat) => matchesList(threat.mitigationStatus, list(filter.mitigationStatuses)))
    .filter((threat) =>
      bool(filter.resolved) === undefined ? true : (threat.incidentStatus === "resolved") === bool(filter.resolved),
    );
}

export function threatRoutes(rc: S1RouteContext): void {
  const { app, ss, fmt } = rc;

  route(
    app,
    "get",
    "/threats",
    api(ss, (c) => {
      const params = queryParams(c);
      const scope = scopeFromParams(params);
      const resolved = params.bool("resolved");
      const rows = ss.threats
        .all()
        .filter((threat) => matchesList(threat.s1_id, params.list("ids")))
        .filter((threat) => matchesList(threat.agent_id, params.list("agentIds")))
        .filter((threat) => {
          const agent = ss.agents.findOneBy("s1_id", threat.agent_id);
          return !!agent && agentInScope(ss, agent, scope);
        })
        .filter((threat) => matchesList(threat.incidentStatus, params.list("incidentStatuses")))
        .filter((threat) => matchesList(threat.mitigationStatus, params.list("mitigationStatuses")))
        .filter((threat) => matchesList(threat.analystVerdict, params.list("analystVerdicts")))
        .filter((threat) => matchesList(threat.confidenceLevel, params.list("confidenceLevels")))
        .filter((threat) => matchesList(threat.classification, params.list("classifications")))
        .filter((threat) => (resolved === undefined ? true : (threat.incidentStatus === "resolved") === resolved))
        .filter((threat) =>
          containsAny(threat.threatName, params.list("threatDetails__contains") ?? params.list("query")),
        )
        .filter((threat) => matchesList(threat.sha1, params.list("contentHashes")))
        .filter((threat) => (params.get("createdAt__gte") ? threat.created_at >= params.get("createdAt__gte")! : true))
        .filter((threat) => (params.get("createdAt__lte") ? threat.created_at <= params.get("createdAt__lte")! : true))
        .sort((a, b) => b.id - a.id)
        .map((threat) => formatThreat(fmt, threat));
      return c.json(
        paginate(c, rows, {
          sortable: [
            "id",
            "createdAt",
            "updatedAt",
            "threatName",
            "mitigationStatus",
            "incidentStatus",
            "analystVerdict",
            "confidenceLevel",
            "classification",
            "agentComputerName",
            "siteName",
          ],
        }),
      );
    }),
  );

  route(
    app,
    "get",
    "/threats/:id",
    api(ss, (c) => {
      const threat = ss.threats.findOneBy("s1_id", c.req.param("id"));
      if (!threat) throw validation(`Threat ${c.req.param("id")} was not found`, 4040010);
      return c.json({ data: formatThreat(fmt, threat) });
    }),
  );

  route(
    app,
    "post",
    "/threats/mitigate/:action",
    api(ss, async (c) => {
      const actionName = oneOf(c.req.param("action"), MITIGATION_ACTIONS, "action");
      if (!actionName) throw validation(`action must be one of: ${MITIGATION_ACTIONS.join(", ")}`);
      const threats = selectThreats(ss, await parseJsonBody(c));
      const now = new Date().toISOString();
      let affected = 0;
      for (const threat of threats) {
        const mitigationStatus: ThreatMitigationStatus = actionName === "un-quarantine" ? "not_mitigated" : "mitigated";
        ss.threats.update(threat.id, {
          mitigationStatus,
          mitigatedAt: mitigationStatus === "mitigated" ? now : threat.mitigatedAt,
          mitigations: [...threat.mitigations, { action: actionName, status: "success", startedAt: now }],
        });
        refreshAgentThreatCounters(ss, threat.agent_id);
        affected += 1;
      }
      logEvent(ss, `threat.mitigate.${actionName}`, String(affected), {
        affected,
        ids: threats.map((threat) => threat.s1_id),
      });
      return c.json({ data: { affected } });
    }),
  );

  route(
    app,
    "post",
    "/threats/incident",
    api(ss, async (c) => {
      const body = await parseJsonBody(c);
      const status = oneOf(dataOf(body).incidentStatus, INCIDENT_STATUSES, "incidentStatus");
      if (!status) throw validation("data.incidentStatus is required");
      const threats = selectThreats(ss, body);
      for (const threat of threats) {
        ss.threats.update(threat.id, {
          incidentStatus: status,
          resolvedAt: status === "resolved" ? new Date().toISOString() : null,
        });
        refreshAgentThreatCounters(ss, threat.agent_id);
      }
      logEvent(ss, "threat.incident", status, { affected: threats.length });
      return c.json({ data: { affected: threats.length } });
    }),
  );

  route(
    app,
    "post",
    "/threats/analyst-verdict",
    api(ss, async (c) => {
      const body = await parseJsonBody(c);
      const verdict = oneOf(dataOf(body).analystVerdict, ANALYST_VERDICTS, "analystVerdict");
      if (!verdict) throw validation("data.analystVerdict is required");
      const threats = selectThreats(ss, body);
      for (const threat of threats) ss.threats.update(threat.id, { analystVerdict: verdict });
      return c.json({ data: { affected: threats.length } });
    }),
  );

  route(
    app,
    "post",
    "/threats/mark-as-benign",
    api(ss, async (c) => {
      const threats = selectThreats(ss, await parseJsonBody(c));
      for (const threat of threats) {
        ss.threats.update(threat.id, {
          mitigationStatus: "marked_as_benign",
          analystVerdict: "false_positive",
          incidentStatus: "resolved",
          resolvedAt: new Date().toISOString(),
        });
        refreshAgentThreatCounters(ss, threat.agent_id);
      }
      return c.json({ data: { affected: threats.length } });
    }),
  );

  route(
    app,
    "post",
    "/threats/mark-as-threat",
    api(ss, async (c) => {
      const threats = selectThreats(ss, await parseJsonBody(c));
      for (const threat of threats) {
        ss.threats.update(threat.id, { confidenceLevel: "malicious", analystVerdict: "true_positive" });
        refreshAgentThreatCounters(ss, threat.agent_id);
      }
      return c.json({ data: { affected: threats.length } });
    }),
  );

  route(
    app,
    "post",
    "/threats/notes",
    api(ss, async (c) => {
      const body = await parseJsonBody(c);
      const text = str(dataOf(body).text)?.trim();
      if (!text) throw validation("data.text is required");
      const threats = selectThreats(ss, body);
      for (const threat of threats) ss.threats.update(threat.id, { notes: [...threat.notes, text] });
      return c.json({ data: { affected: threats.length } });
    }),
  );

  route(
    app,
    "get",
    "/threats/:id/timeline",
    api(ss, (c) => {
      const threat = ss.threats.findOneBy("s1_id", c.req.param("id"));
      if (!threat) throw validation(`Threat ${c.req.param("id")} was not found`, 4040010);
      const events = [
        {
          id: `${threat.s1_id}-1`,
          activityType: 19,
          primaryDescription: `Threat ${threat.threatName} detected`,
          createdAt: threat.identifiedAt,
        },
        ...threat.mitigations.map((mitigation, index) => ({
          id: `${threat.s1_id}-m${index}`,
          activityType: 2001,
          primaryDescription: `Mitigation ${mitigation.action} ${mitigation.status}`,
          createdAt: mitigation.startedAt,
        })),
        ...(threat.resolvedAt
          ? [
              {
                id: `${threat.s1_id}-r`,
                activityType: 2010,
                primaryDescription: "Threat marked as resolved",
                createdAt: threat.resolvedAt,
              },
            ]
          : []),
      ];
      return c.json(paginate(c, events));
    }),
  );

  app.post("/_sentinelone/simulate/threat", async (c) => {
    const body = await parseJsonBody(c);
    const agentRef = str(body.agentId) ?? str(body.computerName) ?? str(body.uuid);
    if (!agentRef)
      return c.json(
        { errors: [{ code: 4000010, detail: "agentId or computerName is required", title: "Validation Error" }] },
        400,
      );
    const agent =
      ss.agents.findOneBy("s1_id", agentRef) ??
      ss.agents.findOneBy("uuid", agentRef) ??
      ss.agents.all().find((candidate) => candidate.computerName.toLowerCase() === agentRef.toLowerCase());
    if (!agent)
      return c.json(
        { errors: [{ code: 4040010, detail: `Agent ${agentRef} was not found`, title: "Resource not found" }] },
        404,
      );
    try {
      const threat = createThreat(ss, {
        agentId: agent.s1_id,
        threatName: str(body.threatName) ?? "eicar.com",
        classification: str(body.classification),
        confidenceLevel: oneOf(body.confidenceLevel, CONFIDENCE_LEVELS, "confidenceLevel"),
        filePath: str(body.filePath),
        sha1: str(body.sha1),
        originatorProcess: str(body.originatorProcess),
        processUser: str(body.processUser),
        detectionType: oneOf(body.detectionType, ["static", "dynamic"] as const, "detectionType"),
        engines: list(body.engines),
        mitigationStatus: oneOf(
          body.mitigationStatus,
          ["not_mitigated", "mitigated", "marked_as_benign"] as const,
          "mitigationStatus",
        ),
        incidentStatus: oneOf(body.incidentStatus, INCIDENT_STATUSES, "incidentStatus"),
        analystVerdict: oneOf(body.analystVerdict, ANALYST_VERDICTS, "analystVerdict"),
        identifiedAt: str(body.identifiedAt),
      });
      return c.json({ data: formatThreat(fmt, threat) }, 201);
    } catch (error) {
      if (error instanceof Error && "errors" in error)
        return c.json({ errors: (error as { errors: unknown }).errors }, 400);
      throw error;
    }
  });
}
