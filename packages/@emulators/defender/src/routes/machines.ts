import type { DefMachine, DeviceValue } from "../entities.js";
import {
  formatAlert,
  formatLogonUser,
  formatMachine,
  formatMachineAction,
  formatRecommendation,
  formatSoftware,
  formatVulnerability,
  liveActionStatus,
} from "../formatters.js";
import {
  api,
  badRequest,
  field,
  odataCollection,
  odataEntity,
  odataOptions,
  oneOf,
  parseJsonBody,
  route,
  str,
} from "../helpers.js";
import { logEvent } from "../store.js";
import { createMachineAction, findMachine, tenantRows, type ActionKind, type DefRouteContext } from "../route-utils.js";

const DEVICE_VALUES = ["Normal", "Low", "High"] as const;
const SCAN_TYPES = ["Quick", "Full"] as const;
const ISOLATION_TYPES = ["Full", "Selective", "UnManagedDevice"] as const;

export function machineRoutes(rc: DefRouteContext): void {
  const { app, ds, baseUrl } = rc;

  const requestor = (clientId: string) => `${clientId}@emulate`;

  route(
    app,
    "get",
    "/api/machines",
    api(ds, (c, auth) =>
      odataCollection(
        c,
        baseUrl,
        "Machines",
        tenantRows(ds.machines.all(), auth.tenantId)
          .sort((a, b) => a.id - b.id)
          .map(formatMachine),
        odataOptions(c),
      ),
    ),
  );

  route(
    app,
    "get",
    "/api/machines/findbyip",
    api(ds, (c, auth) => {
      const ip = c.req.query("ip");
      const timestamp = c.req.query("timestamp");
      if (!ip || !timestamp)
        throw badRequest("Both ip and timestamp query parameters are required", "InvalidParameter");
      const at = Date.parse(timestamp);
      if (Number.isNaN(at)) throw badRequest("timestamp must be an ISO 8601 date", "InvalidParameter");
      const machines = tenantRows(ds.machines.all(), auth.tenantId).filter(
        (machine) =>
          (machine.lastIpAddress === ip || machine.ipAddresses.some((entry) => entry.ipAddress === ip)) &&
          Date.parse(machine.lastSeen) >= at - 30 * 24 * 3600 * 1000,
      );
      return odataCollection(c, baseUrl, "Machines", machines.map(formatMachine), odataOptions(c));
    }),
  );

  route(
    app,
    "get",
    "/api/machines/findbytag",
    api(ds, (c, auth) => {
      const tag = c.req.query("tag");
      if (!tag) throw badRequest("The tag query parameter is required", "InvalidParameter");
      const useStartsWith = (c.req.query("useStartsWithFilter") ?? "false").toLowerCase() === "true";
      const machines = tenantRows(ds.machines.all(), auth.tenantId).filter((machine) =>
        machine.machineTags.some((candidate) =>
          useStartsWith
            ? candidate.toLowerCase().startsWith(tag.toLowerCase())
            : candidate.toLowerCase() === tag.toLowerCase(),
        ),
      );
      return odataCollection(c, baseUrl, "Machines", machines.map(formatMachine), odataOptions(c));
    }),
  );

  route(
    app,
    "get",
    "/api/machines/:id",
    api(ds, (c, auth) =>
      odataEntity(c, baseUrl, "Machines", formatMachine(findMachine(ds, auth.tenantId, c.req.param("id")))),
    ),
  );

  route(
    app,
    "get",
    "/api/machines/:id/alerts",
    api(ds, (c, auth) => {
      const machine = findMachine(ds, auth.tenantId, c.req.param("id"));
      const alerts = ds.alerts
        .findBy("machine_id", machine.machine_id)
        .filter((alert) => alert.tenant_id === auth.tenantId);
      return odataCollection(c, baseUrl, "Alerts", alerts.map(formatAlert), odataOptions(c));
    }),
  );

  route(
    app,
    "get",
    "/api/machines/:id/logonusers",
    api(ds, (c, auth) => {
      const machine = findMachine(ds, auth.tenantId, c.req.param("id"));
      const users = ds.logonUsers
        .findBy("machine_id", machine.machine_id)
        .filter((user) => user.tenant_id === auth.tenantId);
      return odataCollection(c, baseUrl, "Users", users.map(formatLogonUser), odataOptions(c));
    }),
  );

  route(
    app,
    "get",
    "/api/machines/:id/machineactions",
    api(ds, (c, auth) => {
      const machine = findMachine(ds, auth.tenantId, c.req.param("id"));
      const actions = ds.actions
        .findBy("machine_id", machine.machine_id)
        .filter((action) => action.tenant_id === auth.tenantId);
      return odataCollection(
        c,
        baseUrl,
        "MachineActions",
        actions.map((action) => formatMachineAction(ds, action)),
        odataOptions(c),
      );
    }),
  );

  route(
    app,
    "get",
    "/api/machines/:id/vulnerabilities",
    api(ds, (c, auth) => {
      const machine = findMachine(ds, auth.tenantId, c.req.param("id"));
      const cveIds = new Set(
        ds.machineVulnerabilities.findBy("machine_id", machine.machine_id).map((link) => link.cve_id),
      );
      const vulnerabilities = tenantRows(ds.vulnerabilities.all(), auth.tenantId).filter((vulnerability) =>
        cveIds.has(vulnerability.cve_id),
      );
      return odataCollection(c, baseUrl, "Vulnerabilities", vulnerabilities.map(formatVulnerability), odataOptions(c));
    }),
  );

  route(
    app,
    "get",
    "/api/machines/:id/software",
    api(ds, (c, auth) => {
      const machine = findMachine(ds, auth.tenantId, c.req.param("id"));
      const softwareIds = new Set(
        ds.machineSoftware.findBy("machine_id", machine.machine_id).map((link) => link.software_id),
      );
      const software = tenantRows(ds.software.all(), auth.tenantId).filter((item) => softwareIds.has(item.software_id));
      return odataCollection(c, baseUrl, "Software", software.map(formatSoftware), odataOptions(c));
    }),
  );

  route(
    app,
    "get",
    "/api/machines/:id/recommendations",
    api(ds, (c, auth) => {
      const machine = findMachine(ds, auth.tenantId, c.req.param("id"));
      const softwareIds = new Set(
        ds.machineSoftware.findBy("machine_id", machine.machine_id).map((link) => link.software_id),
      );
      const cveIds = new Set(
        ds.machineVulnerabilities.findBy("machine_id", machine.machine_id).map((link) => link.cve_id),
      );
      const recommendations = tenantRows(ds.recommendations.all(), auth.tenantId).filter(
        (item) =>
          (item.software_id !== null && softwareIds.has(item.software_id)) ||
          item.cve_ids.some((cve) => cveIds.has(cve)),
      );
      return odataCollection(c, baseUrl, "Recommendations", recommendations.map(formatRecommendation), odataOptions(c));
    }),
  );

  route(
    app,
    "post",
    "/api/machines/:id/tags",
    api(ds, async (c, auth) => {
      const machine = findMachine(ds, auth.tenantId, c.req.param("id"));
      const body = await parseJsonBody(c);
      const value = str(field(body, "Value"))?.trim();
      if (!value) throw badRequest("Value is required", "InvalidParameter");
      const action = oneOf(field(body, "Action"), ["Add", "Remove"] as const, "Action") ?? "Add";
      const tags =
        action === "Add"
          ? [...new Set([...machine.machineTags, value])]
          : machine.machineTags.filter((tag) => tag.toLowerCase() !== value.toLowerCase());
      const updated = ds.machines.update(machine.id, { machineTags: tags })!;
      logEvent(ds, auth.tenantId, "machine.tags_updated", machine.machine_id, { action, value, tags });
      return odataEntity(c, baseUrl, "Machines", formatMachine(updated));
    }),
  );

  route(
    app,
    "post",
    "/api/machines/:id/setDeviceValue",
    api(ds, async (c, auth) => {
      const machine = findMachine(ds, auth.tenantId, c.req.param("id"));
      const body = await parseJsonBody(c);
      const value = oneOf(field(body, "DeviceValue"), DEVICE_VALUES, "DeviceValue");
      if (!value) throw badRequest("DeviceValue is required", "InvalidParameter");
      const updated = ds.machines.update(machine.id, { deviceValue: value as DeviceValue })!;
      return odataEntity(c, baseUrl, "Machines", formatMachine(updated));
    }),
  );

  const actionRoute = (
    path: string,
    type: ActionKind,
    prepare?: (
      body: Record<string, unknown>,
      machine: DefMachine,
    ) => Partial<Parameters<typeof createMachineAction>[1]> & { after?: (machine: DefMachine) => void },
  ) => {
    route(
      app,
      "post",
      `/api/machines/:id/${path}`,
      api(ds, async (c, auth) => {
        const machine = findMachine(ds, auth.tenantId, c.req.param("id"));
        const body = await parseJsonBody(c);
        const comment = str(field(body, "Comment"))?.trim();
        if (!comment) throw badRequest("Comment is required", "MissingParameter");
        const extra = prepare?.(body, machine) ?? {};
        const { after, ...actionInput } = extra;
        const action = createMachineAction(ds, {
          type,
          machine,
          requestor: requestor(auth.token.client_id),
          comment,
          ...actionInput,
        });
        after?.(machine);
        c.status(201);
        return odataEntity(c, baseUrl, "MachineActions", formatMachineAction(ds, action));
      }),
    );
  };

  actionRoute("isolate", "Isolate", (body, machine) => {
    const isolationType = oneOf(field(body, "IsolationType"), ISOLATION_TYPES, "IsolationType") ?? "Full";
    if (machine.isolated)
      throw badRequest(`Machine ${machine.machine_id} is already isolated`, "ActiveRequestAlreadyExists");
    return {
      scope: isolationType,
      after: () => {
        ds.machines.update(machine.id, { isolated: true });
        logEvent(ds, machine.tenant_id, "machine.isolated", machine.machine_id, { isolationType });
      },
    };
  });
  actionRoute("unisolate", "Unisolate", (_body, machine) => {
    if (!machine.isolated) throw badRequest(`Machine ${machine.machine_id} is not isolated`, "InvalidRequest");
    return {
      after: () => {
        ds.machines.update(machine.id, { isolated: false });
        logEvent(ds, machine.tenant_id, "machine.unisolated", machine.machine_id, {});
      },
    };
  });
  actionRoute("restrictCodeExecution", "RestrictCodeExecution", (_body, machine) => ({
    after: () => ds.machines.update(machine.id, { code_execution_restricted: true }),
  }));
  actionRoute("unrestrictCodeExecution", "UnrestrictCodeExecution", (_body, machine) => ({
    after: () => ds.machines.update(machine.id, { code_execution_restricted: false }),
  }));
  actionRoute("runAntiVirusScan", "RunAntiVirusScan", (body) => ({
    scope: oneOf(field(body, "ScanType"), SCAN_TYPES, "ScanType") ?? "Quick",
  }));
  actionRoute("collectInvestigationPackage", "CollectInvestigationPackage");
  actionRoute("offboard", "Offboard", (_body, machine) => ({
    after: () => {
      ds.machines.update(machine.id, { onboardingStatus: "CanBeOnboarded", healthStatus: "Inactive" });
      logEvent(ds, machine.tenant_id, "machine.offboarded", machine.machine_id, {});
    },
  }));
  actionRoute("StopAndQuarantineFile", "StopAndQuarantineFile", (body) => {
    const sha1 = str(field(body, "Sha1"))?.trim();
    if (!sha1) throw badRequest("Sha1 is required", "MissingParameter");
    return { relatedFileInfo: { fileIdentifier: sha1, fileIdentifierType: "Sha1" } };
  });
  actionRoute("runliveresponse", "LiveResponse", (body) => {
    const commands = Array.isArray(field(body, "Commands"))
      ? (field(body, "Commands") as Array<Record<string, unknown>>)
      : [];
    if (commands.length === 0) throw badRequest("Commands must contain at least one command", "InvalidParameter");
    return {
      commands: commands.map((command, index) => ({
        index,
        startTime: null,
        endTime: null,
        commandStatus: "Created",
        errors: [],
        command: {
          type: str(command.type) ?? "RunScript",
          params: Array.isArray(command.params)
            ? (command.params as Array<Record<string, unknown>>).map((param) => ({
                key: str(param.key) ?? "",
                value: str(param.value) ?? "",
              }))
            : [],
        },
      })),
    };
  });

  route(
    app,
    "post",
    "/api/machines/:id/startInvestigation",
    api(ds, async (c, auth) => {
      const machine = findMachine(ds, auth.tenantId, c.req.param("id"));
      const body = await parseJsonBody(c);
      const comment = str(field(body, "Comment"))?.trim();
      if (!comment) throw badRequest("Comment is required", "MissingParameter");
      const investigation = ds.investigations.insert({
        tenant_id: auth.tenantId,
        investigation_id: String(ds.investigations.count() + 1000),
        startTime: new Date().toISOString(),
        endTime: null,
        state: "Running",
        cancelledBy: null,
        statusDetails: comment,
        machine_id: machine.machine_id,
        computerDnsName: machine.computerDnsName,
        triggeringAlertId: null,
      });
      logEvent(ds, auth.tenantId, "investigation.started", investigation.investigation_id, {
        machine_id: machine.machine_id,
      });
      c.status(201);
      return odataEntity(c, baseUrl, "Investigations", {
        id: investigation.investigation_id,
        startTime: investigation.startTime,
        endTime: null,
        state: investigation.state,
        cancelledBy: null,
        statusDetails: investigation.statusDetails,
        machineId: machine.machine_id,
        computerDnsName: machine.computerDnsName,
        triggeringAlertId: null,
      });
    }),
  );

  route(
    app,
    "get",
    "/api/machines/:id/activeactions",
    api(ds, (c, auth) => {
      const machine = findMachine(ds, auth.tenantId, c.req.param("id"));
      const actions = ds.actions
        .findBy("machine_id", machine.machine_id)
        .filter(
          (action) =>
            action.tenant_id === auth.tenantId && ["Pending", "InProgress"].includes(liveActionStatus(ds, action)),
        );
      return odataCollection(
        c,
        baseUrl,
        "MachineActions",
        actions.map((action) => formatMachineAction(ds, action)),
        odataOptions(c),
      );
    }),
  );
}
