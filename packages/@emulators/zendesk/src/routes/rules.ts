import type { WebhookAuthentication, ZendeskMacro, ZendeskTrigger, ZendeskView, ZendeskWebhook } from "../entities.js";
import { evaluateConditions, parseActions, parseConditions } from "../conditions.js";
import {
  formatInvocation,
  formatInvocationAttempt,
  formatMacro,
  formatTicket,
  formatTrigger,
  formatView,
  formatWebhook,
} from "../formatters.js";
import {
  api,
  bool,
  invalidValue,
  nowIso,
  num,
  obj,
  parseJsonBody,
  recordInvalid,
  recordNotFound,
  requireAgent,
  route,
  str,
  strOrNull,
  zendeskList,
  type Body,
} from "../helpers.js";
import { hexToken, nextId, ulid } from "../ids.js";
import { macroResult } from "../ticket-service.js";
import { invokeWebhook } from "../webhooks.js";
import { idParam, liveTickets, type ZendeskRouteContext } from "../route-utils.js";

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function parseAuthentication(value: unknown): WebhookAuthentication | null {
  const auth = obj(value);
  const type = str(auth.type);
  if (!type) return null;
  if (type !== "basic_auth" && type !== "bearer_token" && type !== "api_key")
    throw invalidValue(`Unsupported authentication type: ${type}`);
  const data = Object.fromEntries(Object.entries(obj(auth.data)).map(([key, item]) => [key, String(item ?? "")]));
  return { type, data, add_position: "header" };
}

export function parseWebhookInput(body: Body, existing?: ZendeskWebhook): Partial<ZendeskWebhook> {
  const updates: Partial<ZendeskWebhook> = {};
  if (body.name !== undefined) updates.name = str(body.name) ?? existing?.name ?? "";
  if (body.description !== undefined) updates.description = strOrNull(body.description);
  if (body.endpoint !== undefined) updates.endpoint = str(body.endpoint) ?? "";
  if (body.http_method !== undefined) {
    const method = (str(body.http_method) ?? "POST").toUpperCase();
    if (!HTTP_METHODS.has(method)) throw invalidValue(`Unsupported http_method: ${method}`);
    updates.http_method = method as ZendeskWebhook["http_method"];
  }
  if (body.request_format !== undefined) {
    const format = str(body.request_format) ?? "json";
    if (format !== "json" && format !== "xml" && format !== "form_encoded")
      throw invalidValue(`Unsupported request_format: ${format}`);
    updates.request_format = format;
  }
  if (body.status !== undefined) {
    const status = str(body.status) ?? "active";
    if (status !== "active" && status !== "inactive") throw invalidValue(`Unsupported status: ${status}`);
    updates.status = status;
  }
  if (body.subscriptions !== undefined)
    updates.subscriptions = Array.isArray(body.subscriptions) ? body.subscriptions.map(String) : [];
  if (body.authentication !== undefined)
    updates.authentication = body.authentication === null ? null : parseAuthentication(body.authentication);
  if (body.custom_headers !== undefined) {
    updates.custom_headers = Object.fromEntries(
      Object.entries(obj(body.custom_headers)).map(([key, value]) => [key, String(value ?? "")]),
    );
  }
  return updates;
}

