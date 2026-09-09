import type { ZendeskTicket } from "../entities.js";
import { formatComment, formatRequest } from "../formatters.js";
import { api, obj, parseJsonBody, recordNotFound, route, zendeskList } from "../helpers.js";
import { matchTicket, parseSearchQuery } from "../search.js";
import { createTicket, parseTicketInput, updateTicket, WEB_VIA } from "../ticket-service.js";
import { canSeeTicket, findTicket, findUser, idParam, liveTickets, type ZendeskRouteContext } from "../route-utils.js";

export function requestRoutes(rc: ZendeskRouteContext): void {
  const { app, zs, ctx, fmt } = rc;

  const visible = (userId: number) => {
    const user = findUser(zs, userId);
    return liveTickets(zs).filter((ticket) => canSeeTicket(zs, user, ticket));
  };

  const requestList = (filter: (ticket: ZendeskTicket) => boolean) =>
    api(zs, (c, auth) => {
      const status = c.req.query("status");
      const statuses = status ? new Set(status.split(",").map((item) => item.trim())) : null;
      const tickets = visible(auth.user.zd_id)
        .filter(filter)
        .filter((ticket) => !statuses || statuses.has(ticket.status));
      return zendeskList(c, tickets, "requests", (ticket) => formatRequest(fmt, ticket, auth.user.zd_id), {
        sortable: {
          created_at: (ticket) => ticket.created_at,
          updated_at: (ticket) => ticket.updated_at,
          status: (ticket) => ticket.status,
        },
      });
    });

  route(
    app,
    "get",
    "/api/v2/requests",
    requestList(() => true),
  );
  route(
    app,
    "get",
    "/api/v2/requests/open",
    requestList(
      (ticket) =>
        ticket.status === "new" || ticket.status === "open" || ticket.status === "pending" || ticket.status === "hold",
    ),
  );
  route(
    app,
    "get",
    "/api/v2/requests/solved",
    requestList((ticket) => ticket.status === "solved" || ticket.status === "closed"),
  );
  route(
    app,
    "get",
    "/api/v2/requests/ccd",
    api(zs, (c, auth) => {
      const tickets = visible(auth.user.zd_id).filter((ticket) => ticket.email_cc_ids.includes(auth.user.zd_id));
      return zendeskList(c, tickets, "requests", (ticket) => formatRequest(fmt, ticket, auth.user.zd_id));
    }),
  );

  route(
    app,
    "get",
    "/api/v2/requests/search",
    api(zs, (c, auth) => {
      const query = parseSearchQuery(c.req.query("query") ?? "");
      const status = c.req.query("status");
      const organizationId = c.req.query("organization_id");
      const ccId = c.req.query("cc_id");
      let tickets = visible(auth.user.zd_id).filter((ticket) => matchTicket(zs, ticket, query, auth.user));
      if (status) tickets = tickets.filter((ticket) => status.split(",").includes(ticket.status));
      if (organizationId) tickets = tickets.filter((ticket) => String(ticket.organization_id) === organizationId);
      if (ccId) tickets = tickets.filter((ticket) => ticket.email_cc_ids.includes(Number(ccId)));
      return zendeskList(c, tickets, "requests", (ticket) => formatRequest(fmt, ticket, auth.user.zd_id));
    }),
  );

  route(
    app,
    "get",
    "/api/v2/users/:id/requests",
    api(zs, (c, auth) => {
      const user = findUser(zs, idParam(c.req.param("id")));
      if (auth.user.role === "end-user" && auth.user.zd_id !== user.zd_id) throw recordNotFound();
      const tickets = liveTickets(zs).filter((ticket) => ticket.requester_id === user.zd_id);
      return zendeskList(c, tickets, "requests", (ticket) => formatRequest(fmt, ticket, auth.user.zd_id));
    }),
  );

  route(
    app,
    "post",
    "/api/v2/requests",
    api(zs, async (c, auth) => {
      const body = await parseJsonBody(c);
      const input = parseTicketInput(body.request);
      if (auth.user.role === "end-user" || !input.requester) {
        if (auth.user.role === "end-user" || input.requester_id === undefined) {
          input.requester_id = input.requester ? undefined : auth.user.zd_id;
        }
      }
      delete input.assignee_id;
      delete input.group_id;
      delete input.status;
      if (input.comment) input.comment.public = true;
      const { ticket } = await createTicket(ctx, input, auth.user, { via: WEB_VIA });
      return c.json({ request: formatRequest(fmt, ticket, auth.user.zd_id) }, 201);
    }),
  );

  route(
    app,
    "get",
    "/api/v2/requests/:id",
    api(zs, (c, auth) => {
      const ticket = findTicket(zs, idParam(c.req.param("id")));
      if (!canSeeTicket(zs, auth.user, ticket)) throw recordNotFound();
      return c.json({ request: formatRequest(fmt, ticket, auth.user.zd_id) });
    }),
  );

  route(
    app,
    "put",
    "/api/v2/requests/:id",
    api(zs, async (c, auth) => {
      const ticket = findTicket(zs, idParam(c.req.param("id")));
      if (!canSeeTicket(zs, auth.user, ticket)) throw recordNotFound();
      const body = await parseJsonBody(c);
      const raw = obj(body.request);
      const input = parseTicketInput({
        comment: raw.comment,
        solved: raw.solved,
        additional_collaborators: raw.additional_collaborators,
        email_ccs: raw.email_ccs,
      });
      if (raw.solved === true) input.status = "solved";
      if (input.comment) {
        input.comment.public = true;
        input.comment.author_id = auth.user.zd_id;
      }
      const result = await updateTicket(ctx, ticket, input, auth.user, { via: WEB_VIA });
      return c.json({ request: formatRequest(fmt, result.ticket, auth.user.zd_id) });
    }),
  );

  route(
    app,
    "get",
    "/api/v2/requests/:id/comments",
    api(zs, (c, auth) => {
      const ticket = findTicket(zs, idParam(c.req.param("id")));
      if (!canSeeTicket(zs, auth.user, ticket)) throw recordNotFound();
      const comments = zs.comments.findBy("ticket_id", ticket.zd_id).filter((comment) => comment.public);
      return zendeskList(c, comments, "comments", (comment) => formatComment(fmt, comment));
    }),
  );

  route(
    app,
    "get",
    "/api/v2/requests/:id/comments/:commentId",
    api(zs, (c, auth) => {
      const ticket = findTicket(zs, idParam(c.req.param("id")));
      if (!canSeeTicket(zs, auth.user, ticket)) throw recordNotFound();
      const comment = zs.comments.findOneBy("zd_id", idParam(c.req.param("commentId")));
      if (!comment || comment.ticket_id !== ticket.zd_id || !comment.public) throw recordNotFound();
      return c.json({ comment: formatComment(fmt, comment) });
    }),
  );
}
