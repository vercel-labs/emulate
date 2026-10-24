import type { RouteContext } from "@emulators/core";
import { API_V, JiraError, makeHandler, pageParams, readJson, type JiraRequest } from "../context.js";
import { jiraTime } from "../ids.js";
import { compileJql, JqlError } from "../jql.js";
import { paginate } from "../lookup.js";
import { insertFrom } from "../store.js";
import { WEBHOOK_EVENTS } from "../webhooks.js";
import type { JiraWebhook } from "../entities.js";

const W = "/rest/webhooks/1.0/webhook";
const DYNAMIC_TTL_MS = 30 * 24 * 3600 * 1000;
const FILTER_KEY = "issue-related-events-section";

/** Returns an error message for an invalid JQL filter, or null. Compiling it catches unknown values too. */
function jqlProblem(r: JiraRequest, jql: string | null): string | null {
  if (!jql?.trim()) return null;
  try {
    compileJql(r.js, jql, r.user);
    return null;
  } catch (err) {
    if (err instanceof JqlError) return err.message;
    throw err;
  }
}

function eventProblem(events: unknown): string | null {
  if (!Array.isArray(events) || events.length === 0) return "At least one event must be specified.";
  const unknown = events.filter((event) => !WEBHOOK_EVENTS.includes(String(event)));
  return unknown.length > 0 ? `Unsupported webhook events: ${unknown.join(", ")}.` : null;
}

