import { formatMachineAction, liveActionStatus } from "../formatters.js";
import {
  api,
  badRequest,
  field,
  odataCollection,
  odataEntity,
  odataOptions,
  parseJsonBody,
  route,
  str,
} from "../helpers.js";
import { logEvent } from "../store.js";
import { findAction, tenantRows, type DefRouteContext } from "../route-utils.js";

export function actionRoutes(rc: DefRouteContext): void {
  const { app, ds, baseUrl } = rc;

  route(
    app,
    "get",
    "/api/machineactions",
    api(ds, (c, auth) =>
      odataCollection(
        c,
        baseUrl,
        "MachineActions",
        tenantRows(ds.actions.all(), auth.tenantId)
          .sort((a, b) => b.id - a.id)
          .map((action) => formatMachineAction(ds, action)),
        odataOptions(c),
      ),
    ),
  );

  route(
    app,
    "get",
    "/api/machineactions/:id",
    api(ds, (c, auth) =>
      odataEntity(
        c,
        baseUrl,
        "MachineActions",
        formatMachineAction(ds, findAction(ds, auth.tenantId, c.req.param("id"))),
      ),
    ),
  );

  route(
    app,
    "post",
    "/api/machineactions/:id/cancel",
    api(ds, async (c, auth) => {
      const action = findAction(ds, auth.tenantId, c.req.param("id"));
      const body = await parseJsonBody(c);
      const comment = str(field(body, "Comment"))?.trim();
      if (!comment) throw badRequest("Comment is required", "MissingParameter");
      const status = liveActionStatus(ds, action);
      if (!["Pending", "InProgress"].includes(status))
        throw badRequest(
          `Machine action ${action.action_id} is already ${status} and cannot be cancelled`,
          "InvalidRequest",
        );
      const now = new Date().toISOString();
      const updated = ds.actions.update(action.id, {
        status: "Cancelled",
        frozen: true,
        cancellationRequestor: `${auth.token.client_id}@emulate`,
        cancellationComment: comment,
        cancellationDateTimeUtc: now,
        lastUpdateDateTimeUtc: now,
      })!;
      if (action.type === "Isolate") {
        const machine = ds.machines
          .findBy("machine_id", action.machine_id)
          .find((candidate) => candidate.tenant_id === auth.tenantId);
        if (machine) ds.machines.update(machine.id, { isolated: false });
      }
      logEvent(ds, auth.tenantId, "machine_action.cancelled", action.action_id, { type: action.type, comment });
      return odataEntity(c, baseUrl, "MachineActions", formatMachineAction(ds, updated));
    }),
  );

  route(
    app,
    "get",
    "/api/machineactions/:id/getPackageUri",
    api(ds, (c, auth) => {
      const action = findAction(ds, auth.tenantId, c.req.param("id"));
      if (action.type !== "CollectInvestigationPackage")
        throw badRequest("Package URIs are only available for CollectInvestigationPackage actions", "InvalidRequest");
      if (liveActionStatus(ds, action) !== "Succeeded")
        throw badRequest(`Machine action ${action.action_id} has not completed yet`, "InvalidRequest");
      return c.json({
        "@odata.context": `${baseUrl}/api/$metadata#Edm.String`,
        value: `${baseUrl}/_defender/packages/${action.action_id}.zip`,
      });
    }),
  );

  route(
    app,
    "get",
    "/api/machineactions/:id/GetLiveResponseResultDownloadLink",
    api(ds, (c, auth) => {
      const action = findAction(ds, auth.tenantId, c.req.param("id"));
      const index = Number(c.req.query("index") ?? "0");
      if (action.type !== "LiveResponse" || !action.commands[index])
        throw badRequest("No live response command at that index", "InvalidRequest");
      return c.json({
        "@odata.context": `${baseUrl}/api/$metadata#Edm.String`,
        value: `${baseUrl}/_defender/live-response/${action.action_id}/${index}.json`,
      });
    }),
  );

  app.get("/_defender/packages/:file", (c) => {
    const actionId = c.req.param("file").replace(/\.zip$/, "");
    const action = ds.actions.findOneBy("action_id", actionId);
    if (!action) return c.text("Not found", 404);
    return c.body(Buffer.from(`Investigation package for ${action.computerDnsName} (emulated)`), 200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${action.action_id}.zip"`,
    });
  });

  app.get("/_defender/live-response/:id/:file", (c) => {
    const action = ds.actions.findOneBy("action_id", c.req.param("id"));
    const index = Number(c.req.param("file").replace(/\.json$/, ""));
    if (!action || !action.commands[index]) return c.text("Not found", 404);
    return c.json({
      script_name: action.commands[index].command.params.find((param) => param.key === "ScriptName")?.value ?? null,
      exit_code: 0,
      script_output: "emulated live response output",
      script_errors: "",
    });
  });
}
