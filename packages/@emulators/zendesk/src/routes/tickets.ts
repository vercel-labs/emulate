import type { JobResult, ZendeskTicket } from "../entities.js";
import {
  formatAudit,
  formatComment,
  formatJobStatus,
  formatSatisfactionRating,
  formatTicket,
  formatTicketMetrics,
  formatUser,
} from "../formatters.js";
import {
  ZendeskApiError,
  api,
  bool,
  idList,
  list,
  normalizeTags,
  nowIso,
  obj,
  parseJsonBody,
  recordInvalid,
  recordNotFound,
  requireAgent,
  route,
  str,
  strOrNull,
  zendeskList,
} from "../helpers.js";
import { nextId } from "../ids.js";
import { createJob } from "../records.js";
import {
  createTicket,
  deleteTicket,
  macroResult,
  parseTicketInput,
  permanentlyDeleteTicket,
  restoreTicket,
  updateTicket,
} from "../ticket-service.js";
import { emitZendeskEvent } from "../webhooks.js";
import { canSeeTicket, findTicket, idParam, liveTickets, type ZendeskRouteContext } from "../route-utils.js";

export function ticketRoutes(rc: ZendeskRouteContext): void {
  const { app, zs, ctx, fmt } = rc;
  const row = (ticket: ZendeskTicket) => formatTicket(fmt, ticket);
  const sortable = {
    created_at: (ticket: ZendeskTicket) => ticket.created_at_override ?? ticket.created_at,
    updated_at: (ticket: ZendeskTicket) => ticket.updated_at_override ?? ticket.updated_at,
    id: (ticket: ZendeskTicket) => ticket.zd_id,
    status: (ticket: ZendeskTicket) => ticket.status,
    priority: (ticket: ZendeskTicket) => ticket.priority ?? "",
  };

  route(
    app,
    "get",
    "/api/v2/tickets",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const externalId = c.req.query("external_id");
      let tickets = liveTickets(zs);
      if (externalId) tickets = tickets.filter((ticket) => ticket.external_id === externalId);
      return zendeskList(c, tickets, "tickets", row, { sortable });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/tickets/count",
    api(zs, (c, auth) => {
      requireAgent(auth);
      return c.json({ count: { value: liveTickets(zs).length, refreshed_at: nowIso() } });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/tickets/recent",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const tickets = liveTickets(zs).filter((ticket) =>
        zs.audits.findBy("ticket_id", ticket.zd_id).some((audit) => audit.author_id === auth.user.zd_id),
      );
      return zendeskList(c, tickets, "tickets", row, { sortable, defaultSort: "updated_at" });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/tickets/show_many",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const ids = idList(c.req.query("ids"));
      const tickets = liveTickets(zs).filter((ticket) => ids.includes(ticket.zd_id));
      return zendeskList(c, tickets, "tickets", row, { sortable });
    }),
  );

  route(
    app,
    "post",
    "/api/v2/tickets",
    api(zs, async (c, auth) => {
      const body = await parseJsonBody(c);
      const input = parseTicketInput(body.ticket);
      if (auth.user.role === "end-user") {
        input.requester_id = auth.user.zd_id;
        delete input.requester;
        delete input.assignee_id;
        delete input.group_id;
        delete input.status;
      }
      const { ticket, audit } = await createTicket(ctx, input, auth.user);
      return c.json({ ticket: row(ticket), audit: formatAudit(fmt, audit) }, 201);
    }),
  );

  const bulkCreate = (isImport: boolean) =>
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const body = await parseJsonBody(c);
      const results: JobResult[] = [];
      for (const [index, item] of list(body.tickets).map(obj).entries()) {
        try {
          const { ticket } = await createTicket(ctx, parseTicketInput(item), auth.user, {
            isImport,
            runTriggers: !isImport,
          });
          results.push({ id: ticket.zd_id, index, account_id: 1, success: true, status: "Created", action: "create" });
        } catch (error) {
          if (!(error instanceof ZendeskApiError)) throw error;
          results.push({
            index,
            success: false,
            status: "Failed",
            action: "create",
            errors: error.body.description ?? error.body.error,
            details: JSON.stringify(error.body.details ?? {}),
          });
        }
      }
      return c.json({ job_status: formatJobStatus(fmt, createJob(zs, results, "Completed")) });
    });

  route(app, "post", "/api/v2/tickets/create_many", bulkCreate(false));
  route(app, "post", "/api/v2/imports/tickets/create_many", bulkCreate(true));

  route(
    app,
    "post",
    "/api/v2/imports/tickets",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const body = await parseJsonBody(c);
      const { ticket } = await createTicket(ctx, parseTicketInput(body.ticket), auth.user, {
        isImport: true,
        runTriggers: false,
      });
      return c.json({ ticket: row(ticket) }, 201);
    }),
  );

  route(
    app,
    "put",
    "/api/v2/tickets/update_many",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const body = await parseJsonBody(c);
      const ids = idList(c.req.query("ids"));
      const results: JobResult[] = [];
      if (ids.length > 0) {
        const input = parseTicketInput(body.ticket);
        for (const [index, id] of ids.entries()) {
          const ticket = zs.tickets.findOneBy("zd_id", id);
          if (!ticket || ticket.deleted) {
            results.push({ id, index, success: false, status: "Failed", action: "update", errors: "TicketNotFound" });
            continue;
          }
          try {
            await updateTicket(ctx, ticket, input, auth.user);
            results.push({ id, index, success: true, status: "Updated", action: "update" });
          } catch (error) {
            if (!(error instanceof ZendeskApiError)) throw error;
            results.push({
              id,
              index,
              success: false,
              status: "Failed",
              action: "update",
              errors: error.body.description ?? error.body.error,
            });
          }
        }
      } else {
        for (const [index, item] of list(body.tickets).map(obj).entries()) {
          const input = parseTicketInput(item);
          const ticket = input.id !== undefined ? zs.tickets.findOneBy("zd_id", input.id) : undefined;
          if (!ticket || ticket.deleted) {
            results.push({
              id: input.id,
              index,
              success: false,
              status: "Failed",
              action: "update",
              errors: "TicketNotFound",
            });
            continue;
          }
          try {
            await updateTicket(ctx, ticket, input, auth.user);
            results.push({ id: ticket.zd_id, index, success: true, status: "Updated", action: "update" });
          } catch (error) {
            if (!(error instanceof ZendeskApiError)) throw error;
            results.push({
              id: ticket.zd_id,
              index,
              success: false,
              status: "Failed",
              action: "update",
              errors: error.body.description ?? error.body.error,
            });
          }
        }
      }
      return c.json({ job_status: formatJobStatus(fmt, createJob(zs, results, "Completed")) });
    }),
  );

  route(
    app,
    "delete",
    "/api/v2/tickets/destroy_many",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const results: JobResult[] = [];
      for (const [index, id] of idList(c.req.query("ids")).entries()) {
        const ticket = zs.tickets.findOneBy("zd_id", id);
        if (!ticket || ticket.deleted) {
          results.push({ id, index, success: false, status: "Failed", action: "destroy", errors: "TicketNotFound" });
          continue;
        }
        await deleteTicket(ctx, ticket, auth.user);
        results.push({ id, index, success: true, status: "Deleted", action: "destroy" });
      }
      return c.json({ job_status: formatJobStatus(fmt, createJob(zs, results, "Completed")) });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/tickets/:id",
    api(zs, (c, auth) => {
      const ticket = findTicket(zs, idParam(c.req.param("id")));
      if (!canSeeTicket(zs, auth.user, ticket)) throw recordNotFound();
      return c.json({ ticket: row(ticket) });
    }),
  );

  route(
    app,
    "put",
    "/api/v2/tickets/:id",
    api(zs, async (c, auth) => {
      const ticket = findTicket(zs, idParam(c.req.param("id")));
      if (!canSeeTicket(zs, auth.user, ticket)) throw recordNotFound();
      const body = await parseJsonBody(c);
      const input = parseTicketInput(body.ticket);
      if (auth.user.role === "end-user") {
        const allowed = { comment: input.comment, status: input.status === "solved" ? input.status : undefined };
        Object.assign(
          input,
          {
            assignee_id: undefined,
            group_id: undefined,
            tags: undefined,
            priority: undefined,
            type: undefined,
            custom_fields: undefined,
            requester_id: undefined,
          },
          allowed,
        );
        if (input.comment) input.comment.public = true;
      }
      const result = await updateTicket(ctx, ticket, input, auth.user);
      return c.json({ ticket: row(result.ticket), ...(result.audit ? { audit: formatAudit(fmt, result.audit) } : {}) });
    }),
  );

  route(
    app,
    "delete",
    "/api/v2/tickets/:id",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const ticket = findTicket(zs, idParam(c.req.param("id")));
      await deleteTicket(ctx, ticket, auth.user);
      return c.body(null, 204);
    }),
  );

  route(
    app,
    "put",
    "/api/v2/tickets/:id/mark_as_spam",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const ticket = findTicket(zs, idParam(c.req.param("id")));
      zs.tickets.update(ticket.id, { spam: true });
      await deleteTicket(ctx, ticket, auth.user);
      const requester = zs.users.findOneBy("zd_id", ticket.requester_id);
      if (requester) zs.users.update(requester.id, { suspended: true });
      return c.json({ ticket: row(zs.tickets.get(ticket.id)!) });
    }),
  );

  route(
    app,
    "post",
    "/api/v2/tickets/:id/merge",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const target = findTicket(zs, idParam(c.req.param("id")));
      const body = await parseJsonBody(c);
      const ids = idList(body.ids);
      const results: JobResult[] = [];
      for (const [index, id] of ids.entries()) {
        const source = zs.tickets.findOneBy("zd_id", id);
        if (!source || source.deleted || source.zd_id === target.zd_id) {
          results.push({ id, index, success: false, status: "Failed", action: "merge", errors: "TicketNotFound" });
          continue;
        }
        await updateTicket(
          ctx,
          target,
          {
            comment: {
              body:
                str(body.target_comment) ??
                `Request #${source.zd_id} "${source.subject}" was closed and merged into this request.`,
              public: bool(body.target_comment_is_public) ?? false,
            },
          },
          auth.user,
        );
        await updateTicket(
          ctx,
          source,
          {
            status: "closed",
            comment: {
              body:
                str(body.source_comment) ??
                `This request was closed and merged into request #${target.zd_id} "${target.subject}".`,
              public: bool(body.source_comment_is_public) ?? false,
            },
          },
          auth.user,
          { isImport: true },
        );
        results.push({ id, index, success: true, status: "Merged", action: "merge" });
      }
      return c.json({ job_status: formatJobStatus(fmt, createJob(zs, results, "Completed")) });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/tickets/:id/comments",
    api(zs, (c, auth) => {
      const ticket = findTicket(zs, idParam(c.req.param("id")));
      if (!canSeeTicket(zs, auth.user, ticket)) throw recordNotFound();
      let comments = zs.comments.findBy("ticket_id", ticket.zd_id);
      if (auth.user.role === "end-user") comments = comments.filter((comment) => comment.public);
      const sortOrder = c.req.query("sort_order") ?? (c.req.query("sort") === "-created_at" ? "desc" : "asc");
      comments.sort((a, b) => (sortOrder === "desc" ? b.id - a.id : a.id - b.id));
      return zendeskList(c, comments, "comments", (comment) => formatComment(fmt, comment), {
        defaultSort: undefined,
        sortable: { created_at: (comment) => comment.created_at },
      });
    }),
  );

  route(
    app,
    "put",
    "/api/v2/tickets/:id/comments/:commentId/make_private",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const ticket = findTicket(zs, idParam(c.req.param("id")));
      const comment = zs.comments.findOneBy("zd_id", idParam(c.req.param("commentId")));
      if (!comment || comment.ticket_id !== ticket.zd_id) throw recordNotFound();
      zs.comments.update(comment.id, { public: false });
      return c.json({});
    }),
  );

  route(
    app,
    "put",
    "/api/v2/tickets/:id/comments/:commentId/redact",
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const ticket = findTicket(zs, idParam(c.req.param("id")));
      const comment = zs.comments.findOneBy("zd_id", idParam(c.req.param("commentId")));
      if (!comment || comment.ticket_id !== ticket.zd_id) throw recordNotFound();
      const body = await parseJsonBody(c);
      const text = str(body.text);
      if (!text) throw recordInvalid({ text: "Text: cannot be blank" });
      const updated = zs.comments.update(comment.id, {
        body: comment.body.split(text).join("▇▇▇▇"),
        html_body: comment.html_body.split(text).join("▇▇▇▇"),
      })!;
      return c.json({ comment: formatComment(fmt, updated) });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/tickets/:id/audits",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const ticket = findTicket(zs, idParam(c.req.param("id")));
      return zendeskList(c, zs.audits.findBy("ticket_id", ticket.zd_id), "audits", (audit) => formatAudit(fmt, audit));
    }),
  );

  route(
    app,
    "get",
    "/api/v2/tickets/:id/audits/:auditId",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const ticket = findTicket(zs, idParam(c.req.param("id")));
      const audit = zs.audits.findOneBy("zd_id", idParam(c.req.param("auditId")));
      if (!audit || audit.ticket_id !== ticket.zd_id) throw recordNotFound();
      return c.json({ audit: formatAudit(fmt, audit) });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/ticket_audits",
    api(zs, (c, auth) => {
      requireAgent(auth);
      return zendeskList(c, zs.audits.all(), "audits", (audit) => formatAudit(fmt, audit), { cursorOnly: true });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/tickets/:id/metrics",
    api(zs, (c, auth) => {
      requireAgent(auth);
      return c.json({ ticket_metric: formatTicketMetrics(fmt, findTicket(zs, idParam(c.req.param("id")))) });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/ticket_metrics",
    api(zs, (c, auth) => {
      requireAgent(auth);
      return zendeskList(c, liveTickets(zs), "ticket_metrics", (ticket) => formatTicketMetrics(fmt, ticket));
    }),
  );

  route(
    app,
    "get",
    "/api/v2/ticket_metrics/:id",
    api(zs, (c, auth) => {
      requireAgent(auth);
      return c.json({ ticket_metric: formatTicketMetrics(fmt, findTicket(zs, idParam(c.req.param("id")))) });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/tickets/:id/tags",
    api(zs, (c, auth) => {
      const ticket = findTicket(zs, idParam(c.req.param("id")));
      if (!canSeeTicket(zs, auth.user, ticket)) throw recordNotFound();
      return c.json({ tags: ticket.tags });
    }),
  );

  const setTags = (mode: "set" | "add" | "remove") =>
    api(zs, async (c, auth) => {
      requireAgent(auth);
      const ticket = findTicket(zs, idParam(c.req.param("id")));
      const body = await parseJsonBody(c);
      const tags = normalizeTags(body.tags);
      const result = await updateTicket(
        ctx,
        ticket,
        mode === "set" ? { tags } : mode === "add" ? { additional_tags: tags } : { remove_tags: tags },
        auth.user,
      );
      return c.json({ tags: result.ticket.tags }, mode === "add" ? 201 : 200);
    });

  route(app, "post", "/api/v2/tickets/:id/tags", setTags("set"));
  route(app, "put", "/api/v2/tickets/:id/tags", setTags("add"));
  route(app, "delete", "/api/v2/tickets/:id/tags", setTags("remove"));

  route(
    app,
    "get",
    "/api/v2/tickets/:id/incidents",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const ticket = findTicket(zs, idParam(c.req.param("id")));
      return zendeskList(
        c,
        liveTickets(zs).filter((candidate) => candidate.problem_id === ticket.zd_id),
        "tickets",
        row,
      );
    }),
  );

  route(
    app,
    "get",
    "/api/v2/problems",
    api(zs, (c, auth) => {
      requireAgent(auth);
      return zendeskList(
        c,
        liveTickets(zs).filter((ticket) => ticket.type === "problem"),
        "tickets",
        row,
      );
    }),
  );

  const userList = (key: string, pick: (ticket: ZendeskTicket) => number[]) =>
    api(zs, (c, auth) => {
      const ticket = findTicket(zs, idParam(c.req.param("id")));
      if (!canSeeTicket(zs, auth.user, ticket)) throw recordNotFound();
      const users = pick(ticket)
        .map((id) => zs.users.findOneBy("zd_id", id))
        .filter((user): user is NonNullable<typeof user> => !!user);
      return zendeskList(c, users, key, (user) => formatUser(fmt, user));
    });

  route(
    app,
    "get",
    "/api/v2/tickets/:id/collaborators",
    userList("users", (ticket) => ticket.collaborator_ids),
  );
  route(
    app,
    "get",
    "/api/v2/tickets/:id/followers",
    userList("users", (ticket) => ticket.follower_ids),
  );
  route(
    app,
    "get",
    "/api/v2/tickets/:id/email_ccs",
    userList("users", (ticket) => ticket.email_cc_ids),
  );

  route(
    app,
    "get",
    "/api/v2/tickets/:id/satisfaction_rating",
    api(zs, (c, auth) => {
      const ticket = findTicket(zs, idParam(c.req.param("id")));
      if (!canSeeTicket(zs, auth.user, ticket)) throw recordNotFound();
      const rating = ticket.satisfaction_rating_id
        ? zs.satisfactionRatings.findOneBy("zd_id", ticket.satisfaction_rating_id)
        : undefined;
      if (!rating) throw recordNotFound();
      return c.json({ satisfaction_rating: formatSatisfactionRating(fmt, rating) });
    }),
  );

  route(
    app,
    "post",
    "/api/v2/tickets/:id/satisfaction_rating",
    api(zs, async (c, auth) => {
      const ticket = findTicket(zs, idParam(c.req.param("id")));
      if (!canSeeTicket(zs, auth.user, ticket)) throw recordNotFound();
      if (ticket.status !== "solved" && ticket.status !== "closed")
        throw recordInvalid({ base: "Satisfaction ratings can only be submitted for solved tickets" });
      const body = await parseJsonBody(c);
      const input = obj(body.satisfaction_rating);
      const score = str(input.score);
      if (score !== "good" && score !== "bad") throw recordInvalid({ score: "Score: must be good or bad" });
      const existing = ticket.satisfaction_rating_id
        ? zs.satisfactionRatings.findOneBy("zd_id", ticket.satisfaction_rating_id)
        : undefined;
      const rating = existing
        ? zs.satisfactionRatings.update(existing.id, { score, comment: strOrNull(input.comment) })!
        : zs.satisfactionRatings.insert({
            zd_id: nextId(zs, "satisfaction_ratings"),
            ticket_id: ticket.zd_id,
            requester_id: ticket.requester_id,
            assignee_id: ticket.assignee_id,
            group_id: ticket.group_id,
            score,
            comment: strOrNull(input.comment),
          });
      zs.tickets.update(ticket.id, { satisfaction_rating_id: rating.zd_id });
      await emitZendeskEvent(
        ctx,
        "zen:event-type:ticket.satisfaction_rating_changed",
        `zen:ticket:${ticket.zd_id}`,
        { id: ticket.zd_id },
        { current: score },
      );
      return c.json({ satisfaction_rating: formatSatisfactionRating(fmt, rating) }, existing ? 200 : 201);
    }),
  );

  route(
    app,
    "get",
    "/api/v2/tickets/:id/macros/:macroId/apply",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const ticket = findTicket(zs, idParam(c.req.param("id")));
      const macro = zs.macros.findOneBy("zd_id", idParam(c.req.param("macroId")));
      if (!macro) throw recordNotFound();
      const result = macroResult(zs, macro, ticket, auth.user);
      return c.json({
        result: {
          ticket: { ...row(ticket), ...result, url: undefined },
          ...(result.comment ? { comment: result.comment } : {}),
        },
      });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/deleted_tickets",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const deleted = zs.tickets.all().filter((ticket) => ticket.deleted);
      return zendeskList(c, deleted, "deleted_tickets", (ticket) => ({
        id: ticket.zd_id,
        subject: ticket.subject,
        description: ticket.description,
        deleted_at: ticket.deleted_at,
        previous_state: ticket.spam ? "spam" : "open",
        actor: { id: auth.user.zd_id, name: auth.user.name },
      }));
    }),
  );

  route(
    app,
    "put",
    "/api/v2/deleted_tickets/:id/restore",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const ticket = findTicket(zs, idParam(c.req.param("id")), true);
      if (!ticket.deleted) throw recordNotFound();
      restoreTicket(zs, ticket);
      return c.json({});
    }),
  );

  route(
    app,
    "put",
    "/api/v2/deleted_tickets/restore_many",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const results: JobResult[] = [];
      for (const [index, id] of idList(c.req.query("ids")).entries()) {
        const ticket = zs.tickets.findOneBy("zd_id", id);
        if (!ticket || !ticket.deleted) {
          results.push({ id, index, success: false, status: "Failed", action: "restore", errors: "TicketNotFound" });
          continue;
        }
        restoreTicket(zs, ticket);
        results.push({ id, index, success: true, status: "Restored", action: "restore" });
      }
      return c.json({ job_status: formatJobStatus(fmt, createJob(zs, results, "Completed")) });
    }),
  );

  route(
    app,
    "delete",
    "/api/v2/deleted_tickets/:id",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const ticket = findTicket(zs, idParam(c.req.param("id")), true);
      if (!ticket.deleted) throw recordNotFound();
      permanentlyDeleteTicket(zs, ticket);
      return c.json({
        job_status: formatJobStatus(
          fmt,
          createJob(
            zs,
            [{ id: ticket.zd_id, index: 0, success: true, status: "Deleted", action: "destroy" }],
            "Completed",
          ),
        ),
      });
    }),
  );

  route(
    app,
    "delete",
    "/api/v2/deleted_tickets/destroy_many",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const results: JobResult[] = [];
      for (const [index, id] of idList(c.req.query("ids")).entries()) {
        const ticket = zs.tickets.findOneBy("zd_id", id);
        if (!ticket || !ticket.deleted) {
          results.push({ id, index, success: false, status: "Failed", action: "destroy", errors: "TicketNotFound" });
          continue;
        }
        permanentlyDeleteTicket(zs, ticket);
        results.push({ id, index, success: true, status: "Deleted", action: "destroy" });
      }
      return c.json({ job_status: formatJobStatus(fmt, createJob(zs, results, "Completed")) });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/satisfaction_ratings",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const score = c.req.query("score");
      let ratings = zs.satisfactionRatings.all();
      if (score) ratings = ratings.filter((rating) => rating.score === score);
      return zendeskList(c, ratings, "satisfaction_ratings", (rating) => formatSatisfactionRating(fmt, rating));
    }),
  );

  route(
    app,
    "get",
    "/api/v2/satisfaction_ratings/:id",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const rating = zs.satisfactionRatings.findOneBy("zd_id", idParam(c.req.param("id")));
      if (!rating) throw recordNotFound();
      return c.json({ satisfaction_rating: formatSatisfactionRating(fmt, rating) });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/tickets/:id/related",
    api(zs, (c, auth) => {
      requireAgent(auth);
      const ticket = findTicket(zs, idParam(c.req.param("id")));
      return c.json({
        ticket_related: {
          topic_id: null,
          jira_issue_ids: [],
          followup_source_ids: [],
          from_archive: false,
          incidents: liveTickets(zs).filter((candidate) => candidate.problem_id === ticket.zd_id).length,
          twitter: {},
        },
      });
    }),
  );
}
