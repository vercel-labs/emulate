import type { HealthStatus, OnboardingStatus } from "../entities.js";
import { formatAlert, formatInvestigation, formatMachine } from "../formatters.js";
import {
  api,
  badRequest,
  field,
  notFound,
  nowIso,
  num,
  odataCollection,
  odataEntity,
  odataOptions,
  oneOf,
  parseJsonBody,
  route,
  str,
  stringArray,
} from "../helpers.js";
import { logEvent, setActionDelays } from "../store.js";
import { findInvestigation, tenantRows, type DefRouteContext } from "../route-utils.js";
import { ALERT_SEVERITIES, ALERT_STATUSES, createAlert } from "./alerts.js";

const HEALTH_STATUSES = [
  "Active",
  "Inactive",
  "ImpairedCommunication",
  "NoSensorData",
  "NoSensorDataImpairedCommunication",
  "Unknown",
] as const;
const ONBOARDING_STATUSES = ["Onboarded", "CanBeOnboarded", "Unsupported", "InsufficientInfo"] as const;

export function miscRoutes(rc: DefRouteContext): void {
  const { app, ds, baseUrl } = rc;

  const userAlerts = (tenantId: string, userId: string) => {
    const [domain, name] = userId.includes("\\")
      ? userId.split("\\")
      : userId.includes("@")
        ? [userId.split("@")[1], userId.split("@")[0]]
        : [null, userId];
    return tenantRows(ds.alerts.all(), tenantId).filter(
      (alert) =>
        alert.relatedUser &&
        alert.relatedUser.userName.toLowerCase() === name.toLowerCase() &&
        (!domain || alert.relatedUser.domainName.toLowerCase() === domain.toLowerCase()),
    );
  };

  route(
    app,
    "get",
    "/api/users/:id/alerts",
    api(ds, (c, auth) =>
      odataCollection(
        c,
        baseUrl,
        "Alerts",
        userAlerts(auth.tenantId, c.req.param("id")).map(formatAlert),
        odataOptions(c),
      ),
    ),
  );

  route(
    app,
    "get",
    "/api/users/:id/machines",
    api(ds, (c, auth) => {
      const userId = c.req.param("id");
      const name = (userId.includes("\\") ? userId.split("\\")[1] : userId.split("@")[0]).toLowerCase();
      const machineIds = new Set(
        tenantRows(ds.logonUsers.all(), auth.tenantId)
          .filter((user) => user.accountName.toLowerCase() === name)
          .map((user) => user.machine_id),
      );
      return odataCollection(
        c,
        baseUrl,
        "Machines",
        tenantRows(ds.machines.all(), auth.tenantId)
          .filter((machine) => machineIds.has(machine.machine_id))
          .map(formatMachine),
        odataOptions(c),
      );
    }),
  );

  const evidenceMatches =
    (kind: "domain" | "file" | "ip", value: string) =>
    (item: {
      entityType: string;
      domainName: string | null;
      url: string | null;
      sha1: string | null;
      sha256: string | null;
      ipAddress: string | null;
    }) => {
      const lowered = value.toLowerCase();
      if (kind === "domain")
        return (
          (item.url?.toLowerCase().includes(lowered) ?? false) ||
          (["Url", "Domain", "DomainName"].includes(item.entityType) && item.domainName?.toLowerCase() === lowered)
        );
      if (kind === "file") return item.sha1?.toLowerCase() === lowered || item.sha256?.toLowerCase() === lowered;
      return item.ipAddress === value;
    };

  for (const [prefix, kind] of [
    ["domains", "domain"],
    ["files", "file"],
    ["ips", "ip"],
  ] as const) {
    route(
      app,
      "get",
      `/api/${prefix}/:value/alerts`,
      api(ds, (c, auth) => {
        const alerts = tenantRows(ds.alerts.all(), auth.tenantId).filter((alert) =>
          alert.evidence.some(evidenceMatches(kind, c.req.param("value"))),
        );
        return odataCollection(c, baseUrl, "Alerts", alerts.map(formatAlert), odataOptions(c));
      }),
    );
    route(
      app,
      "get",
      `/api/${prefix}/:value/machines`,
      api(ds, (c, auth) => {
        const machineIds = new Set(
          tenantRows(ds.alerts.all(), auth.tenantId)
            .filter((alert) => alert.evidence.some(evidenceMatches(kind, c.req.param("value"))))
            .map((alert) => alert.machine_id),
        );
        return odataCollection(
          c,
          baseUrl,
          "Machines",
          tenantRows(ds.machines.all(), auth.tenantId)
            .filter((machine) => machineIds.has(machine.machine_id))
            .map(formatMachine),
          odataOptions(c),
        );
      }),
    );
    route(
      app,
      "get",
      `/api/${prefix}/:value/stats`,
      api(ds, (c, auth) => {
        const value = c.req.param("value");
        const matching = tenantRows(ds.alerts.all(), auth.tenantId).filter((alert) =>
          alert.evidence.some(evidenceMatches(kind, value)),
        );
        const times = matching.map((alert) => alert.firstEventTime).sort();
        const body = {
          [kind === "domain" ? "host" : kind === "file" ? "sha1" : "ipAddress"]: value,
          organizationPrevalence: new Set(matching.map((alert) => alert.machine_id)).size,
          orgFirstSeen: times[0] ?? null,
          orgLastSeen: times[times.length - 1] ?? null,
          ...(kind === "file"
            ? {
                globalPrevalence: matching.length,
                globallyPrevalence: matching.length,
                topFileNames: [
                  ...new Set(
                    matching
                      .flatMap((alert) =>
                        alert.evidence.filter(evidenceMatches("file", value)).map((item) => item.fileName),
                      )
                      .filter(Boolean),
                  ),
                ],
              }
            : {}),
        };
        return odataEntity(
          c,
          baseUrl,
          kind === "domain" ? "InOrgDomainStats" : kind === "file" ? "InOrgFileStats" : "InOrgIPStats",
          body,
        );
      }),
    );
  }

  route(
    app,
    "get",
    "/api/files/:sha",
    api(ds, (c, auth) => {
      const sha = c.req.param("sha");
      const evidence = tenantRows(ds.alerts.all(), auth.tenantId)
        .flatMap((alert) => alert.evidence)
        .find(evidenceMatches("file", sha));
      if (!evidence) throw notFound(`File ${sha} was not found`, "ResourceNotFound");
      return odataEntity(c, baseUrl, "Files", {
        sha1: evidence.sha1,
        sha256: evidence.sha256,
        md5: null,
        globalPrevalence: 1,
        globalFirstObserved: evidence.evidenceCreationTime,
        globalLastObserved: evidence.evidenceCreationTime,
        size: null,
        fileType: null,
        isPeFile: evidence.fileName?.toLowerCase().endsWith(".exe") ?? false,
        filePublisher: null,
        fileProductName: null,
        signer: null,
        issuer: null,
        signerHash: null,
        isValidCertificate: null,
        determinationType: "Unknown",
        determinationValue: null,
      });
    }),
  );

  route(
    app,
    "get",
    "/api/investigations",
    api(ds, (c, auth) =>
      odataCollection(
        c,
        baseUrl,
        "Investigations",
        tenantRows(ds.investigations.all(), auth.tenantId).map(formatInvestigation),
        odataOptions(c),
      ),
    ),
  );

  route(
    app,
    "get",
    "/api/investigations/:id",
    api(ds, (c, auth) =>
      odataEntity(
        c,
        baseUrl,
        "Investigations",
        formatInvestigation(findInvestigation(ds, auth.tenantId, c.req.param("id"))),
      ),
    ),
  );

  route(
    app,
    "get",
    "/api/machinegroups",
    api(ds, (c, auth) => {
      const groups = new Map<number, string>();
      for (const machine of tenantRows(ds.machines.all(), auth.tenantId))
        if (machine.rbacGroupName) groups.set(machine.rbacGroupId, machine.rbacGroupName);
      return odataCollection(
        c,
        baseUrl,
        "MachineGroups",
        [...groups.entries()].map(([id, name]) => ({
          id,
          name,
          machineCount: tenantRows(ds.machines.all(), auth.tenantId).filter((machine) => machine.rbacGroupId === id)
            .length,
        })),
        odataOptions(c),
      );
    }),
  );

  app.post("/_defender/simulate/alert", async (c) => {
    const body = await parseJsonBody(c);
    const machineId = str(field(body, "machineId")) ?? str(field(body, "machine_id"));
    if (!machineId) return c.json({ error: "machineId is required" }, 400);
    const machine =
      ds.machines.findOneBy("machine_id", machineId) ?? ds.machines.findOneBy("computerDnsName", machineId);
    if (!machine) return c.json({ error: `Machine ${machineId} was not found` }, 404);
    try {
      const alert = createAlert(ds, {
        tenantId: machine.tenant_id,
        machineId: machine.machine_id,
        title: str(field(body, "title")) ?? "Suspicious activity detected",
        description: str(field(body, "description")),
        severity: oneOf(field(body, "severity"), ALERT_SEVERITIES, "severity"),
        status: oneOf(field(body, "status"), ALERT_STATUSES, "status"),
        category: str(field(body, "category")),
        detectionSource: str(field(body, "detectionSource")),
        threatName: str(field(body, "threatName")) ?? null,
        threatFamilyName: str(field(body, "threatFamilyName")) ?? null,
        mitreTechniques: stringArray(field(body, "mitreTechniques")),
        evidence: Array.isArray(field(body, "evidence"))
          ? (field(body, "evidence") as Array<Record<string, unknown>>)
          : [],
        relatedUser:
          field(body, "relatedUser") && typeof field(body, "relatedUser") === "object"
            ? (field(body, "relatedUser") as { userName: string; domainName: string })
            : null,
      });
      return c.json(formatAlert(alert), 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Unable to create alert" }, 400);
    }
  });

  app.post("/_defender/simulate/machine", async (c) => {
    const body = await parseJsonBody(c);
    const machineId = str(field(body, "machineId")) ?? str(field(body, "machine_id"));
    if (!machineId) return c.json({ error: "machineId is required" }, 400);
    const machine =
      ds.machines.findOneBy("machine_id", machineId) ?? ds.machines.findOneBy("computerDnsName", machineId);
    if (!machine) return c.json({ error: `Machine ${machineId} was not found` }, 404);
    try {
      const updated = ds.machines.update(machine.id, {
        lastSeen: str(field(body, "lastSeen")) ? new Date(String(field(body, "lastSeen"))).toISOString() : nowIso(),
        healthStatus:
          (oneOf(field(body, "healthStatus"), HEALTH_STATUSES, "healthStatus") as HealthStatus | undefined) ??
          machine.healthStatus,
        onboardingStatus:
          (oneOf(field(body, "onboardingStatus"), ONBOARDING_STATUSES, "onboardingStatus") as
            | OnboardingStatus
            | undefined) ?? machine.onboardingStatus,
        lastIpAddress: str(field(body, "lastIpAddress")) ?? machine.lastIpAddress,
        agentVersion: str(field(body, "agentVersion")) ?? machine.agentVersion,
        version: str(field(body, "version")) ?? machine.version,
        osBuild: num(field(body, "osBuild")) ?? machine.osBuild,
      })!;
      logEvent(ds, machine.tenant_id, "machine.seen", machine.machine_id, {
        lastSeen: updated.lastSeen,
        healthStatus: updated.healthStatus,
      });
      return c.json(formatMachine(updated));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Unable to update machine" }, 400);
    }
  });

  app.post("/_defender/simulate/action-delays", async (c) => {
    const body = await parseJsonBody(c);
    const inProgress = num(field(body, "in_progress_after_ms"));
    const succeeded = num(field(body, "succeeded_after_ms"));
    if (inProgress === undefined || succeeded === undefined || inProgress < 0 || succeeded < inProgress)
      return c.json(
        {
          error:
            "in_progress_after_ms and succeeded_after_ms must be non-negative with succeeded_after_ms >= in_progress_after_ms",
        },
        400,
      );
    setActionDelays(ds, { in_progress_after_ms: inProgress, succeeded_after_ms: succeeded });
    return c.json({ ok: true, in_progress_after_ms: inProgress, succeeded_after_ms: succeeded });
  });

  app.get("/_defender/events", (c) => {
    const type = c.req.query("type");
    const tenant = c.req.query("tenant");
    const limit = Math.min(Number(c.req.query("limit") ?? 100), 1000);
    const events = [...ds.events.all()]
      .filter((event) => (!type || event.type === type) && (!tenant || event.tenant_id === tenant))
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
    return c.json({
      events: events.map((event) => ({
        id: event.id,
        tenant_id: event.tenant_id,
        type: event.type,
        subject: event.subject,
        detail: event.detail,
        created_at: event.created_at,
      })),
    });
  });

  app.delete("/_defender/events", (c) => {
    ds.events.clear();
    return c.json({ ok: true });
  });

  route(
    app,
    "get",
    "/api",
    api(ds, (c, auth) => {
      const tenant = ds.tenants.findOneBy("tenant_id", auth.tenantId);
      if (!tenant) throw badRequest("Unknown tenant", "InvalidTenant");
      return c.json({
        "@odata.context": `${baseUrl}/api/$metadata`,
        tenant: { id: tenant.tenant_id, name: tenant.name },
        machines: tenantRows(ds.machines.all(), auth.tenantId).length,
        alerts: tenantRows(ds.alerts.all(), auth.tenantId).length,
        roles: auth.token.roles,
      });
    }),
  );
}
