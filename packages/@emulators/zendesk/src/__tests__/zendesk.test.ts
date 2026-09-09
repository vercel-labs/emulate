import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_AGENT_EMAIL,
  DEFAULT_API_TOKEN,
  DEFAULT_CATEGORY_FIELD_TITLE,
  DEFAULT_END_USER_EMAIL,
  DEFAULT_ORGANIZATION_NAME,
} from "../index.js";
import {
  api,
  createZendeskTestApp,
  passwordAuth,
  tokenAuth,
  zendeskTestBaseUrl,
  type ZendeskTestApp,
} from "./helpers.js";

async function seededIds(ctx: ZendeskTestApp) {
  const users = await api(ctx.app, "GET", "/users");
  const byEmail = (email: string) => users.body.users.find((user: any) => user.email === email);
  const organizations = await api(ctx.app, "GET", "/organizations");
  const tickets = await api(ctx.app, "GET", "/tickets");
  return {
    admin: byEmail(DEFAULT_ADMIN_EMAIL),
    agent: byEmail(DEFAULT_AGENT_EMAIL),
    endUser: byEmail(DEFAULT_END_USER_EMAIL),
    organization: organizations.body.organizations.find((org: any) => org.name === DEFAULT_ORGANIZATION_NAME),
    ticket: tickets.body.tickets[0],
  };
}

