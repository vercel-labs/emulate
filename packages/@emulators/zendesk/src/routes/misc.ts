import type { ZendeskTicket } from "../entities.js";
import {
  formatAttachment,
  formatJobStatus,
  formatOrganization,
  formatTicket,
  formatTicketMetrics,
  formatUser,
  ticketCreatedAt,
  ticketUpdatedAt,
} from "../formatters.js";
import {
  api,
  idList,
  invalidValue,
  isoSeconds,
  nowIso,
  parseJsonBody,
  recordInvalid,
  recordNotFound,
  requireAgent,
  route,
  str,
  stringList,
} from "../helpers.js";
import { hexToken, nextId } from "../ids.js";
import { ensureEndUser } from "../records.js";
import { accountId, subdomain } from "../store.js";
import { createTicket, emailVia, updateTicket } from "../ticket-service.js";
import { idParam, liveOrganizations, liveTickets, liveUsers, type ZendeskRouteContext } from "../route-utils.js";

const INCREMENTAL_PAGE = 1000;

export function miscRoutes(rc: ZendeskRouteContext): void {
  const { app, zs, ctx, fmt, baseUrl } = rc;

  route(
    app,
    "get",
    "/api/v2/account/settings",
    api(zs, (c) =>
      c.json({
        settings: {
          branding: {
            header_color: "1F73B7",
            page_background_color: "F8F9F9",
            tab_background_color: "1F73B7",
            text_color: "FFFFFF",
          },
          apps: { use: true, create_private: true },
          tickets: {
            comments_public_by_default: true,
            list_newest_comments_first: false,
            collaboration: true,
            agent_collision: false,
            tagging: true,
            emoji_autocompletion: true,
            markdown_ticket_comments: true,
          },
          active_features: {
            on_hold_status: true,
            user_tagging: true,
            ticket_tagging: true,
            customer_satisfaction: true,
            organization_access_enabled: true,
          },
          users: {
            tagging: true,
            time_zone_selection: true,
            language_selection: true,
            agent_created_welcome_emails: false,
            end_user_phone_number_validation: false,
          },
          lotus: { prefer_lotus: true, reporting: true },
          brands: {
            default_brand_id: zs.brands.all().find((brand) => brand.default)?.zd_id ?? 1,
            require_brand_on_new_tickets: false,
          },
          statistics: { forum: true, search: true, rule_usage: true },
          api: { accepted_api_agreement: true, api_password_access: "true", api_token_access: "true" },
          ticket_form: { ticket_forms_instructions: "" },
          limits: { attachment_size: 52428800 },
          localization: { locale_ids: [1] },
          metrics: { account_size: "small" },
        },
      }),
    ),
  );

  route(
    app,
    "get",
    "/api/v2/locales",
    api(zs, (c) =>
      c.json({
        locales: [
          {
            id: 1,
            url: `${baseUrl}/api/v2/locales/1.json`,
            locale: "en-US",
            name: "English",
            native_name: "English (United States)",
            presentation_name: "English (United States)",
            rtl: false,
            default: true,
            created_at: nowIso(),
            updated_at: nowIso(),
          },
          {
            id: 16,
            url: `${baseUrl}/api/v2/locales/16.json`,
            locale: "fr",
            name: "Français",
            native_name: "Français",
            presentation_name: "French",
            rtl: false,
            default: false,
            created_at: nowIso(),
            updated_at: nowIso(),
          },
        ],
      }),
    ),
  );

  route(
    app,
    "get",
    "/api/v2/locales/current",
    api(zs, (c, auth) => {
      const locale = auth.user.locale.startsWith("fr")
        ? { id: 16, locale: "fr", name: "Français" }
        : { id: 1, locale: "en-US", name: "English" };
      return c.json({
        locale: {
          ...locale,
          url: `${baseUrl}/api/v2/locales/${locale.id}.json`,
          native_name: locale.name,
          presentation_name: locale.name,
          rtl: false,
          default: locale.id === 1,
          created_at: nowIso(),
          updated_at: nowIso(),
        },
      });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/job_statuses",
    api(zs, (c, auth) => {
      requireAgent(auth);
      return c.json({
        job_statuses: zs.jobStatuses.all().map((job) => formatJobStatus(fmt, job)),
        next_page: null,
        previous_page: null,
        count: zs.jobStatuses.count(),
      });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/job_statuses/show_many",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const ids = new Set(stringList(c.req.query("ids")));
      return c.json({
        job_statuses: zs.jobStatuses
          .all()
          .filter((job) => ids.has(job.zd_id))
          .map((job) => formatJobStatus(fmt, job)),
      });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/job_statuses/:id",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const job = zs.jobStatuses.findOneBy("zd_id", c.req.param("id").replace(/\.json$/, ""));
      if (!job) throw recordNotFound();
      return c.json({ job_status: formatJobStatus(fmt, job) });
    }),
  );

  function incremental<T extends { updated_at: string }>(
    c: Parameters<Parameters<typeof api>[1]>[0],
    key: string,
    items: T[],
    updatedAt: (item: T) => string,
    format: (item: T) => Record<string, unknown>,
  ): Response {
    const startParam = c.req.query("start_time");
    const cursorParam = c.req.query("cursor");
    let startTime: number;
    if (cursorParam) {
      const decoded = Number(Buffer.from(cursorParam, "base64url").toString("utf8"));
      if (!Number.isFinite(decoded)) throw invalidValue("cursor is invalid");
      startTime = decoded;
    } else {
      const parsed = Number(startParam);
      if (!Number.isFinite(parsed)) throw invalidValue("start_time is required");
      startTime = parsed;
    }
    const sorted = items
      .map((item) => ({ item, time: isoSeconds(updatedAt(item)) }))
      .filter(({ time }) => time >= startTime)
      .sort((a, b) => a.time - b.time);
    const page = sorted.slice(0, INCREMENTAL_PAGE);
    const endOfStream = sorted.length <= INCREMENTAL_PAGE;
    const endTime = page.length > 0 ? page[page.length - 1].time : Math.floor(Date.now() / 1000);
    const nextStart = endOfStream ? endTime : endTime;
    const cursor = Buffer.from(String(nextStart + (endOfStream ? 1 : 0))).toString("base64url");
    const url = new URL(c.req.url);
    const nextUrl = new URL(url.toString());
    nextUrl.searchParams.delete("start_time");
    nextUrl.searchParams.set("cursor", cursor);
    const legacyNext = new URL(url.toString());
    legacyNext.searchParams.set("start_time", String(endTime));
    return c.json({
      [key]: page.map(({ item }) => format(item)),
      count: page.length,
      end_time: endTime,
      next_page: url.pathname.includes("/cursor") ? null : legacyNext.toString(),
      end_of_stream: endOfStream,
      after_url: nextUrl.toString(),
      after_cursor: cursor,
    });
  }

  const ticketIncremental = api(zs, (c, auth) => {
    requireAgent(auth);
    const include = stringList(c.req.query("include"));
    return incremental(c, "tickets", zs.tickets.all(), ticketUpdatedAt, (ticket) => ({
      ...formatTicket(fmt, ticket),
      ...(include.includes("metric_sets") ? { metric_set: formatTicketMetrics(fmt, ticket) } : {}),
      ...(ticket.deleted ? { status: "deleted" } : {}),
    }));
  });
  route(app, "get", "/api/v2/incremental/tickets", ticketIncremental);
  route(app, "get", "/api/v2/incremental/tickets/cursor", ticketIncremental);

  route(
    app,
    "get",
    "/api/v2/incremental/users",
    api(zs, (c, auth) => {
      requireAgent(auth);
      return incremental(
        c,
        "users",
        zs.users.all(),
        (user) => user.updated_at,
        (user) => formatUser(fmt, user),
      );
    }),
  );
  route(
    app,
    "get",
    "/api/v2/incremental/users/cursor",
    api(zs, (c, auth) => {
      requireAgent(auth);
      return incremental(
        c,
        "users",
        zs.users.all(),
        (user) => user.updated_at,
        (user) => formatUser(fmt, user),
      );
    }),
  );

  route(
    app,
    "get",
    "/api/v2/incremental/organizations",
    api(zs, (c, auth) => {
      requireAgent(auth);
      return incremental(
        c,
        "organizations",
        zs.organizations.all(),
        (organization) => organization.updated_at,
        (organization) => formatOrganization(fmt, organization),
      );
    }),
  );

  route(
    app,
    "get",
    "/api/v2/incremental/ticket_events",
    api(zs, (c, auth) => {
      requireAgent(auth);
      return incremental(
        c,
        "ticket_events",
        zs.audits.all(),
        (audit) => audit.created_at,
        (audit) => ({
          id: audit.zd_id,
          ticket_id: audit.ticket_id,
          timestamp: isoSeconds(audit.created_at),
          created_at: audit.created_at,
          updater_id: audit.author_id,
          via: audit.via.channel,
          system: {},
          event_type: "Audit",
          child_events: audit.events,
        }),
      );
    }),
  );

  route(
    app,
    "get",
    "/api/v2/incremental/ticket_metric_events",
    api(zs, (c, auth) => {
      requireAgent(auth);
      return incremental(c, "ticket_metric_events", zs.tickets.all(), ticketUpdatedAt, (ticket) => ({
        id: ticket.zd_id,
        ticket_id: ticket.zd_id,
        metric: "resolution_time",
        instance_id: 1,
        type: ticket.metrics.solved_at ? "fulfill" : "activate",
        time: ticketUpdatedAt(ticket),
      }));
    }),
  );

  app.post("/api/v2/uploads", uploadHandler());
  app.post("/api/v2/uploads.json", uploadHandler());

  function uploadHandler() {
    return api(zs, async (c) => {
      const filename = c.req.query("filename");
      if (!filename) throw invalidValue("filename is required");
      const buffer = Buffer.from(await c.req.arrayBuffer());
      const contentType = c.req.header("Content-Type") ?? "application/octet-stream";
      const existingToken = c.req.query("token");
      const token = existingToken && zs.attachments.findOneBy("token", existingToken) ? existingToken : hexToken(20);
      const attachment = zs.attachments.insert({
        zd_id: nextId(zs, "attachments"),
        token,
        file_name: filename,
        content_type: contentType.split(";")[0],
        size: buffer.length,
        content: buffer.toString("base64"),
        comment_id: null,
        inline: c.req.query("inline") === "true",
      });
      const attachments = zs.attachments.findBy("token", token).map((item) => formatAttachment(fmt, item));
      return c.json(
        { upload: { token, expires_at: nowIso(), attachment: formatAttachment(fmt, attachment), attachments } },
        201,
      );
    });
  }

  route(
    app,
    "delete",
    "/api/v2/uploads/:token",
    api(zs, (c) => {
      const token = c.req.param("token").replace(/\.json$/, "");
      const attachments = zs.attachments.findBy("token", token);
      if (attachments.length === 0) throw recordNotFound();
      for (const attachment of attachments) zs.attachments.delete(attachment.id);
      return c.body(null, 204);
    }),
  );

  route(
    app,
    "get",
    "/api/v2/attachments/:id",
    api(zs, (c) => {
      const attachment = zs.attachments.findOneBy("zd_id", idParam(c.req.param("id")));
      if (!attachment) throw recordNotFound();
      return c.json({ attachment: formatAttachment(fmt, attachment) });
    }),
  );

  route(
    app,
    "delete",
    "/api/v2/attachments/:id",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const attachment = zs.attachments.findOneBy("zd_id", idParam(c.req.param("id")));
      if (!attachment) throw recordNotFound();
      zs.attachments.delete(attachment.id);
      return c.body(null, 204);
    }),
  );

  app.get("/_zendesk/attachments/:id/:filename", (c) => {
    const attachment = zs.attachments.findOneBy("zd_id", Number(c.req.param("id")));
    if (!attachment) return c.text("Attachment not found", 404);
    return c.body(Buffer.from(attachment.content, "base64"), 200, {
      "Content-Type": attachment.content_type,
      "Content-Disposition": `inline; filename="${attachment.file_name.replace(/"/g, "")}"`,
    });
  });

  route(
    app,
    "post",
    "/_zendesk/simulate/inbound-email",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const body = await parseJsonBody(c);
      const from = str(body.from);
      const subject = str(body.subject);
      const text = str(body.body) ?? str(body.text);
      if (!from) throw recordInvalid({ from: "From: cannot be blank" });
      if (!text) throw recordInvalid({ body: "Body: cannot be blank" });
      const fromName = str(body.from_name) ?? null;
      const to = str(body.to) ?? `support@${subdomain(zs)}.zendesk.com`;
      const requester = await ensureEndUser(ctx, { email: from, name: fromName });
      const via = emailVia({ address: from, name: fromName ?? requester.name }, { address: to, name: "Support" });
      const ticketId = body.ticket_id !== undefined ? Number(body.ticket_id) : undefined;
      if (ticketId !== undefined) {
        const ticket = zs.tickets.findOneBy("zd_id", ticketId);
        if (!ticket || ticket.deleted) throw recordNotFound();
        const result = await updateTicket(
          ctx,
          ticket,
          { comment: { body: text, public: true, author_id: requester.zd_id } },
          requester,
          { via },
        );
        return c.json({ ticket: formatTicket(fmt, result.ticket) });
      }
      const { ticket } = await createTicket(
        ctx,
        {
          subject: subject ?? text.split("\n")[0].slice(0, 150),
          comment: { body: text, public: true, author_id: requester.zd_id },
          requester_id: requester.zd_id,
          recipient: to,
          tags: stringList(body.tags),
        },
        requester,
        { via },
      );
      return c.json({ ticket: formatTicket(fmt, ticket) }, 201);
    }),
  );

  route(
    app,
    "get",
    "/_zendesk/simulate/summary",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const tickets = liveTickets(zs);
      const byStatus = tickets.reduce<Record<string, number>>((acc, ticket: ZendeskTicket) => {
        acc[ticket.status] = (acc[ticket.status] ?? 0) + 1;
        return acc;
      }, {});
      return c.json({
        account_id: accountId(zs),
        subdomain: subdomain(zs),
        tickets: tickets.length,
        tickets_by_status: byStatus,
        users: liveUsers(zs).length,
        organizations: liveOrganizations(zs).length,
        webhooks: zs.webhooks.count(),
        webhook_invocations: zs.webhookInvocations.count(),
        events: zs.events.count(),
        oldest_ticket: tickets.length > 0 ? ticketCreatedAt(tickets[0]) : null,
      });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/sharing_agreements",
    api(zs, (c) => c.json({ sharing_agreements: [] })),
  );

  route(
    app,
    "get",
    "/api/v2/ticket_forms/show_many",
    api(zs, (c) => {
      const ids = idList(c.req.query("ids"));
      return c.json({
        ticket_forms: zs.ticketForms
          .all()
          .filter((form) => ids.includes(form.zd_id))
          .map((form) => ({
            id: form.zd_id,
            name: form.name,
            active: form.active,
            default: form.default,
            ticket_field_ids: form.ticket_field_ids,
          })),
      });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/activities",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const activities = zs.audits
        .all()
        .filter((audit) => audit.author_id !== auth.user.zd_id)
        .slice(-100)
        .map((audit) => ({
          id: audit.zd_id,
          url: `${baseUrl}/api/v2/activities/${audit.zd_id}.json`,
          verb: audit.events.some((event) => event.type === "Comment") ? "tickets.comment" : "tickets.update",
          title: `Ticket #${audit.ticket_id} updated`,
          created_at: audit.created_at,
          updated_at: audit.created_at,
          actor_id: audit.author_id,
          user_id: auth.user.zd_id,
          target: { ticket: { id: audit.ticket_id } },
        }));
      return c.json({ activities, count: activities.length, next_page: null, previous_page: null });
    }),
  );
}