export function webhookRoutes({ app, store, baseUrl }: RouteContext): void {
  const handle = makeHandler(store, baseUrl);

  const requireAdmin = (r: JiraRequest) => {
    if (!r.user.admin) throw new JiraError(403, ["Only Jira administrators can manage webhooks."]);
  };

  const formatAdmin = (r: JiraRequest, webhook: JiraWebhook) => {
    const author = r.js.users.all().find((user) => user.admin) ?? r.user;
    return {
      name: webhook.name,
      url: webhook.url,
      excludeBody: webhook.exclude_body,
      filters: { [FILTER_KEY]: webhook.jql_filter ?? "" },
      events: webhook.events,
      enabled: webhook.enabled,
      self: `${r.siteUrl}${W}/${webhook.id}`,
      lastUpdatedUser: author.account_id,
      lastUpdatedDisplayName: author.display_name,
      lastUpdated: new Date(webhook.updated_at).getTime(),
    };
  };

  const readAdminBody = async (r: JiraRequest, existing?: JiraWebhook) => {
    const body = await readJson(r.c);
    const url = body.url ?? existing?.url;
    if (typeof url !== "string" || !/^https?:\/\//.test(url))
      throw new JiraError(400, [], { url: "A valid webhook URL is required." });
    const events = body.events ?? existing?.events;
    const eventError = eventProblem(events);
    if (eventError) throw new JiraError(400, [], { events: eventError });
    const jql = body.filters?.[FILTER_KEY] ?? existing?.jql_filter ?? null;
    const jqlError = jqlProblem(r, jql);
    if (jqlError) throw new JiraError(400, [], { filters: jqlError });
    return {
      name: String(body.name ?? existing?.name ?? "Webhook"),
      url,
      events: events as string[],
      jql_filter: jql || null,
      enabled: typeof body.enabled === "boolean" ? body.enabled : (existing?.enabled ?? true),
      exclude_body: typeof body.excludeBody === "boolean" ? body.excludeBody : (existing?.exclude_body ?? false),
      secret: typeof body.secret === "string" && body.secret ? body.secret : (existing?.secret ?? null),
    };
  };

  const requireAdminWebhook = (r: JiraRequest) => {
    const webhook = r.js.webhooks.get(Number(r.c.req.param("id")));
    if (!webhook || webhook.kind !== "admin") throw new JiraError(404, ["Webhook not found."]);
    return webhook;
  };

  app.get(
    W,
    handle((r) => {
      requireAdmin(r);
      return r.c.json(
        r.js.webhooks
          .all()
          .filter((w) => w.kind === "admin")
          .map((w) => formatAdmin(r, w)),
      );
    }),
  );

  app.post(
    W,
    handle(async (r) => {
      requireAdmin(r);
      const data = await readAdminBody(r);
      const webhook = insertFrom(r.js.webhooks, 1, { ...data, kind: "admin", client_id: null, expiration_date: null });
      return r.c.json(formatAdmin(r, webhook), 201);
    }),
  );

  app.get(
    `${W}/:id`,
    handle((r) => {
      requireAdmin(r);
      return r.c.json(formatAdmin(r, requireAdminWebhook(r)));
    }),
  );

  app.put(
    `${W}/:id`,
    handle(async (r) => {
      requireAdmin(r);
      const webhook = requireAdminWebhook(r);
      const data = await readAdminBody(r, webhook);
      return r.c.json(formatAdmin(r, r.js.webhooks.update(webhook.id, data)!));
    }),
  );

  app.delete(
    `${W}/:id`,
    handle((r) => {
      requireAdmin(r);
      r.js.webhooks.delete(requireAdminWebhook(r).id);
      return r.c.body(null, 204);
    }),
  );

  // Dynamic webhooks for OAuth 2.0 and Connect apps

  const requireApp = (r: JiraRequest): string => {
    if (!r.clientId) throw new JiraError(403, ["Only Connect and OAuth 2.0 apps can use this operation."]);
    return r.clientId;
  };

  const appWebhooks = (r: JiraRequest, clientId: string) =>
    r.js.webhooks.all().filter((webhook) => webhook.kind === "dynamic" && webhook.client_id === clientId);

  const expiry = () => new Date(Date.now() + DYNAMIC_TTL_MS).toISOString();

  app.post(
    `${API_V}/webhook`,
    handle(
      async (r) => {
        const clientId = requireApp(r);
        const body = await readJson(r.c);
        if (typeof body.url !== "string" || !/^https?:\/\//.test(body.url)) {
          throw new JiraError(400, ["A valid webhook URL is required."]);
        }
        const specs: Array<{ events?: unknown; jqlFilter?: string; fieldIdsFilter?: string[] }> = Array.isArray(
          body.webhooks,
        )
          ? body.webhooks
          : [];
        const webhookRegistrationResult = specs.map((spec) => {
          const errors = [
            eventProblem(spec.events),
            spec.jqlFilter ? jqlProblem(r, spec.jqlFilter) : "The JQL filter is required.",
          ].filter((error): error is string => Boolean(error));
          if (errors.length > 0) return { errors };
          const webhook = insertFrom(r.js.webhooks, 1, {
            name: `${clientId} dynamic webhook`,
            url: body.url,
            events: spec.events as string[],
            jql_filter: spec.jqlFilter ?? null,
            enabled: true,
            exclude_body: false,
            secret: null,
            kind: "dynamic",
            client_id: clientId,
            expiration_date: expiry(),
          });
          return { createdWebhookId: webhook.id };
        });
        return r.c.json({ webhookRegistrationResult });
      },
      { scopes: ["manage:jira-webhook"] },
    ),
  );

  app.get(
    `${API_V}/webhook`,
    handle(
      (r) => {
        const webhooks = appWebhooks(r, requireApp(r));
        const page = paginate(webhooks, pageParams(r.c, 100));
        return r.c.json({
          ...page,
          values: page.values.map((webhook) => ({
            id: webhook.id,
            jqlFilter: webhook.jql_filter,
            events: webhook.events,
            expirationDate: jiraTime(webhook.expiration_date),
          })),
        });
      },
      { scopes: ["manage:jira-webhook"] },
    ),
  );

  app.delete(
    `${API_V}/webhook`,
    handle(
      async (r) => {
        const clientId = requireApp(r);
        const body = await readJson(r.c);
        const ids = new Set((Array.isArray(body.webhookIds) ? body.webhookIds : []).map(Number));
        if (ids.size === 0) throw new JiraError(400, ["webhookIds must not be empty."]);
        for (const webhook of appWebhooks(r, clientId)) if (ids.has(webhook.id)) r.js.webhooks.delete(webhook.id);
        return r.c.body(null, 202);
      },
      { scopes: ["manage:jira-webhook"] },
    ),
  );

  app.put(
    `${API_V}/webhook/refresh`,
    handle(
      async (r) => {
        const clientId = requireApp(r);
        const body = await readJson(r.c);
        const ids = new Set((Array.isArray(body.webhookIds) ? body.webhookIds : []).map(Number));
        const expirationDate = expiry();
        for (const webhook of appWebhooks(r, clientId)) {
          if (ids.has(webhook.id)) r.js.webhooks.update(webhook.id, { expiration_date: expirationDate });
        }
        return r.c.json({ expirationDate: jiraTime(expirationDate) });
      },
      { scopes: ["manage:jira-webhook"] },
    ),
  );
}
