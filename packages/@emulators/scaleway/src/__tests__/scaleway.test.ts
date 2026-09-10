import { Hono, Store, WebhookDispatcher, type AppEnv } from "@emulators/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DOMAIN,
  DEFAULT_DOMAIN_ID,
  DEFAULT_PENDING_DOMAIN_ID,
  DEFAULT_PROJECT_ID,
  DEFAULT_SECRET_KEY,
  DEFAULT_WEBHOOK_ID,
  getScwStore,
  scalewayPlugin,
  seedFromConfig,
  type ScalewaySeedConfig,
} from "../index.js";

const baseUrl = "http://localhost:4324";
const prefix = "/transactional-email/v1alpha1/regions/fr-par";

function createApp(seed?: ScalewaySeedConfig, withDefaults = true) {
  const store = new Store();
  const app = new Hono<AppEnv>();
  scalewayPlugin.register(app, store, new WebhookDispatcher(), baseUrl);
  if (withDefaults) scalewayPlugin.seed?.(store, baseUrl);
  if (seed) seedFromConfig(store, baseUrl, seed);
  return { app, store };
}

async function call(
  app: Hono<AppEnv>,
  method: string,
  path: string,
  body?: unknown,
  token: string | null = DEFAULT_SECRET_KEY,
) {
  const headers: Record<string, string> = {};
  if (token) headers["X-Auth-Token"] = token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await app.request(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

const message = (overrides: Record<string, unknown> = {}) => ({
  from: { name: "Cyna Platform", email: `noreply@${DEFAULT_DOMAIN}` },
  to: [{ name: "user@example.com", email: "user@example.com" }],
  subject: "Test subject",
  project_id: DEFAULT_PROJECT_ID,
  text: "Hello",
  html: "<p>Hello</p>",
  ...overrides,
});

describe("Scaleway Transactional Email plugin", () => {
  let ctx: ReturnType<typeof createApp>;

  beforeEach(() => {
    ctx = createApp();
  });

  it("authenticates with X-Auth-Token and rejects bad keys, regions, and projects", async () => {
    const missing = await call(ctx.app, "POST", `${prefix}/emails`, message(), null);
    expect(missing.status).toBe(401);
    expect(missing.body).toEqual({
      message: "authentication is denied",
      method: "api_key",
      reason: "invalid_argument",
      type: "denied_authentication",
    });
    expect((await call(ctx.app, "POST", `${prefix}/emails`, message(), "nope")).body.reason).toBe("not_found");
    const region = await call(ctx.app, "POST", "/transactional-email/v1alpha1/regions/us-east/emails", message());
    expect(region.status).toBe(400);
    expect(region.body.details[0].argument_name).toBe("region");
    const project = await call(
      ctx.app,
      "POST",
      `${prefix}/emails`,
      message({ project_id: "99999999-9999-4999-8999-999999999999" }),
    );
    expect(project.status).toBe(403);
    expect(project.body.type).toBe("permissions_denied");
  });

  it("sends the CyberHub deliverEmail payload and returns one email per recipient", async () => {
    const response = await call(
      ctx.app,
      "POST",
      `${prefix}/emails`,
      message({
        to: [
          { name: "a@example.com", email: "a@example.com" },
          { name: "b@example.com", email: "b@example.com" },
        ],
        cc: [{ email: "c@example.com" }],
      }),
    );
    expect(response.status).toBe(200);
    expect(response.body.emails).toHaveLength(3);
    expect(response.body.emails[0]).toMatchObject({
      project_id: DEFAULT_PROJECT_ID,
      mail_from: `noreply@${DEFAULT_DOMAIN}`,
      mail_rcpt: "a@example.com",
      rcpt_to: "a@example.com",
      rcpt_type: "to",
      subject: "Test subject",
      status: "new",
      try_count: 0,
      last_tries: [],
      flags: [],
    });
    expect(response.body.emails[2].rcpt_type).toBe("cc");
    expect(new Set(response.body.emails.map((email: any) => email.message_id)).size).toBe(1);
    expect(new Set(response.body.emails.map((email: any) => email.id)).size).toBe(3);
    const fetched = await call(ctx.app, "GET", `${prefix}/emails/${response.body.emails[0].id}`);
    expect(fetched.body.id).toBe(response.body.emails[0].id);
    const content = await call(ctx.app, "GET", `/_scaleway/emails/${response.body.emails[0].id}`, undefined, null);
    expect(content.body).toMatchObject({
      text: "Hello",
      html: "<p>Hello</p>",
      from: { email: `noreply@${DEFAULT_DOMAIN}`, name: "Cyna Platform" },
    });
    expect(content.body.to).toHaveLength(2);
    const delivered = await call(
      ctx.app,
      "POST",
      "/_scaleway/simulate/deliver",
      { message_id: response.body.emails[0].message_id },
      null,
    );
    expect(
      delivered.body.emails.every(
        (email: any) => email.status === "sent" && email.try_count === 1 && email.last_tries[0].code === 250,
      ),
    ).toBe(true);
    const events = await call(
      ctx.app,
      "GET",
      `${prefix}/webhooks/${DEFAULT_WEBHOOK_ID}/events?email_id=${response.body.emails[0].id}`,
    );
    expect(events.body.webhook_events.map((event: any) => event.type).sort()).toEqual([
      "email_delivered",
      "email_queued",
    ]);
    expect((await call(ctx.app, "GET", `${prefix}/emails/00000000-0000-4000-8000-000000000000`)).body).toEqual({
      message: "resource is not found",
      type: "not_found",
      resource: "email",
      resource_id: "00000000-0000-4000-8000-000000000000",
    });
  });

  it("validates the payload with Scaleway invalid_arguments details", async () => {
    const response = await call(ctx.app, "POST", `${prefix}/emails`, {
      from: { email: "not-an-email" },
      to: [],
      subject: "",
      project_id: DEFAULT_PROJECT_ID,
      attachments: [{ name: "x.exe", type: "application/x-msdownload", content: "AAAA" }],
    });
    expect(response.status).toBe(400);
    expect(response.body.type).toBe("invalid_arguments");
    expect(response.body.details.map((detail: any) => detail.argument_name)).toEqual(
      expect.arrayContaining(["from.email", "to", "subject", "text", "attachments.0.type"]),
    );
    const missingProject = await call(ctx.app, "POST", `${prefix}/emails`, { ...message(), project_id: undefined });
    expect(missingProject.body.details[0]).toEqual({
      argument_name: "project_id",
      help_message: "project_id is required",
      reason: "required",
    });
    const withAttachment = await call(
      ctx.app,
      "POST",
      `${prefix}/emails`,
      message({
        attachments: [
          { name: "report.pdf", type: "application/pdf", content: Buffer.from("%PDF-1.4").toString("base64") },
        ],
      }),
    );
    expect(withAttachment.status).toBe(200);
    expect(
      (await call(ctx.app, "GET", `/_scaleway/emails/${withAttachment.body.emails[0].id}`, undefined, null)).body
        .attachments,
    ).toEqual([{ name: "report.pdf", type: "application/pdf", size: 8 }]);
    const strict = createApp({ settings: { strict_domains: true } });
    const unverified = await call(
      strict.app,
      "POST",
      `${prefix}/emails`,
      message({ from: { email: "noreply@unknown.example" } }),
    );
    expect(unverified.status).toBe(400);
    expect(unverified.body.details[0].argument_name).toBe("from.email");
    expect((await call(strict.app, "POST", `${prefix}/emails`, message())).status).toBe(200);
    const tooMany = createApp({ settings: { max_recipients: 1 } });
    expect(
      (
        await call(
          tooMany.app,
          "POST",
          `${prefix}/emails`,
          message({ to: [{ email: "a@example.com" }, { email: "b@example.com" }] }),
        )
      ).status,
    ).toBe(400);
  });

  it("lists, filters, cancels, and counts emails", async () => {
    const sent = await call(
      ctx.app,
      "POST",
      `${prefix}/emails`,
      message({ subject: "Filter me", to: [{ email: "filter@example.com" }] }),
    );
    const id = sent.body.emails[0].id;
    const list = await call(
      ctx.app,
      "GET",
      `${prefix}/emails?project_id=${DEFAULT_PROJECT_ID}&mail_rcpt=filter@example.com`,
    );
    expect(list.body.total_count).toBe(1);
    expect(list.body.emails[0].id).toBe(id);
    expect((await call(ctx.app, "GET", `${prefix}/emails?statuses=sent`)).body.total_count).toBe(2);
    expect((await call(ctx.app, "GET", `${prefix}/emails?statuses=failed&flags=hard_bounce`)).body.total_count).toBe(1);
    expect((await call(ctx.app, "GET", `${prefix}/emails?subject=security%20report`)).body.emails[0].subject).toContain(
      "security report",
    );
    expect(
      (await call(ctx.app, "GET", `${prefix}/emails?order_by=created_at_asc&page_size=1`)).body.emails[0].subject,
    ).toBe("Welcome to the platform");
    expect((await call(ctx.app, "GET", `${prefix}/emails?statuses=bogus`)).status).toBe(400);
    expect((await call(ctx.app, "GET", `${prefix}/emails?page_size=500`)).status).toBe(400);
    const canceled = await call(ctx.app, "POST", `${prefix}/emails/${id}/cancel`, {});
    expect(canceled.body.status).toBe("canceled");
    const again = await call(ctx.app, "POST", `${prefix}/emails/${id}/cancel`, {});
    expect(again.status).toBe(412);
    expect(again.body.type).toBe("precondition_failed");
    const stats = await call(ctx.app, "GET", `${prefix}/statistics?project_id=${DEFAULT_PROJECT_ID}`);
    expect(stats.body).toEqual({
      total_count: 4,
      new_count: 0,
      sending_count: 0,
      sent_count: 2,
      failed_count: 1,
      canceled_count: 1,
    });
    const domainStats = await call(ctx.app, "GET", `${prefix}/statistics?domain_id=${DEFAULT_DOMAIN_ID}`);
    expect(domainStats.body.total_count).toBe(4);
  });

  it("applies blocklists and bounce, spam, and defer simulations", async () => {
    const blocked = await call(
      ctx.app,
      "POST",
      `${prefix}/emails`,
      message({ to: [{ email: "bounce@blocked.example" }] }),
    );
    expect(blocked.status).toBe(200);
    expect(blocked.body.emails[0]).toMatchObject({ status: "failed", flags: ["blocklisted", "mailbox_not_found"] });
    expect(blocked.body.emails[0].last_tries[0].code).toBe(550);
    const fresh = await call(
      ctx.app,
      "POST",
      `${prefix}/emails`,
      message({ to: [{ email: "bounce-me@example.com" }] }),
    );
    const bounced = await call(
      ctx.app,
      "POST",
      "/_scaleway/simulate/bounce",
      { mail_rcpt: "bounce-me@example.com" },
      null,
    );
    expect(bounced.body.emails[0]).toMatchObject({
      id: fresh.body.emails[0].id,
      status: "failed",
      flags: ["hard_bounce", "mailbox_not_found"],
    });
    expect(bounced.body.emails[0].status_details).toContain("550");
    const soft = await call(ctx.app, "POST", `${prefix}/emails`, message({ to: [{ email: "full@example.com" }] }));
    const softBounced = await call(
      ctx.app,
      "POST",
      "/_scaleway/simulate/bounce",
      { email_id: soft.body.emails[0].id, soft: true },
      null,
    );
    expect(softBounced.body.emails[0].flags).toEqual(["soft_bounce", "mailbox_full"]);
    const spam = await call(ctx.app, "POST", `${prefix}/emails`, message({ to: [{ email: "spam@example.com" }] }));
    const spammed = await call(ctx.app, "POST", "/_scaleway/simulate/spam", { email_id: spam.body.emails[0].id }, null);
    expect(spammed.body.emails[0]).toMatchObject({ status: "sent", flags: ["spam"] });
    const deferred = await call(
      ctx.app,
      "POST",
      "/_scaleway/simulate/defer",
      {
        email_id: (await call(ctx.app, "POST", `${prefix}/emails`, message({ to: [{ email: "grey@example.com" }] })))
          .body.emails[0].id,
      },
      null,
    );
    expect(deferred.body.emails[0]).toMatchObject({ status: "sending", flags: ["greylisted"], try_count: 1 });
    expect((await call(ctx.app, "POST", "/_scaleway/simulate/deliver", { email_id: "missing" }, null)).status).toBe(
      404,
    );
    const events = await call(
      ctx.app,
      "GET",
      `${prefix}/webhooks/${DEFAULT_WEBHOOK_ID}/events?event_types=email_mailbox_not_found`,
    );
    expect(events.body.total_count).toBeGreaterThanOrEqual(2);
  });

  it("manages domains, webhooks, blocklists, and project settings", async () => {
    const domains = await call(ctx.app, "GET", `${prefix}/domains?project_id=${DEFAULT_PROJECT_ID}`);
    expect(domains.body.total_count).toBe(2);
    const checked = domains.body.domains.find((domain: any) => domain.id === DEFAULT_DOMAIN_ID);
    expect(checked).toMatchObject({
      name: DEFAULT_DOMAIN,
      status: "checked",
      project_id: DEFAULT_PROJECT_ID,
      spf_config: "v=spf1 include:_spf.tem.scaleway.com -all",
    });
    expect(checked.records.dkim.name).toContain("_domainkey.emulate.example");
    expect(checked.statistics.total_count).toBe(3);
    const created = await call(ctx.app, "POST", `${prefix}/domains`, {
      project_id: DEFAULT_PROJECT_ID,
      domain_name: "new.example",
      accept_tos: true,
      autoconfig: false,
    });
    expect(created.status).toBe(200);
    expect(created.body.status).toBe("unchecked");
    expect(
      (
        await call(ctx.app, "POST", `${prefix}/domains`, {
          project_id: DEFAULT_PROJECT_ID,
          domain_name: "new.example",
          accept_tos: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (await call(ctx.app, "POST", `${prefix}/domains`, { project_id: DEFAULT_PROJECT_ID, domain_name: "tos.example" }))
        .body.details[0].argument_name,
    ).toBe("accept_tos");
    const verification = await call(ctx.app, "GET", `${prefix}/domains/${created.body.id}/verification`);
    expect(verification.body.spf_record.status).toBe("not_found");
    const check = await call(ctx.app, "POST", `${prefix}/domains/${created.body.id}/check`, {});
    expect(check.body.status).toBe("checked");
    expect(
      (await call(ctx.app, "GET", `${prefix}/domains/${created.body.id}/verification`)).body.dkim_record.status,
    ).toBe("valid");
    expect((await call(ctx.app, "POST", `${prefix}/domains/${DEFAULT_PENDING_DOMAIN_ID}/revoke`, {})).body.status).toBe(
      "revoked",
    );
    expect((await call(ctx.app, "GET", `${prefix}/domains?status=checked`)).body.total_count).toBe(2);
    const webhook = await call(ctx.app, "POST", `${prefix}/webhooks`, {
      domain_id: created.body.id,
      project_id: DEFAULT_PROJECT_ID,
      name: "hook",
      event_types: ["email_delivered"],
      sns_arn: "arn:scw:sns:fr-par:project-x:topic",
    });
    expect(webhook.status).toBe(200);
    expect((await call(ctx.app, "GET", `${prefix}/webhooks?domain_id=${created.body.id}`)).body.total_count).toBe(1);
    expect(
      (
        await call(ctx.app, "PATCH", `${prefix}/webhooks/${webhook.body.id}`, {
          event_types: ["email_delivered", "email_dropped"],
        })
      ).body.event_types,
    ).toHaveLength(2);
    expect((await call(ctx.app, "DELETE", `${prefix}/webhooks/${webhook.body.id}`)).status).toBe(204);
    expect((await call(ctx.app, "GET", `${prefix}/webhooks/${webhook.body.id}`)).status).toBe(404);
    const blocklist = await call(ctx.app, "POST", `${prefix}/blocklists`, {
      domain_id: DEFAULT_DOMAIN_ID,
      emails: ["full@example.com"],
      type: "mailbox_full",
      reason: "test",
    });
    expect(blocklist.body.blocklists[0]).toMatchObject({
      email: "full@example.com",
      type: "mailbox_full",
      custom: true,
    });
    expect((await call(ctx.app, "GET", `${prefix}/blocklists?domain_id=${DEFAULT_DOMAIN_ID}`)).body.total_count).toBe(
      2,
    );
    expect((await call(ctx.app, "DELETE", `${prefix}/blocklists/${blocklist.body.blocklists[0].id}`)).status).toBe(204);
    expect((await call(ctx.app, "GET", `${prefix}/blocklists`)).status).toBe(400);
    const settingsResponse = await call(ctx.app, "PATCH", `${prefix}/project/${DEFAULT_PROJECT_ID}/settings`, {
      periodic_report: { enabled: true, frequency: "weekly", sending_hour: 9, sending_day: 1 },
    });
    expect(settingsResponse.body.periodic_report).toEqual({
      enabled: true,
      frequency: "weekly",
      sending_hour: 9,
      sending_day: 1,
    });
    expect(
      (await call(ctx.app, "GET", `${prefix}/project/${DEFAULT_PROJECT_ID}/settings`)).body.periodic_report.frequency,
    ).toBe("weekly");
    for (const tab of ["emails", "domains", "webhooks", "blocklists", "events", "auth"]) {
      const page = await ctx.app.request(`${baseUrl}/?tab=${tab}`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Scaleway");
    }
    const html = await ctx.app.request(
      `${baseUrl}/_scaleway/emails/${(await call(ctx.app, "GET", `${prefix}/emails?page_size=1`)).body.emails[0].id}/html`,
    );
    expect(html.status).toBe(200);
  });

  it("seeds custom projects, keys, and domains without defaults", async () => {
    const custom = createApp(
      {
        projects: [{ id: "11111111-1111-4111-8111-111111111111", name: "custom" }],
        api_keys: [{ secret_key: "secret-1", project_ids: ["11111111-1111-4111-8111-111111111111"] }],
        domains: [{ name: "cyna-it.fr", project_id: "11111111-1111-4111-8111-111111111111" }],
        settings: { delivery_delay_ms: 0 },
      },
      false,
    );
    expect(getScwStore(custom.store).domains.count()).toBe(1);
    const sent = await call(
      custom.app,
      "POST",
      `${prefix}/emails`,
      message({
        from: { email: "noreply@cyna-it.fr", name: "Cyna Platform" },
        project_id: "11111111-1111-4111-8111-111111111111",
      }),
      "secret-1",
    );
    expect(sent.status).toBe(200);
    expect(sent.body.emails[0].status).toBe("sent");
    expect(sent.body.emails[0].message_id).toContain("@cyna-it.fr>");
    expect((await call(custom.app, "POST", `${prefix}/emails`, message(), "secret-1")).status).toBe(403);
    expect((await call(custom.app, "GET", `${prefix}/emails`, undefined, DEFAULT_SECRET_KEY)).status).toBe(401);
  });
});
