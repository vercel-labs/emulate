import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DOMAIN,
  DEFAULT_LIST_ADDRESS,
  DEFAULT_SANDBOX_DOMAIN,
  DEFAULT_TEMPLATE_NAME,
  DEFAULT_WEBHOOK_SIGNING_KEY,
} from "../index.js";
import { api, basicAuth, createMailgunTestApp, mailgunTestBaseUrl, type MailgunTestApp } from "./helpers.js";

async function send(ctx: MailgunTestApp, fields: Record<string, string | string[]>, domain = DEFAULT_DOMAIN) {
  return api(ctx.app, "POST", `/v3/${domain}/messages`, {
    from: "Sender <noreply@mail.example.com>",
    subject: "Hello",
    text: "Body",
    ...fields,
  });
}

describe("Mailgun plugin", () => {
  let ctx: MailgunTestApp;

  beforeEach(() => {
    ctx = createMailgunTestApp();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("authentication", () => {
    it("rejects missing or invalid keys", async () => {
      const missing = await ctx.app.request(`${mailgunTestBaseUrl}/v3/lists`);
      expect(missing.status).toBe(401);
      expect(await missing.json()).toEqual({ message: "Forbidden" });
      const wrong = await api(ctx.app, "GET", "/v3/lists", undefined, "key-wrong");
      expect(wrong.status).toBe(401);
    });

    it("restricts domain sending keys to their domain", async () => {
      const seeded = createMailgunTestApp({
        domains: [{ name: "other.example.com", sending_key: "key-other-domain" }],
      });
      const allowed = await api(
        seeded.app,
        "POST",
        "/v3/other.example.com/messages",
        { from: "a@other.example.com", to: "b@example.com", text: "hi" },
        "key-other-domain",
      );
      expect(allowed.status).toBe(200);
      const denied = await api(
        seeded.app,
        "POST",
        `/v3/${DEFAULT_DOMAIN}/messages`,
        { from: "a@other.example.com", to: "b@example.com", text: "hi" },
        "key-other-domain",
      );
      expect(denied.status).toBe(401);
    });
  });

  describe("messages", () => {
    it("queues messages and records accepted and delivered events", async () => {
      const res = await send(ctx, {
        to: ["Jane <jane@example.com>", "john@example.com"],
        "o:tag": ["welcome", "onboarding"],
        "v:user-id": "42",
        "h:Reply-To": "help@mail.example.com",
      });
      expect(res.status).toBe(200);
      expect(res.body.message).toBe("Queued. Thank you.");
      expect(res.body.id).toMatch(new RegExp(`^<.+@${DEFAULT_DOMAIN}>$`));

      const events = await api(ctx.app, "GET", `/v3/${DEFAULT_DOMAIN}/events`);
      expect(events.status).toBe(200);
      const types = events.body.items.map((item: any) => `${item.event}:${item.recipient}`).sort();
      expect(types).toEqual([
        "accepted:jane@example.com",
        "accepted:john@example.com",
        "delivered:jane@example.com",
        "delivered:john@example.com",
      ]);
      const delivered = events.body.items.find((item: any) => item.event === "delivered");
      expect(delivered.message.headers["message-id"]).toBe(res.body.id.replace(/^<|>$/g, ""));
      expect(delivered.tags).toEqual(["welcome", "onboarding"]);
      expect(delivered["user-variables"]).toEqual({ "user-id": "42" });
      expect(delivered["delivery-status"].code).toBe(250);
      expect(events.body.paging.next).toContain(`/v3/${DEFAULT_DOMAIN}/events/`);

      const filtered = await api(
        ctx.app,
        "GET",
        `/v3/${DEFAULT_DOMAIN}/events?event=delivered&recipient=jane%40example.com`,
      );
      expect(filtered.body.items).toHaveLength(1);

      const stored = await api(ctx.app, "GET", new URL(delivered.storage.url).pathname);
      expect(stored.status).toBe(200);
      expect(stored.body).toMatchObject({
        subject: "Hello",
        "body-plain": "Body",
        From: "Sender <noreply@mail.example.com>",
      });
      expect(
        stored.body["message-headers"].some(
          ([name, value]: [string, string]) => name === "Reply-To" && value === "help@mail.example.com",
        ),
      ).toBe(true);
      expect(stored.body["X-Mailgun-Tag"]).toEqual(["welcome", "onboarding"]);

      const tags = await api(ctx.app, "GET", `/v3/${DEFAULT_DOMAIN}/tags`);
      expect(tags.body.items.map((tag: any) => tag.tag)).toEqual(["onboarding", "welcome"]);
    });

    it("validates required parameters", async () => {
      const noFrom = await api(ctx.app, "POST", `/v3/${DEFAULT_DOMAIN}/messages`, { to: "a@example.com", text: "x" });
      expect(noFrom.status).toBe(400);
      expect(noFrom.body).toEqual({ message: "'from' parameter is missing" });
      const noTo = await api(ctx.app, "POST", `/v3/${DEFAULT_DOMAIN}/messages`, { from: "a@example.com", text: "x" });
      expect(noTo.body.message).toBe("'to' parameter is missing");
      const noBody = await api(ctx.app, "POST", `/v3/${DEFAULT_DOMAIN}/messages`, {
        from: "a@example.com",
        to: "b@example.com",
      });
      expect(noBody.body.message).toBe("Need at least one of 'text' or 'html' parameters specified");
      const unknownDomain = await api(ctx.app, "POST", "/v3/nope.example.com/messages", {
        from: "a@example.com",
        to: "b@example.com",
        text: "x",
      });
      expect(unknownDomain.status).toBe(404);
      expect(unknownDomain.body.message).toBe("Domain not found: nope.example.com");
    });

    it("enforces sandbox authorized recipients", async () => {
      const ok = await send(ctx, { to: "test@example.com" }, DEFAULT_SANDBOX_DOMAIN);
      expect(ok.status).toBe(200);
      const denied = await send(ctx, { to: "stranger@example.com" }, DEFAULT_SANDBOX_DOMAIN);
      expect(denied.status).toBe(400);
      expect(denied.body.message).toContain("Sandbox subdomains are for test purposes only");
      const added = await api(ctx.app, "POST", "/v5/sandbox/auth_recipients?email=stranger%40example.com");
      expect(added.body.recipient.email).toBe("stranger@example.com");
      expect((await send(ctx, { to: "stranger@example.com" }, DEFAULT_SANDBOX_DOMAIN)).status).toBe(200);
    });

    it("fails bounce addresses, honours suppressions, and supports test mode", async () => {
      await send(ctx, { to: "bounce@example.com" });
      const events = await api(ctx.app, "GET", `/v3/${DEFAULT_DOMAIN}/events?event=failed`);
      expect(events.body.items).toHaveLength(1);
      expect(events.body.items[0]).toMatchObject({
        event: "failed",
        severity: "permanent",
        reason: "bounce",
        recipient: "bounce@example.com",
      });
      const bounces = await api(ctx.app, "GET", `/v3/${DEFAULT_DOMAIN}/bounces`);
      expect(bounces.body.items.map((item: any) => item.address)).toEqual(["bounce@example.com"]);

      await api(ctx.app, "POST", `/v3/${DEFAULT_DOMAIN}/unsubscribes`, { address: "quiet@example.com", tag: "*" });
      await send(ctx, { to: "quiet@example.com" });
      const suppressed = await api(
        ctx.app,
        "GET",
        `/v3/${DEFAULT_DOMAIN}/events?event=failed&recipient=quiet%40example.com`,
      );
      expect(suppressed.body.items[0]).toMatchObject({ reason: "suppress-unsubscribe", severity: "permanent" });

      await api(ctx.app, "POST", `/v3/${DEFAULT_DOMAIN}/whitelists`, { address: "quiet@example.com" });
      await send(ctx, { to: "quiet@example.com", subject: "Second" });
      const allowed = await api(
        ctx.app,
        "GET",
        `/v3/${DEFAULT_DOMAIN}/events?event=delivered&recipient=quiet%40example.com`,
      );
      expect(allowed.body.items).toHaveLength(1);

      await send(ctx, { to: "tester@example.com", "o:testmode": "yes" });
      const testEvents = await api(ctx.app, "GET", `/v3/${DEFAULT_DOMAIN}/events?recipient=tester%40example.com`);
      expect(testEvents.body.items.map((item: any) => item.event)).toEqual(["accepted"]);
      expect(testEvents.body.items[0].flags["is-test-mode"]).toBe(true);
    });

    it("expands mailing lists and applies recipient variables", async () => {
      const res = await send(ctx, {
        to: [DEFAULT_LIST_ADDRESS, "carol@example.com"],
        subject: "Hi %recipient.name%",
        text: "Your role is %recipient.role%",
        "recipient-variables": JSON.stringify({ "carol@example.com": { name: "Carol", role: "guest" } }),
      });
      expect(res.status).toBe(200);
      const events = await api(ctx.app, "GET", `/v3/${DEFAULT_DOMAIN}/events?event=delivered`);
      expect(events.body.items.map((item: any) => item.recipient).sort()).toEqual([
        "alice@example.com",
        "bob@example.com",
        "carol@example.com",
      ]);
      const key = events.body.items[0].storage.key as string;
      const html = await ctx.app.request(`${mailgunTestBaseUrl}/_mailgun/messages/${key}?recipient=carol@example.com`);
      expect(html.status).toBe(200);
      const text = await html.text();
      expect(text).toContain("Hi Carol");
      expect(text).toContain("Your role is guest");
    });

    it("renders stored templates with variables", async () => {
      const res = await api(ctx.app, "POST", `/v3/${DEFAULT_DOMAIN}/messages`, {
        from: "noreply@mail.example.com",
        to: "new@example.com",
        template: DEFAULT_TEMPLATE_NAME,
        "t:variables": JSON.stringify({ name: "Nadia", company: "Cyna" }),
      });
      expect(res.status).toBe(200);
      const events = await api(ctx.app, "GET", `/v3/${DEFAULT_DOMAIN}/events?event=delivered`);
      const stored = await api(ctx.app, "GET", new URL(events.body.items[0].storage.url).pathname);
      expect(stored.body["body-html"]).toBe("<p>Hello Nadia, welcome to Cyna.</p>");
      expect(stored.body.subject).toBe("Welcome to Cyna");
      const missing = await api(ctx.app, "POST", `/v3/${DEFAULT_DOMAIN}/messages`, {
        from: "a@mail.example.com",
        to: "b@example.com",
        template: "nope",
      });
      expect(missing.status).toBe(400);
    });

    it("accepts multipart bodies with attachments and MIME messages", async () => {
      const form = new FormData();
      form.append("from", "a@mail.example.com");
      form.append("to", "b@example.com");
      form.append("subject", "Attached");
      form.append("html", "<b>Hi</b>");
      form.append("attachment", new Blob(["hello file"], { type: "text/plain" }), "hello.txt");
      const res = await api(ctx.app, "POST", `/v3/${DEFAULT_DOMAIN}/messages`, form);
      expect(res.status).toBe(200);
      const events = await api(ctx.app, "GET", `/v3/${DEFAULT_DOMAIN}/events?event=delivered`);
      expect(events.body.items[0].message.attachments[0]).toMatchObject({ filename: "hello.txt", size: 10 });
      const stored = await api(ctx.app, "GET", new URL(events.body.items[0].storage.url).pathname);
      const file = await ctx.app.request(stored.body.attachments[0].url, { headers: { Authorization: basicAuth() } });
      expect(await file.text()).toBe("hello file");

      const mime = new FormData();
      mime.append("to", "mime@example.com");
      mime.append(
        "message",
        new Blob(["From: raw@mail.example.com\r\nSubject: Raw MIME\r\nContent-Type: text/plain\r\n\r\nRaw body"], {
          type: "message/rfc822",
        }),
        "message.mime",
      );
      const mimeRes = await api(ctx.app, "POST", `/v3/${DEFAULT_DOMAIN}/messages.mime`, mime);
      expect(mimeRes.status).toBe(200);
      const mimeEvents = await api(
        ctx.app,
        "GET",
        `/v3/${DEFAULT_DOMAIN}/events?recipient=mime%40example.com&event=delivered`,
      );
      expect(mimeEvents.body.items[0].message.headers.subject).toBe("Raw MIME");
    });
  });

  describe("mailing lists", () => {
    it("supports the CyberHub distribution list flow", async () => {
      const missing = await api(ctx.app, "GET", "/v3/lists/soc-acme@mail.example.com");
      expect(missing.status).toBe(404);
      expect(missing.body.message).toBe("Mailing list not found");

      const created = await api(ctx.app, "POST", "/v3/lists", {
        name: "SOC · Acme · Client",
        address: "soc-acme@mail.example.com",
        access_level: "everyone",
      });
      expect(created.status).toBe(200);
      expect(created.body).toMatchObject({
        message: "Mailing list has been created",
        list: { address: "soc-acme@mail.example.com", access_level: "everyone", members_count: 0 },
      });

      const member = await api(ctx.app, "POST", "/v3/lists/soc-acme@mail.example.com/members", {
        name: "CYNA · cybersecurity",
        address: "soc@cyna.test",
      });
      expect(member.status).toBe(200);
      expect(member.body).toMatchObject({
        message: "Mailing list member has been created",
        member: { address: "soc@cyna.test", name: "CYNA · cybersecurity", subscribed: true, vars: {} },
      });
      const duplicate = await api(ctx.app, "POST", "/v3/lists/soc-acme@mail.example.com/members", {
        address: "soc@cyna.test",
      });
      expect(duplicate.status).toBe(400);
      expect(duplicate.body.message).toBe("Address already exists");
      const upsert = await api(ctx.app, "POST", "/v3/lists/soc-acme@mail.example.com/members", {
        address: "soc@cyna.test",
        name: "Renamed",
        upsert: "yes",
        vars: JSON.stringify({ tier: "gold" }),
      });
      expect(upsert.body.member).toMatchObject({ name: "Renamed", vars: { tier: "gold" } });

      const fetched = await api(ctx.app, "GET", "/v3/lists/soc-acme@mail.example.com/members/soc%40cyna.test");
      expect(fetched.body.member.address).toBe("soc@cyna.test");

      const updated = await api(ctx.app, "PUT", "/v3/lists/soc-acme@mail.example.com/members/soc@cyna.test", {
        name: "SOC Team",
        address: "soc-team@cyna.test",
      });
      expect(updated.body.member).toMatchObject({ name: "SOC Team", address: "soc-team@cyna.test" });

      const access = await api(ctx.app, "PUT", "/v3/lists/soc-acme@mail.example.com", {
        access_level: "members",
        address: "soc-acme@mail.example.com",
      });
      expect(access.body).toMatchObject({
        message: "Mailing list has been updated",
        list: { access_level: "members", members_count: 1 },
      });

      const pages = await api(ctx.app, "GET", "/v3/lists/pages?limit=1");
      expect(pages.body.items).toHaveLength(1);
      expect(pages.body.paging.next).toContain("page=next");
      const next = await api(
        ctx.app,
        "GET",
        new URL(pages.body.paging.next).pathname + new URL(pages.body.paging.next).search,
      );
      expect(next.body.items).toHaveLength(1);
      expect(next.body.items[0].address).not.toBe(pages.body.items[0].address);

      const deleted = await api(ctx.app, "DELETE", "/v3/lists/soc-acme@mail.example.com/members/soc-team@cyna.test");
      expect(deleted.body).toEqual({
        member: { address: "soc-team@cyna.test" },
        message: "Mailing list member has been deleted",
      });
      const destroyed = await api(ctx.app, "DELETE", "/v3/lists/soc-acme@mail.example.com");
      expect(destroyed.body).toEqual({
        address: "soc-acme@mail.example.com",
        message: "Mailing list has been removed",
      });
    });

    it("bulk adds members", async () => {
      const res = await api(ctx.app, "POST", `/v3/lists/${DEFAULT_LIST_ADDRESS}/members.json`, {
        members: JSON.stringify([
          { address: "dave@example.com", name: "Dave", subscribed: false },
          "erin@example.com",
          { address: "alice@example.com", name: "Alice Updated" },
        ]),
        upsert: "yes",
      });
      expect(res.status).toBe(200);
      expect(res.body.list.members_count).toBe(4);
      const members = await api(ctx.app, "GET", `/v3/lists/${DEFAULT_LIST_ADDRESS}/members?subscribed=yes`);
      expect(members.body.total_count).toBe(3);
      expect(members.body.items.find((member: any) => member.address === "alice@example.com").name).toBe(
        "Alice Updated",
      );
    });
  });

  describe("domains, webhooks, and routes", () => {
    it("manages domains", async () => {
      const list = await api(ctx.app, "GET", "/v4/domains");
      expect(list.body.total_count).toBe(2);
      const created = await api(ctx.app, "POST", "/v4/domains", { name: "New.Example.Org", web_scheme: "https" });
      expect(created.status).toBe(200);
      expect(created.body.domain).toMatchObject({
        name: "new.example.org",
        state: "active",
        type: "custom",
        web_scheme: "https",
      });
      expect(created.body.sending_dns_records).toHaveLength(3);
      expect(created.body.domain.smtp_password).toBeTruthy();
      const fetched = await api(ctx.app, "GET", "/v4/domains/new.example.org");
      expect(fetched.body.domain.smtp_login).toBe("postmaster@new.example.org");
      expect((await api(ctx.app, "DELETE", "/v3/domains/new.example.org")).body.message).toBe(
        "Domain has been deleted",
      );
      expect((await api(ctx.app, "GET", "/v4/domains/new.example.org")).status).toBe(404);
    });

    it("delivers signed webhooks for events", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", mockFetch);
      const created = await api(ctx.app, "POST", `/v3/domains/${DEFAULT_DOMAIN}/webhooks`, {
        id: "delivered",
        url: ["https://hooks.example/mailgun"],
      });
      expect(created.body).toEqual({
        message: "Webhook has been created",
        webhook: { urls: ["https://hooks.example/mailgun"] },
      });
      await api(ctx.app, "PUT", `/v3/domains/${DEFAULT_DOMAIN}/webhooks/permanent_fail`, {
        url: "https://hooks.example/fail",
      });
      const listed = await api(ctx.app, "GET", `/v3/domains/${DEFAULT_DOMAIN}/webhooks`);
      expect(Object.keys(listed.body.webhooks).sort()).toEqual(["delivered", "permanent_fail"]);

      await send(ctx, { to: ["ok@example.com", "bounce@example.com"] });
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const urls = mockFetch.mock.calls.map((call) => call[0]).sort();
      expect(urls).toEqual(["https://hooks.example/fail", "https://hooks.example/mailgun"]);
      const [, init] = mockFetch.mock.calls.find((call) => call[0] === "https://hooks.example/mailgun")!;
      const payload = JSON.parse((init as RequestInit).body as string);
      expect(payload["event-data"]).toMatchObject({ event: "delivered", recipient: "ok@example.com" });
      const { timestamp, token, signature } = payload.signature;
      expect(createHmac("sha256", DEFAULT_WEBHOOK_SIGNING_KEY).update(`${timestamp}${token}`).digest("hex")).toBe(
        signature,
      );
      const invalid = await api(ctx.app, "POST", `/v3/domains/${DEFAULT_DOMAIN}/webhooks`, {
        id: "bogus",
        url: "https://x",
      });
      expect(invalid.status).toBe(400);
    });

    it("matches inbound routes and forwards to URLs", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", mockFetch);
      const created = await api(ctx.app, "POST", "/v3/routes", {
        priority: "1",
        description: "Support inbox",
        expression: 'match_recipient("support@mail.example.com")',
        action: ['forward("https://app.example/inbound")', "stop()"],
      });
      expect(created.status).toBe(200);
      expect(created.body.route).toMatchObject({
        description: "Support inbox",
        priority: 1,
        actions: ['forward("https://app.example/inbound")', "stop()"],
      });
      const bad = await api(ctx.app, "POST", "/v3/routes", { expression: "bogus()", action: "stop()" });
      expect(bad.status).toBe(400);

      const match = await api(ctx.app, "GET", "/v3/routes/match?address=support%40mail.example.com");
      expect(match.body.route.id).toBe(created.body.route.id);

      const simulated = await api(
        ctx.app,
        "POST",
        "/_mailgun/simulate/inbound",
        JSON.stringify({
          from: "Customer <cust@example.com>",
          to: "support@mail.example.com",
          subject: "Help",
          text: "Please help",
        }),
      );
      expect(simulated.status).toBe(201);
      expect(simulated.body.matched).toHaveLength(1);
      expect(simulated.body.matched[0].deliveries[0]).toMatchObject({
        url: "https://app.example/inbound",
        success: true,
        status_code: 200,
      });
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe("https://app.example/inbound");
      const fields = new URLSearchParams((init as RequestInit).body as string);
      expect(fields.get("recipient")).toBe("support@mail.example.com");
      expect(fields.get("sender")).toBe("cust@example.com");
      expect(fields.get("body-plain")).toBe("Please help");
      expect(
        createHmac("sha256", DEFAULT_WEBHOOK_SIGNING_KEY)
          .update(`${fields.get("timestamp")}${fields.get("token")}`)
          .digest("hex"),
      ).toBe(fields.get("signature"));
      const stored = await api(ctx.app, "GET", `/v3/domains/${DEFAULT_DOMAIN}/messages/${simulated.body.message.key}`);
      expect(stored.body.subject).toBe("Help");
    });

    it("simulates engagement events and updates suppressions", async () => {
      const sent = await send(ctx, { to: "reader@example.com" });
      const opened = await api(ctx.app, "POST", "/_mailgun/simulate/event", {
        event: "opened",
        "message-id": sent.body.id,
        recipient: "reader@example.com",
      });
      expect(opened.status).toBe(201);
      expect(opened.body.event).toMatchObject({ event: "opened", recipient: "reader@example.com" });
      await api(ctx.app, "POST", "/_mailgun/simulate/event", { event: "unsubscribed", "message-id": sent.body.id });
      const unsubscribes = await api(ctx.app, "GET", `/v3/${DEFAULT_DOMAIN}/unsubscribes/reader%40example.com`);
      expect(unsubscribes.body.address).toBe("reader@example.com");
      const stats = await api(
        ctx.app,
        "GET",
        `/v3/${DEFAULT_DOMAIN}/stats/total?event=delivered&event=opened&event=unsubscribed`,
      );
      const totals = stats.body.stats.reduce(
        (acc: any, bucket: any) => ({
          delivered: acc.delivered + bucket.delivered.total,
          opened: acc.opened + bucket.opened.total,
          unsubscribed: acc.unsubscribed + bucket.unsubscribed.total,
        }),
        { delivered: 0, opened: 0, unsubscribed: 0 },
      );
      expect(totals).toEqual({ delivered: 1, opened: 1, unsubscribed: 1 });
    });
  });

  describe("templates, validation, logs", () => {
    it("manages templates and versions", async () => {
      const created = await api(ctx.app, "POST", `/v3/${DEFAULT_DOMAIN}/templates`, {
        name: "Alert",
        description: "Alert mail",
        template: "<p>{{title}}</p>",
        tag: "v1",
      });
      expect(created.body.message).toBe("template has been stored");
      expect(created.body.template).toMatchObject({
        name: "alert",
        version: { tag: "v1", engine: "handlebars", active: true },
      });
      const version = await api(ctx.app, "POST", `/v3/${DEFAULT_DOMAIN}/templates/alert/versions`, {
        template: "<h1>{{title}}</h1>",
        tag: "v2",
        active: "yes",
      });
      expect(version.body.template.version.tag).toBe("v2");
      const active = await api(ctx.app, "GET", `/v3/${DEFAULT_DOMAIN}/templates/alert?active=yes`);
      expect(active.body.template.version).toMatchObject({ tag: "v2", template: "<h1>{{title}}</h1>" });
      const versions = await api(ctx.app, "GET", `/v3/${DEFAULT_DOMAIN}/templates/alert/versions`);
      expect(versions.body.template.versions.map((item: any) => item.tag)).toEqual(["v1", "v2"]);
      const list = await api(ctx.app, "GET", `/v3/${DEFAULT_DOMAIN}/templates`);
      expect(list.body.items.map((item: any) => item.name)).toEqual(["alert", DEFAULT_TEMPLATE_NAME]);
      expect((await api(ctx.app, "DELETE", `/v3/${DEFAULT_DOMAIN}/templates/alert`)).body.message).toBe(
        "template has been deleted",
      );
    });

    it("validates addresses", async () => {
      const good = await api(ctx.app, "GET", "/v4/address/validate?address=jane%40gmail.com");
      expect(good.body).toMatchObject({
        address: "jane@gmail.com",
        result: "deliverable",
        risk: "low",
        is_role_address: false,
      });
      const typo = await api(ctx.app, "GET", "/v4/address/validate?address=jane%40gmial.com");
      expect(typo.body).toMatchObject({ did_you_mean: "jane@gmail.com", result: "undeliverable" });
      const disposable = await api(ctx.app, "GET", "/v4/address/validate?address=x%40mailinator.com");
      expect(disposable.body).toMatchObject({ is_disposable_address: true, result: "do_not_send" });
      const malformed = await api(ctx.app, "GET", "/v4/address/validate?address=nope");
      expect(malformed.body.result).toBe("undeliverable");
      const role = await api(ctx.app, "GET", "/v4/address/validate?address=support%40acme.com");
      expect(role.body.is_role_address).toBe(true);
    });

    it("serves the analytics logs API and the inspector", async () => {
      await send(ctx, { to: "log@example.com", "o:tag": "logs" });
      const logs = await api(
        ctx.app,
        "POST",
        "/v1/analytics/logs",
        JSON.stringify({
          start: new Date(Date.now() - 3600_000).toUTCString(),
          end: new Date(Date.now() + 60_000).toUTCString(),
          events: ["delivered"],
          filter: { AND: [{ attribute: "tag", comparator: "=", values: [{ label: "logs", value: "logs" }] }] },
          pagination: { sort: "timestamp:desc", limit: 10 },
        }),
      );
      expect(logs.status).toBe(200);
      expect(logs.body.items).toHaveLength(1);
      expect(logs.body.items[0]).toMatchObject({
        event: "delivered",
        recipient: "log@example.com",
        domain: { name: DEFAULT_DOMAIN },
      });
      expect(logs.body.pagination.total).toBe(1);
      const inspector = await ctx.app.request(`${mailgunTestBaseUrl}/?tab=messages`);
      expect(inspector.status).toBe(200);
      expect(await inspector.text()).toContain("Hello");
    });
  });
});
