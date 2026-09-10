import type { RiskSeverity, S1Application, S1Cve } from "../entities.js";
import { formatApplication, formatCve } from "../formatters.js";
import {
  api,
  containsAny,
  dataOf,
  filterOf,
  list,
  matchesList,
  num,
  oneOf,
  paginate,
  parseJsonBody,
  queryParams,
  route,
  str,
  validation,
} from "../helpers.js";
import { logEvent, nextId, type S1Store } from "../store.js";
import { agentInScope, findAgent, scopeFromParams, type S1RouteContext } from "../route-utils.js";

const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "NONE"] as const;
const VERDICTS = ["Default", "Added CVE", "False positive", "Not applicable"] as const;
const SEVERITY_RANK: Record<RiskSeverity, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, NONE: 0 };

export function severityFromScore(score: number | null): RiskSeverity {
  if (score === null) return "NONE";
  if (score >= 9) return "CRITICAL";
  if (score >= 7) return "HIGH";
  if (score >= 4) return "MEDIUM";
  if (score > 0) return "LOW";
  return "NONE";
}

export interface UpsertApplicationInput {
  agentId: string;
  name: string;
  vendor?: string;
  version?: string;
  applicationType?: string;
  detectionDate?: string;
}

export function upsertApplication(ss: S1Store, input: UpsertApplicationInput): S1Application {
  const agent = findAgent(ss, input.agentId);
  const existing = ss.applications
    .findBy("agent_id", agent.s1_id)
    .find(
      (application) =>
        application.name.toLowerCase() === input.name.toLowerCase() &&
        (input.version === undefined || application.version === input.version),
    );
  if (existing) return existing;
  const now = new Date().toISOString();
  const application = ss.applications.insert({
    s1_id: nextId(ss),
    agent_id: agent.s1_id,
    name: input.name,
    vendor: input.vendor ?? "Unknown",
    version: input.version ?? "1.0.0",
    applicationType: input.applicationType ?? "app",
    highestSeverity: "NONE",
    highestNvdBaseScore: null,
    cveCount: 0,
    detectionDate: input.detectionDate ?? now,
    lastScanDate: now,
    lastScanResult: "Succeeded",
    isDeleted: false,
  });
  return application;
}

export interface AddCveInput {
  applicationId: string;
  cveId: string;
  baseScore?: number | null;
  severity?: RiskSeverity;
  detectionDate?: string;
  publishedDate?: string;
  ransomware?: boolean;
  exploitedInTheWild?: boolean;
  analystVerdict?: S1Cve["analystVerdict"];
  description?: string;
}

export function addCve(ss: S1Store, input: AddCveInput): S1Cve {
  const application = ss.applications.findOneBy("s1_id", input.applicationId);
  if (!application) throw validation(`Application ${input.applicationId} was not found`, 4040010);
  const baseScore = input.baseScore ?? null;
  const severity = input.severity ?? severityFromScore(baseScore);
  const detectionDate = input.detectionDate ?? new Date().toISOString();
  const cve = ss.cves.insert({
    s1_id: nextId(ss),
    application_id: application.s1_id,
    cveId: input.cveId,
    baseScore,
    severity,
    nvdBaseScore: baseScore,
    cvssVersion: "3.1",
    detectionDate,
    publishedDate: input.publishedDate ?? detectionDate,
    ransomware: input.ransomware ?? false,
    exploitedInTheWild: input.exploitedInTheWild ?? false,
    analystVerdict: input.analystVerdict ?? "Default",
    description: input.description ?? `${input.cveId} affects ${application.name} ${application.version}`,
    daysDetected: Math.max(0, Math.floor((Date.now() - Date.parse(detectionDate)) / 86400000)),
    status: "Active",
  });
  refreshApplication(ss, application.s1_id);
  return cve;
}

export function refreshApplication(ss: S1Store, applicationId: string): void {
  const application = ss.applications.findOneBy("s1_id", applicationId);
  if (!application) return;
  const cves = ss.cves
    .findBy("application_id", applicationId)
    .filter((cve) => cve.status === "Active" && ["Default", "Added CVE"].includes(cve.analystVerdict));
  const highest = cves.reduce<RiskSeverity>(
    (best, cve) => (SEVERITY_RANK[cve.severity] > SEVERITY_RANK[best] ? cve.severity : best),
    "NONE",
  );
  const highestScore = cves.reduce<number | null>(
    (best, cve) => (cve.baseScore !== null && (best === null || cve.baseScore > best) ? cve.baseScore : best),
    null,
  );
  ss.applications.update(application.id, {
    highestSeverity: highest,
    highestNvdBaseScore: highestScore,
    cveCount: cves.length,
  });
  const agent = ss.agents.findOneBy("s1_id", application.agent_id);
  if (agent) {
    const vulnerable = ss.applications.findBy("agent_id", agent.s1_id).some((candidate) => candidate.cveCount > 0);
    ss.agents.update(agent.id, { appsVulnerabilityStatus: vulnerable ? "patch_required" : "up_to_date" });
  }
}