describe("Zendesk plugin", () => {
  let ctx: ZendeskTestApp;

  beforeEach(() => {
    ctx = createZendeskTestApp();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("authentication", () => {
    it("rejects missing or invalid credentials", async () => {
      const missing = await ctx.app.request(`${zendeskTestBaseUrl}/api/v2/users/me.json`);
      expect(missing.status).toBe(401);
      expect(await missing.json()).toEqual({ error: "Couldn't authenticate you" });

      const wrong = await ctx.app.request(`${zendeskTestBaseUrl}/api/v2/tickets.json`, {
        headers: { Authorization: tokenAuth("x@example.com", "nope") },
      });
      expect(wrong.status).toBe(401);
    });

    it("accepts email/token Basic auth and returns the current user", async () => {
      const me = await api(ctx.app, "GET", "/users/me.json");
      expect(me.status).toBe(200);
      expect(me.body.user).toMatchObject({ email: DEFAULT_ADMIN_EMAIL, role: "admin" });
      expect(me.headers.get("X-Rate-Limit")).toBe("700");
    });

    it("supports password auth and X-On-Behalf-Of impersonation", async () => {
      const seeded = createZendeskTestApp({
        users: [{ name: "Pass User", email: "pass@example.com", role: "agent", password: "secret" }],
      });
      const me = await seeded.app.request(`${zendeskTestBaseUrl}/api/v2/users/me`, {
        headers: { Authorization: passwordAuth("pass@example.com", "secret") },
      });
      expect(me.status).toBe(200);
      expect(((await me.json()) as any).user.email).toBe("pass@example.com");

      const behalf = await api(ctx.app, "GET", "/users/me", undefined, { "X-On-Behalf-Of": DEFAULT_END_USER_EMAIL });
      expect(behalf.body.user.email).toBe(DEFAULT_END_USER_EMAIL);
    });
  });

  describe("organizations and memberships", () => {
    it("creates, searches by exact name, updates, and links users the way CyberHub does", async () => {
      const created = await api(ctx.app, "POST", "/organizations", {
        organization: { name: "acme-corp", organization_fields: { english: true } },
      });
      expect(created.status).toBe(201);
      expect(created.body.organization).toMatchObject({
        name: "acme-corp",
        organization_fields: { english: true, client_id: null },
      });
      expect(created.body.organization.url).toBe(
        `${zendeskTestBaseUrl}/api/v2/organizations/${created.body.organization.id}.json`,
      );

      const search = await api(ctx.app, "GET", "/organizations/search?name=acme-corp");
      expect(search.body.organizations).toHaveLength(1);
      expect(search.body.count).toBe(1);
      expect((await api(ctx.app, "GET", "/organizations/search?name=acme")).body.organizations).toHaveLength(0);

      const duplicate = await api(ctx.app, "POST", "/organizations", { organization: { name: "ACME-Corp" } });
      expect(duplicate.status).toBe(422);
      expect(duplicate.body).toMatchObject({ error: "RecordInvalid", description: "Record validation errors" });
      expect(duplicate.body.details.name[0].description).toContain("taken");

      const updated = await api(ctx.app, "PUT", `/organizations/${created.body.organization.id}`, {
        organization: { organization_fields: { client_id: "cmp_1", msp: true }, tags: ["MSP"] },
      });
      expect(updated.body.organization.organization_fields).toMatchObject({
        english: true,
        client_id: "cmp_1",
        msp: true,
      });
      expect(updated.body.organization.tags).toEqual(["msp"]);

      const user = await api(ctx.app, "POST", "/users", {
        user: { name: "Distribution List", email: "support@acme.test", skip_verify_email: true },
      });
      expect(user.status).toBe(201);
      const link = await api(ctx.app, "POST", "/organization_memberships", {
        organization_membership: { user_id: user.body.user.id, organization_id: created.body.organization.id },
      });
      expect(link.status).toBe(201);
      expect(link.body.organization_membership).toMatchObject({
        user_id: user.body.user.id,
        organization_id: created.body.organization.id,
        default: true,
      });
      const again = await api(ctx.app, "POST", "/organization_memberships", {
        organization_membership: { user_id: user.body.user.id, organization_id: created.body.organization.id },
      });
      expect(again.status).toBe(422);

      const fetched = await api(ctx.app, "GET", `/users/${user.body.user.id}`);
      expect(fetched.body.user.organization_id).toBe(created.body.organization.id);
      const members = await api(ctx.app, "GET", `/organizations/${created.body.organization.id}/users`);
      expect(members.body.users.map((member: any) => member.id)).toEqual([user.body.user.id]);
    });

    it("destroys many organizations through a job status", async () => {
      const a = await api(ctx.app, "POST", "/organizations", { organization: { name: "gone-a" } });
      const b = await api(ctx.app, "POST", "/organizations", { organization: { name: "gone-b" } });
      const job = await api(
        ctx.app,
        "DELETE",
        `/organizations/destroy_many?ids=${a.body.organization.id},${b.body.organization.id}`,
      );
      expect(job.status).toBe(200);
      expect(job.body.job_status).toMatchObject({ status: "completed", total: 2 });
      expect(job.body.job_status.results.map((result: any) => result.status)).toEqual(["Deleted", "Deleted"]);
      expect((await api(ctx.app, "GET", `/organizations/${a.body.organization.id}`)).status).toBe(404);
      const status = await api(ctx.app, "GET", `/job_statuses/${job.body.job_status.id}`);
      expect(status.body.job_status.id).toBe(job.body.job_status.id);
    });

    it("lists organization requests with cursor pagination", async () => {
      const { organization, endUser } = await seededIds(ctx);
      for (let i = 0; i < 3; i++) {
        await api(ctx.app, "POST", "/tickets", {
          ticket: { subject: `Request ${i}`, comment: { body: "Help" }, requester_id: endUser.id },
        });
      }
      const first = await api(ctx.app, "GET", `/organizations/${organization.id}/requests?page[size]=2`);
      expect(first.status).toBe(200);
      expect(first.body.requests).toHaveLength(2);
      expect(first.body.meta).toMatchObject({ has_more: true });
      expect(first.body.requests[0]).toMatchObject({ organization_id: organization.id, requester_id: endUser.id });
      const second = await api(
        ctx.app,
        "GET",
        `/organizations/${organization.id}/requests?page[size]=2&page[after]=${encodeURIComponent(first.body.meta.after_cursor)}`,
      );
      expect(second.body.requests).toHaveLength(2);
      expect(second.body.meta.has_more).toBe(false);
      expect(second.body.links.prev).toBeTruthy();
    });
  });

  describe("users", () => {
    it("creates users, searches, and destroys many", async () => {
      const created = await api(ctx.app, "POST", "/users", {
        user: { name: "Jane Doe", email: "jane@example.com", tags: ["VIP"], user_fields: { plan: "gold" } },
      });
      expect(created.status).toBe(201);
      expect(created.body.user).toMatchObject({
        name: "Jane Doe",
        email: "jane@example.com",
        role: "end-user",
        tags: ["vip"],
        active: true,
        verified: false,
      });
      expect(created.body.user.organization_id).toBeTypeOf("number");

      const duplicate = await api(ctx.app, "POST", "/users", { user: { name: "Other", email: "JANE@example.com" } });
      expect(duplicate.status).toBe(422);
      expect(duplicate.body.details.email[0].description).toContain("already being used");

      const search = await api(ctx.app, "GET", "/users/search?query=jane%40example.com");
      expect(search.body.users.map((user: any) => user.id)).toEqual([created.body.user.id]);
      const roleSearch = await api(ctx.app, "GET", "/users/search?query=role%3Aagent");
      expect(roleSearch.body.users.every((user: any) => user.role === "agent")).toBe(true);

      const job = await api(ctx.app, "DELETE", `/users/destroy_many?ids=${created.body.user.id}`);
      expect(job.body.job_status.results[0]).toMatchObject({ id: created.body.user.id, status: "Deleted" });
      expect((await api(ctx.app, "GET", `/users/${created.body.user.id}`)).status).toBe(404);
    });

    it("upserts with create_or_update", async () => {
      const first = await api(ctx.app, "POST", "/users/create_or_update", {
        user: { name: "Up Sert", email: "upsert@example.com" },
      });
      expect(first.status).toBe(201);
      const second = await api(ctx.app, "POST", "/users/create_or_update", {
        user: { name: "Upserted", email: "upsert@example.com" },
      });
      expect(second.status).toBe(200);
      expect(second.body.user.id).toBe(first.body.user.id);
      expect(second.body.user.name).toBe("Upserted");
    });
  });

  describe("tickets", () => {
    it("creates tickets with comments, audits, custom fields, and metrics", async () => {
      const { agent, endUser } = await seededIds(ctx);
      const fields = await api(ctx.app, "GET", "/ticket_fields");
      const category = fields.body.ticket_fields.find((field: any) => field.title === DEFAULT_CATEGORY_FIELD_TITLE);
      expect(category.type).toBe("tagger");
      expect(
        fields.body.ticket_fields.find((field: any) => field.type === "status").system_field_options.length,
      ).toBeGreaterThan(0);

      const created = await api(ctx.app, "POST", "/tickets", {
        ticket: {
          subject: "Printer on fire",
          comment: { body: "Please help, it is actually on fire." },
          requester: { name: "New Requester", email: "new@example.com" },
          priority: "urgent",
          type: "incident",
          tags: ["Fire", "hardware"],
          custom_fields: [{ id: category.id, value: "category_technical" }],
          assignee_id: agent.id,
        },
      });
      expect(created.status).toBe(201);
      expect(created.body.ticket).toMatchObject({
        subject: "Printer on fire",
        description: "Please help, it is actually on fire.",
        status: "open",
        priority: "urgent",
        type: "incident",
        assignee_id: agent.id,
        via: { channel: "api" },
      });
      expect(created.body.ticket.tags).toEqual(expect.arrayContaining(["fire", "hardware", "category_technical"]));
      expect(created.body.ticket.custom_fields).toEqual(
        expect.arrayContaining([{ id: category.id, value: "category_technical" }]),
      );
      expect(created.body.ticket.group_id).toBe(agent.default_group_id);
      expect(created.body.audit.events.some((event: any) => event.type === "Comment")).toBe(true);
      expect(
        created.body.audit.events.some((event: any) => event.type === "Create" && event.field_name === "status"),
      ).toBe(true);

      const requester = await api(ctx.app, "GET", `/users/${created.body.ticket.requester_id}`);
      expect(requester.body.user.email).toBe("new@example.com");

      const badOption = await api(ctx.app, "POST", "/tickets", {
        ticket: { comment: { body: "x" }, custom_fields: [{ id: category.id, value: "nope" }] },
      });
      expect(badOption.status).toBe(422);

      const updated = await api(ctx.app, "PUT", `/tickets/${created.body.ticket.id}`, {
        ticket: {
          comment: { body: "We are on it.", public: true },
          status: "pending",
          additional_tags: ["escalated"],
          remove_tags: ["hardware"],
        },
      });
      expect(updated.status).toBe(200);
      expect(updated.body.ticket.status).toBe("pending");
      expect(updated.body.ticket.tags).toEqual(expect.arrayContaining(["fire", "escalated"]));
      expect(updated.body.ticket.tags).not.toContain("hardware");
      expect(
        updated.body.audit.events.some(
          (event: any) => event.type === "Change" && event.field_name === "status" && event.value === "pending",
        ),
      ).toBe(true);

      const comments = await api(ctx.app, "GET", `/tickets/${created.body.ticket.id}/comments`);
      expect(comments.body.comments).toHaveLength(2);
      expect(comments.body.comments[1]).toMatchObject({
        body: "We are on it.",
        public: true,
        author_id: (await seededIds(ctx)).admin.id,
      });

      const metrics = await api(ctx.app, "GET", `/tickets/${created.body.ticket.id}/metrics`);
      expect(metrics.body.ticket_metric).toMatchObject({ replies: 1, reopens: 0 });
      expect(metrics.body.ticket_metric.reply_time_in_minutes.calendar).toBe(0);

      const solved = await api(ctx.app, "PUT", `/tickets/${created.body.ticket.id}`, { ticket: { status: "solved" } });
      expect(solved.body.ticket.status).toBe("solved");
      const reopened = await api(ctx.app, "PUT", `/tickets/${created.body.ticket.id}`, {
        ticket: { comment: { body: "Still burning", author_id: created.body.ticket.requester_id } },
      });
      expect(reopened.body.ticket.status).toBe("open");
      expect((await api(ctx.app, "GET", `/tickets/${created.body.ticket.id}/metrics`)).body.ticket_metric.reopens).toBe(
        1,
      );

      const closed = await api(ctx.app, "PUT", `/tickets/${created.body.ticket.id}`, { ticket: { status: "closed" } });
      expect(closed.status).toBe(422);
      void endUser;
    });

    it("shows many, lists with sort, counts, and deletes tickets", async () => {
      const { ticket } = await seededIds(ctx);
      const second = await api(ctx.app, "POST", "/tickets", {
        ticket: { subject: "Second", comment: { body: "two" } },
      });
      const many = await api(ctx.app, "GET", `/tickets/show_many?ids=${ticket.id},${second.body.ticket.id},999`);
      expect(many.body.tickets.map((item: any) => item.id)).toEqual([ticket.id, second.body.ticket.id]);
      const sorted = await api(ctx.app, "GET", "/tickets?sort_by=created_at&sort_order=desc");
      expect(sorted.body.tickets[0].id).toBe(second.body.ticket.id);
      expect((await api(ctx.app, "GET", "/tickets/count")).body.count.value).toBe(2);

      const deleted = await api(ctx.app, "DELETE", `/tickets/${second.body.ticket.id}`);
      expect(deleted.status).toBe(204);
      expect((await api(ctx.app, "GET", `/tickets/${second.body.ticket.id}`)).status).toBe(404);
      const trash = await api(ctx.app, "GET", "/deleted_tickets");
      expect(trash.body.deleted_tickets.map((item: any) => item.id)).toEqual([second.body.ticket.id]);
      await api(ctx.app, "PUT", `/deleted_tickets/${second.body.ticket.id}/restore`);
      expect((await api(ctx.app, "GET", `/tickets/${second.body.ticket.id}`)).body.ticket.status).toBe("new");
    });

    it("imports tickets in bulk with archive_immediately", async () => {
      const { endUser, agent } = await seededIds(ctx);
      const job = await api(ctx.app, "POST", "/imports/tickets/create_many?archive_immediately=true", {
        tickets: [
          {
            subject: "Legacy 1",
            requester_id: endUser.id,
            status: "closed",
            created_at: "2024-01-05T10:00:00Z",
            solved_at: "2024-01-06T10:00:00Z",
            tags: ["legacy"],
            comments: [
              { author_id: endUser.id, value: "Old question", created_at: "2024-01-05T10:00:00Z" },
              { author_id: agent.id, value: "Old answer", public: true, created_at: "2024-01-05T11:00:00Z" },
            ],
          },
          { subject: "Broken", requester_id: 424242, comments: [{ value: "x" }] },
        ],
      });
      expect(job.status).toBe(200);
      expect(job.body.job_status.results[0]).toMatchObject({ status: "Created", success: true });
      expect(job.body.job_status.results[1]).toMatchObject({ success: false });
      const imported = await api(ctx.app, "GET", `/tickets/${job.body.job_status.results[0].id}`);
      expect(imported.body.ticket).toMatchObject({
        status: "closed",
        created_at: "2024-01-05T10:00:00Z",
        tags: ["legacy"],
      });
      const comments = await api(ctx.app, "GET", `/tickets/${imported.body.ticket.id}/comments`);
      expect(comments.body.comments.map((comment: any) => comment.body)).toEqual(["Old question", "Old answer"]);
      const events = await api(ctx.app, "GET", "/incremental/tickets?start_time=0");
      expect(events.body.tickets.map((ticket: any) => ticket.id)).toContain(imported.body.ticket.id);
      expect(events.body.end_of_stream).toBe(true);
    });

    it("keeps end users scoped to their own requests", async () => {
      const { ticket } = await seededIds(ctx);
      const other = await api(ctx.app, "POST", "/users", {
        user: { name: "Stranger", email: "stranger@elsewhere.test" },
      });
      const forbidden = await api(ctx.app, "GET", `/requests/${ticket.id}`, undefined, {
        "X-On-Behalf-Of": "stranger@elsewhere.test",
      });
      expect(forbidden.status).toBe(404);
      const own = await api(ctx.app, "GET", `/requests/${ticket.id}`, undefined, {
        "X-On-Behalf-Of": DEFAULT_END_USER_EMAIL,
      });
      expect(own.status).toBe(200);
      expect(own.body.request).toMatchObject({ id: ticket.id, status: "open" });
      const created = await api(
        ctx.app,
        "POST",
        "/requests",
        { request: { subject: "Portal request", comment: { body: "From the portal" } } },
        { "X-On-Behalf-Of": "stranger@elsewhere.test" },
      );
      expect(created.status).toBe(201);
      expect(created.body.request).toMatchObject({ requester_id: other.body.user.id, via: { channel: "web" } });
      const list = await api(ctx.app, "GET", "/requests", undefined, { "X-On-Behalf-Of": "stranger@elsewhere.test" });
      expect(list.body.requests.map((request: any) => request.id)).toEqual([created.body.request.id]);
    });
  });

  describe("search", () => {
    it("searches tickets, users, and organizations with Zendesk query syntax", async () => {
      const { agent } = await seededIds(ctx);
      await api(ctx.app, "POST", "/tickets", {
        ticket: {
          subject: "Invoice question",
          comment: { body: "Where is my invoice?" },
          priority: "high",
          tags: ["billing"],
        },
      });
      const tickets = await api(
        ctx.app,
        "GET",
        `/search?query=${encodeURIComponent("type:ticket tags:billing priority>normal")}`,
      );
      expect(tickets.body.results).toHaveLength(1);
      expect(tickets.body.results[0]).toMatchObject({ result_type: "ticket", subject: "Invoice question" });
      expect(tickets.body.count).toBe(1);

      const assigned = await api(
        ctx.app,
        "GET",
        `/search?query=${encodeURIComponent(`type:ticket assignee:${agent.email} status<solved`)}`,
      );
      expect(assigned.body.results.length).toBe(1);

      const text = await api(ctx.app, "GET", `/search?query=${encodeURIComponent("invoice")}`);
      expect(text.body.results.some((result: any) => result.result_type === "ticket")).toBe(true);

      const users = await api(ctx.app, "GET", `/search?query=${encodeURIComponent("type:user role:end-user")}`);
      expect(
        users.body.results.every((result: any) => result.result_type === "user" && result.role === "end-user"),
      ).toBe(true);

      const organizations = await api(
        ctx.app,
        "GET",
        `/search/count?query=${encodeURIComponent("type:organization example")}`,
      );
      expect(organizations.body.count).toBe(1);

      const exported = await api(
        ctx.app,
        "GET",
        `/search/export?query=${encodeURIComponent("status<solved")}&filter[type]=ticket&page[size]=1`,
      );
      expect(exported.body.results).toHaveLength(1);
      expect(exported.body.meta.has_more).toBe(true);
    });
  });

  describe("webhooks and triggers", () => {
    it("delivers signed event webhooks", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "ok" });
      vi.stubGlobal("fetch", mockFetch);
      const created = await api(ctx.app, "POST", "/webhooks", {
        webhook: {
          name: "User events",
          endpoint: "https://hooks.example/zendesk",
          http_method: "POST",
          request_format: "json",
          status: "active",
          subscriptions: ["zen:event-type:user.created"],
          authentication: { type: "basic_auth", data: { username: "zd", password: "secret" }, add_position: "header" },
        },
      });
      expect(created.status).toBe(201);
      const secret = created.body.webhook.signing_secret.secret as string;
      expect(secret).toHaveLength(64);
      expect(created.body.webhook.authentication.data).toEqual({ username: "zd" });

      await api(ctx.app, "POST", "/users", { user: { name: "Hooked", email: "hooked@example.com" } });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe("https://hooks.example/zendesk");
      const headers = (init as RequestInit).headers as Record<string, string>;
      const body = (init as RequestInit).body as string;
      expect(headers["Authorization"]).toBe(`Basic ${Buffer.from("zd:secret").toString("base64")}`);
      expect(headers["X-Zendesk-Webhook-Id"]).toBe(created.body.webhook.id);
      const expected = createHmac("sha256", secret)
        .update(`${headers["X-Zendesk-Webhook-Signature-Timestamp"]}${body}`)
        .digest("base64");
      expect(headers["X-Zendesk-Webhook-Signature"]).toBe(expected);
      const payload = JSON.parse(body);
      expect(payload).toMatchObject({ type: "zen:event-type:user.created", zendesk_event_version: "2022-11-06" });
      expect(payload.subject).toMatch(/^zen:user:\d+$/);
      expect(payload.detail.email).toBe("hooked@example.com");

      const invocations = await api(ctx.app, "GET", `/webhooks/${created.body.webhook.id}/invocations`);
      expect(invocations.body.invocations).toHaveLength(1);
      expect(invocations.body.invocations[0]).toMatchObject({ status: "success", status_code: 200 });
      const attempts = await api(
        ctx.app,
        "GET",
        `/webhooks/${created.body.webhook.id}/invocations/${invocations.body.invocations[0].id}/attempts`,
      );
      expect(attempts.body.attempts[0].request.body).toBe(body);
    });

    it("fires trigger webhooks with rendered placeholders and applies trigger actions", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 202, text: async () => "" });
      vi.stubGlobal("fetch", mockFetch);
      const webhook = await api(ctx.app, "POST", "/webhooks", {
        webhook: {
          name: "Ticket notifier",
          endpoint: "https://hooks.example/tickets",
          http_method: "POST",
          request_format: "json",
          status: "active",
          subscriptions: ["conditional_ticket_events"],
        },
      });
      const trigger = await api(ctx.app, "POST", "/triggers", {
        trigger: {
          title: "Notify on urgent create",
          conditions: {
            all: [
              { field: "update_type", operator: "is", value: "Create" },
              { field: "priority", operator: "is", value: "urgent" },
            ],
            any: [],
          },
          actions: [
            {
              field: "notification_webhook",
              value: [
                webhook.body.webhook.id,
                '{"id": {{ticket.id}}, "title": "{{ticket.title}}", "requester": "{{ticket.requester.email}}", "status": "{{ticket.status}}"}',
              ],
            },
            { field: "current_tags", value: "notified" },
            { field: "group_id", value: "" },
          ],
        },
      });
      expect(trigger.status).toBe(201);

      const created = await api(ctx.app, "POST", "/tickets", {
        ticket: {
          subject: 'Outage "big"',
          comment: { body: "Everything is down" },
          priority: "urgent",
          requester: { email: DEFAULT_END_USER_EMAIL },
        },
      });
      expect(created.status).toBe(201);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, init] = mockFetch.mock.calls[0]!;
      const payload = JSON.parse((init as RequestInit).body as string);
      expect(payload).toEqual({
        id: created.body.ticket.id,
        title: 'Outage "big"',
        requester: DEFAULT_END_USER_EMAIL,
        status: "New",
      });

      const after = await api(ctx.app, "GET", `/tickets/${created.body.ticket.id}`);
      expect(after.body.ticket.tags).toContain("notified");
      const audits = await api(ctx.app, "GET", `/tickets/${created.body.ticket.id}/audits`);
      expect(audits.body.audits.some((audit: any) => audit.via.channel === "rule")).toBe(true);

      const normal = await api(ctx.app, "POST", "/tickets", {
        ticket: { subject: "Minor", comment: { body: "meh" }, priority: "low" },
      });
      expect(normal.status).toBe(201);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("records failed invocations", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
      const webhook = await api(ctx.app, "POST", "/webhooks", {
        webhook: {
          name: "Down",
          endpoint: "https://down.example/",
          http_method: "POST",
          request_format: "json",
          status: "active",
          subscriptions: ["zen:event-type:organization.*"],
        },
      });
      await api(ctx.app, "POST", "/organizations", { organization: { name: "Trigger org" } });
      const invocations = await api(ctx.app, "GET", `/webhooks/${webhook.body.webhook.id}/invocations`);
      expect(invocations.body.invocations).toHaveLength(1);
      expect(invocations.body.invocations[0].status).toBe("failed");
    });
  });

  describe("views, macros, uploads, and simulator", () => {
    it("executes views and previews macros", async () => {
      const views = await api(ctx.app, "GET", "/views");
      const unsolved = views.body.views.find((view: any) => view.title === "All unsolved tickets");
      const count = await api(ctx.app, "GET", `/views/${unsolved.id}/count`);
      expect(count.body.view_count.value).toBe(1);
      const tickets = await api(ctx.app, "GET", `/views/${unsolved.id}/tickets`);
      expect(tickets.body.tickets).toHaveLength(1);

      const macros = await api(ctx.app, "GET", "/macros");
      const solve = macros.body.macros.find((macro: any) => macro.title === "Mark as solved");
      const preview = await api(ctx.app, "GET", `/tickets/${tickets.body.tickets[0].id}/macros/${solve.id}/apply`);
      expect(preview.body.result.ticket.status).toBe("solved");
      expect(preview.body.result.ticket.comment.body).toContain("resolved");
    });

    it("uploads attachments and attaches them to comments", async () => {
      const { ticket } = await seededIds(ctx);
      const upload = await ctx.app.request(`${zendeskTestBaseUrl}/api/v2/uploads.json?filename=hello.txt`, {
        method: "POST",
        headers: { Authorization: tokenAuth(), "Content-Type": "text/plain" },
        body: "hello world",
      });
      expect(upload.status).toBe(201);
      const uploaded = (await upload.json()) as any;
      expect(uploaded.upload.token).toBeTruthy();
      expect(uploaded.upload.attachment).toMatchObject({
        file_name: "hello.txt",
        content_type: "text/plain",
        size: 11,
      });

      const updated = await api(ctx.app, "PUT", `/tickets/${ticket.id}`, {
        ticket: { comment: { body: "See attached", uploads: [uploaded.upload.token] } },
      });
      const comment = updated.body.audit.events.find((event: any) => event.type === "Comment");
      expect(comment.attachments).toHaveLength(1);
      const file = await ctx.app.request(comment.attachments[0].content_url);
      expect(await file.text()).toBe("hello world");
    });

    it("simulates inbound email and serves the inspector", async () => {
      const simulate = async (payload: unknown) => {
        const response = await ctx.app.request(`${zendeskTestBaseUrl}/_zendesk/simulate/inbound-email`, {
          method: "POST",
          headers: { Authorization: tokenAuth(), "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        return { status: response.status, body: (await response.json()) as any };
      };
      const created = await simulate({
        from: "mailer@example.com",
        from_name: "Mailer",
        subject: "Mail in",
        body: "Sent by email",
      });
      expect(created.status).toBe(201);
      expect(created.body.ticket).toMatchObject({ subject: "Mail in", via: { channel: "email" } });
      expect(created.body.ticket.via.source.from.address).toBe("mailer@example.com");
      const reply = await simulate({
        from: "mailer@example.com",
        body: "Following up",
        ticket_id: created.body.ticket.id,
      });
      expect(reply.status).toBe(200);
      expect((await api(ctx.app, "GET", `/tickets/${created.body.ticket.id}/comments`)).body.comments).toHaveLength(2);

      const inspector = await ctx.app.request(`${zendeskTestBaseUrl}/?tab=tickets`);
      expect(inspector.status).toBe(200);
      expect(await inspector.text()).toContain("Mail in");
    });
  });

  describe("seed config", () => {
    it("seeds custom fields, tickets, and webhooks", async () => {
      const seeded = createZendeskTestApp({
        api_tokens: [{ token: "other_token" }],
        organizations: [
          { name: "Cyna", domain_names: ["cyna.test"], organization_fields: { client_id: "cmp_9", msp: true } },
        ],
        users: [{ name: "Cyna Ops", email: "ops@cyna.test", role: "end-user" }],
        ticket_fields: [{ type: "text", title: "case_th" }],
        tickets: [
          {
            subject: "Seeded",
            requester: "ops@cyna.test",
            status: "pending",
            custom_fields: { case_th: "TH-1" },
            created_at: "2025-02-01T00:00:00Z",
          },
        ],
        webhooks: [
          {
            name: "Seeded hook",
            endpoint: "https://hooks.example/seeded",
            signing_secret: "s3cret",
            subscriptions: ["zen:event-type:user.created"],
          },
        ],
      });
      const me = await seeded.app.request(`${zendeskTestBaseUrl}/api/v2/users/me`, {
        headers: { Authorization: tokenAuth("anyone@cyna.test", "other_token") },
      });
      expect(me.status).toBe(200);
      const org = await api(seeded.app, "GET", "/organizations/search?name=Cyna");
      expect(org.body.organizations[0].organization_fields).toMatchObject({
        client_id: "cmp_9",
        msp: true,
        english: null,
      });
      const user = await api(seeded.app, "GET", "/users/search?query=ops%40cyna.test");
      expect(user.body.users[0].organization_id).toBe(org.body.organizations[0].id);
      const tickets = await api(seeded.app, "GET", "/tickets?external_id=");
      const seededTicket = tickets.body.tickets.find((ticket: any) => ticket.subject === "Seeded");
      expect(seededTicket).toMatchObject({
        status: "pending",
        created_at: "2025-02-01T00:00:00Z",
        organization_id: org.body.organizations[0].id,
      });
      const field = (await api(seeded.app, "GET", "/ticket_fields")).body.ticket_fields.find(
        (item: any) => item.title === "case_th",
      );
      expect(seededTicket.custom_fields).toEqual(expect.arrayContaining([{ id: field.id, value: "TH-1" }]));
      const webhooks = await api(seeded.app, "GET", "/webhooks");
      expect(webhooks.body.webhooks.map((hook: any) => hook.name)).toEqual(["Seeded hook"]);
      expect(
        (await api(seeded.app, "GET", `/webhooks/${webhooks.body.webhooks[0].id}/signing_secret`)).body.signing_secret
          .secret,
      ).toBe("s3cret");
      void DEFAULT_API_TOKEN;
    });
  });
});