export function ruleRoutes(rc: ZendeskRouteContext): void {
  const { app, zs, ctx, fmt } = rc;

  route(
    app,
    "get",
    "/api/v2/webhooks",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const nameFilter = c.req.query("filter[name_contains]")?.toLowerCase();
      const statusFilter = c.req.query("filter[status]");
      let webhooks = zs.webhooks.all();
      if (nameFilter) webhooks = webhooks.filter((webhook) => webhook.name.toLowerCase().includes(nameFilter));
      if (statusFilter) webhooks = webhooks.filter((webhook) => webhook.status === statusFilter);
      return zendeskList(c, webhooks, "webhooks", (webhook) => formatWebhook(webhook), { cursorOnly: true });
    }),
  );

  route(
    app,
    "post",
    "/api/v2/webhooks",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const body = await parseJsonBody(c);
      const input = parseWebhookInput(obj(body.webhook));
      if (!input.name) throw invalidValue("name is required");
      if (!input.endpoint) throw invalidValue("endpoint is required");
      const webhook = zs.webhooks.insert({
        zd_id: ulid(),
        name: input.name,
        description: input.description ?? null,
        status: input.status ?? "active",
        endpoint: input.endpoint,
        http_method: input.http_method ?? "POST",
        request_format: input.request_format ?? "json",
        subscriptions: input.subscriptions ?? ["conditional_ticket_events"],
        authentication: input.authentication ?? null,
        custom_headers: input.custom_headers ?? {},
        signing_secret: hexToken(32),
        created_by: String(auth.user.zd_id),
        updated_by: String(auth.user.zd_id),
      });
      return c.json({ webhook: formatWebhook(webhook, true) }, 201);
    }),
  );

  route(
    app,
    "post",
    "/api/v2/webhooks/test",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const body = await parseJsonBody(c);
      const request = obj(body.request);
      const webhookId = c.req.query("webhook_id");
      const existing = webhookId ? zs.webhooks.findOneBy("zd_id", webhookId) : undefined;
      const input = parseWebhookInput(request, existing);
      const target: ZendeskWebhook = {
        ...(existing ?? {
          id: 0,
          created_at: nowIso(),
          updated_at: nowIso(),
          zd_id: "test",
          name: "Test",
          description: null,
          status: "active",
          endpoint: "",
          http_method: "POST",
          request_format: "json",
          subscriptions: [],
          authentication: null,
          custom_headers: {},
          signing_secret: hexToken(32),
          created_by: String(auth.user.zd_id),
          updated_by: String(auth.user.zd_id),
        }),
        ...input,
      };
      if (!target.endpoint) throw invalidValue("endpoint is required");
      const payload = str(request.payload) ?? JSON.stringify({ test: true, sent_at: nowIso() });
      const invocation = await invokeWebhook(ctx, target, payload, { eventType: "test" });
      if (target.zd_id === "test") zs.webhookInvocations.delete(invocation.id);
      return c.json({
        response: { status: invocation.status_code, headers: {}, payload: invocation.response_body ?? "" },
      });
    }),
  );

  const findWebhook = (id: string): ZendeskWebhook => {
    const webhook = zs.webhooks.findOneBy("zd_id", id.replace(/\.json$/, ""));
    if (!webhook) throw recordNotFound();
    return webhook;
  };

  route(
    app,
    "get",
    "/api/v2/webhooks/:id",
    api(zs, (c, auth) => {
      requireAgent(auth);
      return c.json({ webhook: formatWebhook(findWebhook(c.req.param("id"))) });
    }),
  );

  const updateWebhook = api(zs, async (c, auth) => {
    requireAgent(auth);
    const webhook = findWebhook(c.req.param("id"));
    const body = await parseJsonBody(c);
    const input = parseWebhookInput(obj(body.webhook), webhook);
    const updated = zs.webhooks.update(webhook.id, { ...input, updated_by: String(auth.user.zd_id) })!;
    return c.json({ webhook: formatWebhook(updated) });
  });

  route(app, "put", "/api/v2/webhooks/:id", updateWebhook);
  route(app, "patch", "/api/v2/webhooks/:id", updateWebhook);

  route(
    app,
    "delete",
    "/api/v2/webhooks/:id",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const webhook = findWebhook(c.req.param("id"));
      zs.webhooks.delete(webhook.id);
      return c.body(null, 204);
    }),
  );

  route(
    app,
    "post",
    "/api/v2/webhooks/:id/test",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const webhook = findWebhook(c.req.param("id"));
      const body = await parseJsonBody(c);
      const payload =
        str(obj(body.request).payload) ?? JSON.stringify({ test: true, webhook_id: webhook.zd_id, sent_at: nowIso() });
      const invocation = await invokeWebhook(ctx, webhook, payload, { eventType: "test" });
      return c.json({
        response: { status: invocation.status_code, headers: {}, payload: invocation.response_body ?? "" },
      });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/webhooks/:id/signing_secret",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const webhook = findWebhook(c.req.param("id"));
      return c.json({ signing_secret: { algorithm: "SHA256", secret: webhook.signing_secret } });
    }),
  );

  route(
    app,
    "post",
    "/api/v2/webhooks/:id/signing_secret",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const webhook = findWebhook(c.req.param("id"));
      const updated = zs.webhooks.update(webhook.id, { signing_secret: hexToken(32) })!;
      return c.json({ signing_secret: { algorithm: "SHA256", secret: updated.signing_secret } });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/webhooks/:id/invocations",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const webhook = findWebhook(c.req.param("id"));
      const status = c.req.query("filter[status]");
      let invocations = zs.webhookInvocations.findBy("webhook_id", webhook.zd_id);
      if (status) invocations = invocations.filter((invocation) => invocation.status === status);
      return zendeskList(c, invocations, "invocations", formatInvocation, {
        cursorOnly: true,
        defaultSort: "latest_completed_attempt_at",
      });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/webhooks/:id/invocations/:invocationId/attempts",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const webhook = findWebhook(c.req.param("id"));
      const invocation = zs.webhookInvocations.findOneBy("zd_id", c.req.param("invocationId").replace(/\.json$/, ""));
      if (!invocation || invocation.webhook_id !== webhook.zd_id) throw recordNotFound();
      return c.json({ attempts: [formatInvocationAttempt(invocation)] });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/triggers",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const active = c.req.query("active");
      let triggers = [...zs.triggers.all()].sort((a, b) => a.position - b.position || a.id - b.id);
      if (active !== undefined) triggers = triggers.filter((trigger) => String(trigger.active) === active);
      return zendeskList(c, triggers, "triggers", (trigger) => formatTrigger(fmt, trigger));
    }),
  );

  route(
    app,
    "get",
    "/api/v2/triggers/active",
    api(zs, (c, auth) => {
      requireAgent(auth);
      return zendeskList(
        c,
        zs.triggers.all().filter((trigger) => trigger.active),
        "triggers",
        (trigger) => formatTrigger(fmt, trigger),
      );
    }),
  );

  route(
    app,
    "post",
    "/api/v2/triggers",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const body = await parseJsonBody(c);
      const input = obj(body.trigger);
      const title = str(input.title)?.trim();
      if (!title) throw recordInvalid({ title: "Title: cannot be blank" });
      const actions = parseActions(input.actions);
      if (actions.length === 0) throw recordInvalid({ actions: "Actions: cannot be blank" });
      const conditions = parseConditions(input.conditions);
      if (conditions.all.length === 0 && conditions.any.length === 0)
        throw recordInvalid({ conditions: "Conditions: cannot be blank" });
      const trigger = zs.triggers.insert({
        zd_id: nextId(zs, "triggers"),
        title,
        description: strOrNull(input.description),
        active: bool(input.active) ?? true,
        position: num(input.position) ?? zs.triggers.count() + 1,
        category_id: strOrNull(input.category_id),
        conditions,
        actions,
      });
      return c.json({ trigger: formatTrigger(fmt, trigger) }, 201);
    }),
  );

  const findTrigger = (id: string): ZendeskTrigger => {
    const trigger = zs.triggers.findOneBy("zd_id", idParam(id));
    if (!trigger) throw recordNotFound();
    return trigger;
  };

  route(
    app,
    "get",
    "/api/v2/triggers/:id",
    api(zs, (c, auth) => {
      requireAgent(auth);
      return c.json({ trigger: formatTrigger(fmt, findTrigger(c.req.param("id"))) });
    }),
  );

  route(
    app,
    "put",
    "/api/v2/triggers/:id",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const trigger = findTrigger(c.req.param("id"));
      const body = await parseJsonBody(c);
      const input = obj(body.trigger);
      const updated = zs.triggers.update(trigger.id, {
        title: input.title !== undefined ? (str(input.title) ?? trigger.title) : trigger.title,
        description: input.description !== undefined ? strOrNull(input.description) : trigger.description,
        active: bool(input.active) ?? trigger.active,
        position: num(input.position) ?? trigger.position,
        category_id: input.category_id !== undefined ? strOrNull(input.category_id) : trigger.category_id,
        conditions: input.conditions !== undefined ? parseConditions(input.conditions) : trigger.conditions,
        actions: input.actions !== undefined ? parseActions(input.actions) : trigger.actions,
      })!;
      return c.json({ trigger: formatTrigger(fmt, updated) });
    }),
  );

  route(
    app,
    "delete",
    "/api/v2/triggers/:id",
    api(zs, (c, auth) => {
      requireAgent(auth);
      zs.triggers.delete(findTrigger(c.req.param("id")).id);
      return c.body(null, 204);
    }),
  );

  route(
    app,
    "get",
    "/api/v2/macros",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const active = c.req.query("active");
      let macros = [...zs.macros.all()].sort((a, b) => a.position - b.position || a.id - b.id);
      if (active !== undefined) macros = macros.filter((macro) => String(macro.active) === active);
      return zendeskList(c, macros, "macros", (macro) => formatMacro(fmt, macro));
    }),
  );

  route(
    app,
    "get",
    "/api/v2/macros/active",
    api(zs, (c, auth) => {
      requireAgent(auth);
      return zendeskList(
        c,
        zs.macros.all().filter((macro) => macro.active),
        "macros",
        (macro) => formatMacro(fmt, macro),
      );
    }),
  );

  route(
    app,
    "post",
    "/api/v2/macros",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const body = await parseJsonBody(c);
      const input = obj(body.macro);
      const title = str(input.title)?.trim();
      if (!title) throw recordInvalid({ title: "Title: cannot be blank" });
      const actions = parseActions(input.actions);
      if (actions.length === 0) throw recordInvalid({ actions: "Actions: cannot be blank" });
      const macro = zs.macros.insert({
        zd_id: nextId(zs, "macros"),
        title,
        description: strOrNull(input.description),
        active: bool(input.active) ?? true,
        position: num(input.position) ?? zs.macros.count() + 1,
        actions,
        restriction: input.restriction ? obj(input.restriction) : null,
      });
      return c.json({ macro: formatMacro(fmt, macro) }, 201);
    }),
  );

  const findMacro = (id: string): ZendeskMacro => {
    const macro = zs.macros.findOneBy("zd_id", idParam(id));
    if (!macro) throw recordNotFound();
    return macro;
  };

  route(
    app,
    "get",
    "/api/v2/macros/:id",
    api(zs, (c, auth) => {
      requireAgent(auth);
      return c.json({ macro: formatMacro(fmt, findMacro(c.req.param("id"))) });
    }),
  );

  route(
    app,
    "put",
    "/api/v2/macros/:id",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const macro = findMacro(c.req.param("id"));
      const body = await parseJsonBody(c);
      const input = obj(body.macro);
      const updated = zs.macros.update(macro.id, {
        title: input.title !== undefined ? (str(input.title) ?? macro.title) : macro.title,
        description: input.description !== undefined ? strOrNull(input.description) : macro.description,
        active: bool(input.active) ?? macro.active,
        position: num(input.position) ?? macro.position,
        actions: input.actions !== undefined ? parseActions(input.actions) : macro.actions,
      })!;
      return c.json({ macro: formatMacro(fmt, updated) });
    }),
  );

  route(
    app,
    "delete",
    "/api/v2/macros/:id",
    api(zs, (c, auth) => {
      requireAgent(auth);
      zs.macros.delete(findMacro(c.req.param("id")).id);
      return c.body(null, 204);
    }),
  );

  route(
    app,
    "get",
    "/api/v2/macros/:id/apply",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const macro = findMacro(c.req.param("id"));
      const result = macroResult(zs, macro, null, auth.user);
      return c.json({ result: { ticket: result } });
    }),
  );

  const viewTickets = (view: ZendeskView, currentUserId: number) => {
    const currentUser = zs.users.findOneBy("zd_id", currentUserId) ?? null;
    return liveTickets(zs).filter((ticket) =>
      evaluateConditions(view.conditions, {
        zs,
        ticket,
        previous: null,
        updateType: "Change",
        currentUser,
        comment: null,
      }),
    );
  };

  route(
    app,
    "get",
    "/api/v2/views",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const active = c.req.query("active");
      let views = [...zs.views.all()].sort((a, b) => a.position - b.position || a.id - b.id);
      if (active !== undefined) views = views.filter((view) => String(view.active) === active);
      return zendeskList(c, views, "views", (view) => formatView(fmt, view));
    }),
  );

  route(
    app,
    "get",
    "/api/v2/views/active",
    api(zs, (c, auth) => {
      requireAgent(auth);
      return zendeskList(
        c,
        zs.views.all().filter((view) => view.active),
        "views",
        (view) => formatView(fmt, view),
      );
    }),
  );

  route(
    app,
    "get",
    "/api/v2/views/compact",
    api(zs, (c, auth) => {
      requireAgent(auth);
      return zendeskList(
        c,
        zs.views.all().filter((view) => view.active),
        "views",
        (view) => formatView(fmt, view),
      );
    }),
  );

  route(
    app,
    "post",
    "/api/v2/views",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const body = await parseJsonBody(c);
      const input = obj(body.view);
      const title = str(input.title)?.trim();
      if (!title) throw recordInvalid({ title: "Title: cannot be blank" });
      const conditions = parseConditions(input.conditions ?? { all: input.all, any: input.any });
      if (conditions.all.length === 0 && conditions.any.length === 0)
        throw recordInvalid({ conditions: "Conditions: cannot be blank" });
      const view = zs.views.insert({
        zd_id: nextId(zs, "views"),
        title,
        description: strOrNull(input.description),
        active: bool(input.active) ?? true,
        position: num(input.position) ?? zs.views.count() + 1,
        conditions,
        execution: obj(input.output ?? input.execution),
        restriction: input.restriction ? obj(input.restriction) : null,
      });
      return c.json({ view: formatView(fmt, view) }, 201);
    }),
  );

  const findView = (id: string): ZendeskView => {
    const view = zs.views.findOneBy("zd_id", idParam(id));
    if (!view) throw recordNotFound();
    return view;
  };

  route(
    app,
    "get",
    "/api/v2/views/:id",
    api(zs, (c, auth) => {
      requireAgent(auth);
      return c.json({ view: formatView(fmt, findView(c.req.param("id"))) });
    }),
  );

  route(
    app,
    "put",
    "/api/v2/views/:id",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const view = findView(c.req.param("id"));
      const body = await parseJsonBody(c);
      const input = obj(body.view);
      const updated = zs.views.update(view.id, {
        title: input.title !== undefined ? (str(input.title) ?? view.title) : view.title,
        description: input.description !== undefined ? strOrNull(input.description) : view.description,
        active: bool(input.active) ?? view.active,
        position: num(input.position) ?? view.position,
        conditions:
          input.conditions !== undefined || input.all !== undefined || input.any !== undefined
            ? parseConditions(input.conditions ?? { all: input.all, any: input.any })
            : view.conditions,
      })!;
      return c.json({ view: formatView(fmt, updated) });
    }),
  );

  route(
    app,
    "delete",
    "/api/v2/views/:id",
    api(zs, (c, auth) => {
      requireAgent(auth);
      zs.views.delete(findView(c.req.param("id")).id);
      return c.body(null, 204);
    }),
  );

  route(
    app,
    "get",
    "/api/v2/views/:id/tickets",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const view = findView(c.req.param("id"));
      return zendeskList(c, viewTickets(view, auth.user.zd_id), "tickets", (ticket) => formatTicket(fmt, ticket));
    }),
  );

  route(
    app,
    "get",
    "/api/v2/views/:id/count",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const view = findView(c.req.param("id"));
      return c.json({
        view_count: {
          view_id: view.zd_id,
          url: `${rc.baseUrl}/api/v2/views/${view.zd_id}/count.json`,
          value: viewTickets(view, auth.user.zd_id).length,
          pretty: String(viewTickets(view, auth.user.zd_id).length),
          fresh: true,
        },
      });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/views/:id/execute",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const view = findView(c.req.param("id"));
      const tickets = viewTickets(view, auth.user.zd_id);
      return zendeskList(
        c,
        tickets,
        "rows",
        (ticket) => ({
          ticket: {
            id: ticket.zd_id,
            subject: ticket.subject,
            description: ticket.description,
            status: ticket.status,
            type: ticket.type,
            priority: ticket.priority,
            url: `${rc.baseUrl}/api/v2/tickets/${ticket.zd_id}.json`,
            created_at: ticket.created_at,
            updated_at: ticket.updated_at,
          },
          subject: ticket.subject,
          requester_id: ticket.requester_id,
          assignee_id: ticket.assignee_id,
          group_id: ticket.group_id,
          status: ticket.status,
          priority: ticket.priority,
          created: ticket.created_at,
          updated: ticket.updated_at,
        }),
        { extra: { view: formatView(fmt, view) } },
      );
    }),
  );

  route(
    app,
    "get",
    "/api/v2/views/count_many",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const ids = (c.req.query("ids") ?? "").split(",").map(Number).filter(Number.isFinite);
      return c.json({
        view_counts: ids
          .map((id) => zs.views.findOneBy("zd_id", id))
          .filter((view): view is ZendeskView => !!view)
          .map((view) => ({
            view_id: view.zd_id,
            url: `${rc.baseUrl}/api/v2/views/${view.zd_id}/count.json`,
            value: viewTickets(view, auth.user.zd_id).length,
            pretty: String(viewTickets(view, auth.user.zd_id).length),
            fresh: true,
          })),
      });
    }),
  );
}