export function riskRoutes(rc: S1RouteContext): void {
  const { app, ss, fmt } = rc;

  route(
    app,
    "get",
    "/application-management/risks/applications",
    api(ss, (c) => {
      const params = queryParams(c);
      const scope = scopeFromParams(params);
      const severities = params.list("highestSeverities") ?? params.list("severities");
      const rows = ss.applications
        .all()
        .filter((application) => !application.isDeleted)
        .filter((application) => {
          const agent = ss.agents.findOneBy("s1_id", application.agent_id);
          return !!agent && !agent.isDecommissioned && agentInScope(ss, agent, scope);
        })
        .filter((application) => matchesList(application.s1_id, params.list("ids")))
        .filter((application) =>
          matchesList(application.agent_id, params.list("endpointIds") ?? params.list("agentIds")),
        )
        .filter((application) => matchesList(application.highestSeverity, severities))
        .filter((application) => matchesList(application.applicationType, params.list("applicationTypes")))
        .filter((application) =>
          containsAny(
            application.name,
            params.list("application__contains") ?? params.list("applicationName__contains") ?? params.list("query"),
          ),
        )
        .filter((application) => containsAny(application.vendor, params.list("applicationVendor__contains")))
        .filter((application) =>
          params.num("cveCount__gt") === undefined ? true : application.cveCount > params.num("cveCount__gt")!,
        )
        .sort((a, b) => a.id - b.id)
        .map((application) => formatApplication(fmt, application));
      return c.json(
        paginate(c, rows, {
          sortable: [
            "id",
            "application",
            "applicationName",
            "applicationVendor",
            "applicationVersion",
            "highestSeverity",
            "highestNvdBaseScore",
            "cveCount",
            "detectionDate",
            "lastScanDate",
            "endpointName",
            "siteName",
            "createdAt",
            "updatedAt",
          ],
        }),
      );
    }),
  );

  route(
    app,
    "get",
    "/application-management/risks",
    api(ss, (c) => {
      const params = queryParams(c);
      const scope = scopeFromParams(params);
      const verdicts = params.list("analystVerdict") ?? params.list("analystVerdicts");
      const rows = ss.cves
        .all()
        .filter((cve) => {
          const application = ss.applications.findOneBy("s1_id", cve.application_id);
          const agent = application ? ss.agents.findOneBy("s1_id", application.agent_id) : undefined;
          return (
            !!application &&
            !application.isDeleted &&
            !!agent &&
            !agent.isDecommissioned &&
            agentInScope(ss, agent, scope)
          );
        })
        .filter((cve) => matchesList(cve.s1_id, params.list("ids")))
        .filter((cve) => matchesList(cve.cveId, params.list("cveIds") ?? params.list("cveId")))
        .filter((cve) => matchesList(cve.severity, params.list("severities") ?? params.list("severity")))
        .filter((cve) => matchesList(cve.analystVerdict, verdicts))
        .filter((cve) => matchesList(cve.status, params.list("statuses")))
        .filter((cve) =>
          params.bool("ransomware") === undefined ? true : cve.ransomware === params.bool("ransomware"),
        )
        .filter((cve) =>
          params.bool("exploitedInTheWild") === undefined
            ? true
            : cve.exploitedInTheWild === params.bool("exploitedInTheWild"),
        )
        .filter((cve) =>
          params.num("baseScore__gte") === undefined ? true : (cve.baseScore ?? 0) >= params.num("baseScore__gte")!,
        )
        .filter((cve) =>
          params.get("detectionDate__gte") ? cve.detectionDate >= params.get("detectionDate__gte")! : true,
        )
        .filter((cve) =>
          params.get("detectionDate__lte") ? cve.detectionDate <= params.get("detectionDate__lte")! : true,
        )
        .filter((cve) => {
          const wanted = params.list("application__contains") ?? params.list("applicationName__contains");
          if (!wanted) return true;
          return containsAny(ss.applications.findOneBy("s1_id", cve.application_id)?.name, wanted);
        })
        .filter((cve) => {
          const endpointIds = params.list("endpointIds") ?? params.list("agentIds");
          if (!endpointIds) return true;
          return matchesList(ss.applications.findOneBy("s1_id", cve.application_id)?.agent_id, endpointIds);
        })
        .sort((a, b) => a.id - b.id)
        .map((cve) => formatCve(fmt, cve));
      return c.json(
        paginate(c, rows, {
          sortable: [
            "id",
            "cveId",
            "baseScore",
            "nvdBaseScore",
            "severity",
            "detectionDate",
            "publishedDate",
            "daysDetected",
            "application",
            "applicationVendor",
            "applicationVersion",
            "endpointName",
            "siteName",
            "analystVerdict",
            "status",
            "createdAt",
            "updatedAt",
          ],
        }),
      );
    }),
  );

  route(
    app,
    "get",
    "/application-management/risks/:id",
    api(ss, (c) => {
      const cve = ss.cves.findOneBy("s1_id", c.req.param("id"));
      if (!cve) throw validation(`Risk ${c.req.param("id")} was not found`, 4040010);
      return c.json({ data: formatCve(fmt, cve) });
    }),
  );

  route(
    app,
    "post",
    "/application-management/risks/analyst-verdict",
    api(ss, async (c) => {
      const body = await parseJsonBody(c);
      const verdict = oneOf(dataOf(body).analystVerdict, VERDICTS, "analystVerdict");
      if (!verdict) throw validation("data.analystVerdict is required");
      const ids = list(filterOf(body).ids) ?? [];
      if (ids.length === 0) throw validation("filter.ids is required");
      let affected = 0;
      for (const id of ids) {
        const cve = ss.cves.findOneBy("s1_id", id);
        if (!cve) continue;
        ss.cves.update(cve.id, { analystVerdict: verdict });
        refreshApplication(ss, cve.application_id);
        affected += 1;
      }
      logEvent(ss, "risk.verdict", verdict, { affected });
      return c.json({ data: { affected } });
    }),
  );

  route(
    app,
    "get",
    "/application-management/inventory/endpoints",
    api(ss, (c) => {
      const params = queryParams(c);
      const scope = scopeFromParams(params);
      const rows = ss.agents
        .all()
        .filter((agent) => !agent.isDecommissioned && agentInScope(ss, agent, scope))
        .map((agent) => {
          const applications = ss.applications
            .findBy("agent_id", agent.s1_id)
            .filter((application) => !application.isDeleted);
          return {
            endpointId: agent.s1_id,
            endpointName: agent.computerName,
            osType: agent.osType,
            siteId: agent.site_id,
            applicationsCount: applications.length,
            vulnerableApplicationsCount: applications.filter((application) => application.cveCount > 0).length,
            highestSeverity: applications.reduce<RiskSeverity>(
              (best, application) =>
                SEVERITY_RANK[application.highestSeverity] > SEVERITY_RANK[best] ? application.highestSeverity : best,
              "NONE",
            ),
            lastScanDate: agent.scanFinishedAt,
          };
        });
      return c.json(paginate(c, rows));
    }),
  );

  app.post("/_sentinelone/simulate/vulnerability", async (c) => {
    const body = await parseJsonBody(c);
    const agentRef = str(body.agentId) ?? str(body.computerName);
    if (!agentRef)
      return c.json(
        { errors: [{ code: 4000010, detail: "agentId or computerName is required", title: "Validation Error" }] },
        400,
      );
    const agent =
      ss.agents.findOneBy("s1_id", agentRef) ??
      ss.agents.all().find((candidate) => candidate.computerName.toLowerCase() === agentRef.toLowerCase());
    if (!agent)
      return c.json(
        { errors: [{ code: 4040010, detail: `Agent ${agentRef} was not found`, title: "Resource not found" }] },
        404,
      );
    const cveId = str(body.cveId);
    if (!cveId)
      return c.json({ errors: [{ code: 4000010, detail: "cveId is required", title: "Validation Error" }] }, 400);
    try {
      const application = upsertApplication(ss, {
        agentId: agent.s1_id,
        name: str(body.application) ?? str(body.applicationName) ?? "Unknown application",
        vendor: str(body.applicationVendor) ?? str(body.vendor),
        version: str(body.applicationVersion) ?? str(body.version),
        applicationType: str(body.applicationType),
        detectionDate: str(body.detectionDate),
      });
      const cve = addCve(ss, {
        applicationId: application.s1_id,
        cveId,
        baseScore: num(body.baseScore) ?? null,
        severity: oneOf(body.severity, SEVERITIES, "severity"),
        detectionDate: str(body.detectionDate),
        publishedDate: str(body.publishedDate),
        ransomware: body.ransomware === true,
        exploitedInTheWild: body.exploitedInTheWild === true,
        description: str(body.description),
      });
      logEvent(ss, "risk.detected", cve.s1_id, { cveId, agentId: agent.s1_id, severity: cve.severity });
      return c.json({ data: formatCve(fmt, cve) }, 201);
    } catch (error) {
      if (error instanceof Error && "errors" in error)
        return c.json({ errors: (error as { errors: unknown }).errors }, 400);
      throw error;
    }
  });
}
