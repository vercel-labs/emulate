import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SENDGRID_API_KEY, getTwilioStore, seedFromConfig } from "../index.js";
import { createTwilioTestApp } from "./helpers.js";

const MAIL_SEND_URL = "http://localhost/v3/mail/send";

function mail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    personalizations: [{ to: [{ email: "guest@example.com", name: "Guest" }] }],
    from: { email: "reception@example.com", name: "Reception" },
    subject: "Your invitation",
    content: [
      { type: "text/plain", value: "Welcome" },
      { type: "text/html", value: "<p>Welcome</p>" },
    ],
    ...overrides,
  };
}

describe("SendGrid Mail Send", () => {
  let setup: ReturnType<typeof createTwilioTestApp>;

  beforeEach(() => {
    setup = createTwilioTestApp();
  });

  function send(body: unknown, apiKey: string | null = DEFAULT_SENDGRID_API_KEY) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey !== null) headers.Authorization = `Bearer ${apiKey}`;
    return setup.app.request(MAIL_SEND_URL, {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  async function errorsOf(response: Response) {
    expect(response.status).toBe(400);
    const body = (await response.json()) as { errors: Array<{ message: string; field: string | null }> };
    return body.errors;
  }

  it("accepts a message with an empty 202 and records the original request", async () => {
    const body = mail({
      personalizations: [
        {
          to: [{ email: "guest@example.com" }],
          cc: [{ email: "host@example.com" }],
          bcc: [{ email: "audit@example.com" }],
          subject: "Personal subject",
          dynamic_template_data: { name: "Guest" },
        },
        { to: [{ email: "second@example.com" }] },
      ],
      reply_to: { email: "replies@example.com" },
      headers: { "X-Campaign": "spring" },
      categories: ["invites"],
      custom_args: { invite_id: "123" },
      attachments: [{ content: Buffer.from("PDF bytes").toString("base64"), filename: "invite.pdf" }],
    });
    const res = await send(body);

    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
    const messageId = res.headers.get("X-Message-Id");
    expect(messageId).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const [stored] = getTwilioStore(setup.store).sendgridMessages.all();
    expect(stored).toMatchObject({
      message_id: messageId,
      api_key_name: "Local SendGrid API Key",
      from: { email: "reception@example.com", name: "Reception" },
      recipients: ["guest@example.com", "host@example.com", "audit@example.com", "second@example.com"],
      subject: "Your invitation",
      template_id: null,
      request: body,
    });
  });

  it("rejects missing, malformed, and unknown API keys", async () => {
    const missing = await send(mail(), null);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ errors: [{ message: "authorization required", field: null, help: null }] });

    const basic = await setup.app.request(MAIL_SEND_URL, {
      method: "POST",
      headers: { Authorization: "Basic dXNlcjpwYXNz", "Content-Type": "application/json" },
      body: JSON.stringify(mail()),
    });
    expect(basic.status).toBe(401);

    const unknown = await send(mail(), "SG.unknown.key");
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual({
      errors: [
        { message: "The provided authorization grant is invalid, expired, or revoked", field: null, help: null },
      ],
    });
    expect(getTwilioStore(setup.store).sendgridMessages.all()).toHaveLength(0);
  });

  it("accepts seeded keys and enforces the mail.send scope on restricted keys", async () => {
    seedFromConfig(setup.store, "", {
      sendgrid: {
        api_keys: [
          { key: "SG.app.full", name: "App" },
          { key: "SG.app.readonly", name: "Read only", scopes: ["stats.read"] },
          { key: "SG.app.mail", name: "Mail only", scopes: ["mail.send"] },
        ],
      },
    });

    expect((await send(mail(), "SG.app.full")).status).toBe(202);
    expect((await send(mail(), "SG.app.mail")).status).toBe(202);
    const forbidden = await send(mail(), "SG.app.readonly");
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ errors: [{ message: "access forbidden", field: null, help: null }] });
    expect(
      getTwilioStore(setup.store)
        .sendgridMessages.all()
        .map((item) => item.api_key_name),
    ).toEqual(["App", "Mail only"]);
  });

  it("validates sandbox mode without capturing the message", async () => {
    const res = await send(mail({ mail_settings: { sandbox_mode: { enable: true } } }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get("X-Message-Id")).toBeNull();
    expect(getTwilioStore(setup.store).sendgridMessages.all()).toHaveLength(0);

    const invalid = await send(mail({ mail_settings: { sandbox_mode: { enable: true } }, from: undefined }));
    expect(await errorsOf(invalid)).toEqual([expect.objectContaining({ field: "from" })]);
  });

  it("returns every validation error in SendGrid's errors array", async () => {
    const res = await send({
      personalizations: [{ to: [{ email: "not-an-email" }], cc: "nobody" }],
      content: [{ type: "text/html", value: "" }],
    });
    const errors = await errorsOf(res);
    expect(errors).toEqual([
      expect.objectContaining({ field: "from", message: expect.stringContaining("The from object must be provided") }),
      expect.objectContaining({
        field: "personalizations.0.to.0.email",
        message: expect.stringContaining("Each to object must at least have an email address"),
      }),
      expect.objectContaining({ field: "personalizations.0.cc" }),
      expect.objectContaining({ field: "subject", message: expect.stringContaining("The subject is required.") }),
      expect.objectContaining({
        field: "content.0.value",
        message: "The content value must be a string at least one character in length.",
      }),
    ]);
    for (const error of errors) expect(error).toHaveProperty("help", null);
  });

  it("checks personalizations, recipient limits, and duplicate addresses", async () => {
    expect(await errorsOf(await send(mail({ personalizations: [] })))).toEqual([
      { message: "You must have at least one personalization.", field: "personalizations", help: null },
    ]);
    expect(await errorsOf(await send(mail({ personalizations: [{ subject: "Hi" }] })))).toEqual([
      expect.objectContaining({
        message: "The to parameter is required for all personalization objects.",
        field: "personalizations.0.to",
      }),
    ]);

    const duplicate = await send(
      mail({ personalizations: [{ to: [{ email: "guest@example.com" }], bcc: [{ email: "Guest@Example.com" }] }] }),
    );
    expect(await errorsOf(duplicate)).toEqual([
      expect.objectContaining({
        field: "personalizations.0.bcc",
        message: expect.stringContaining("should only be included once"),
      }),
    ]);

    const many = Array.from({ length: 501 }, (_, index) => ({ email: `user${index}@example.com` }));
    const overLimit = await send(
      mail({ personalizations: [{ to: many }, { to: many.map((item) => ({ email: `b-${item.email}` })) }] }),
    );
    expect(await errorsOf(overLimit)).toEqual([
      expect.objectContaining({
        field: "personalizations",
        message: "There is a limit of 1000 total recipients (to + cc + bcc) per request.",
      }),
    ]);
  });

  it("uses personalization subjects when every personalization has one", async () => {
    const res = await send(
      mail({ subject: undefined, personalizations: [{ to: [{ email: "guest@example.com" }], subject: "Hi Guest" }] }),
    );
    expect(res.status).toBe(202);
  });

  it("requires text/plain before text/html and rejects repeated body types", async () => {
    const outOfOrder = await send(
      mail({
        content: [
          { type: "text/html", value: "<p>Hi</p>" },
          { type: "text/plain", value: "Hi" },
        ],
      }),
    );
    expect(await errorsOf(outOfOrder)).toEqual([
      expect.objectContaining({ field: "content", message: expect.stringContaining("text/plain needs to be first") }),
    ]);

    const repeated = await send(
      mail({
        content: [
          { type: "text/plain", value: "Hi" },
          { type: "text/plain", value: "Hi again" },
        ],
      }),
    );
    expect(await errorsOf(repeated)).toEqual([
      expect.objectContaining({ message: "If present, text/plain and text/html may only be provided once." }),
    ]);

    const other = await send(
      mail({
        content: [
          { type: "text/plain", value: "Hi" },
          { type: "text/calendar", value: "BEGIN:VCALENDAR" },
        ],
      }),
    );
    expect(other.status).toBe(202);
  });

  it("accepts template sends without content or subject and records the template data", async () => {
    const res = await send({
      personalizations: [{ to: [{ email: "guest@example.com" }], dynamic_template_data: { first_name: "Ada" } }],
      from: { email: "reception@example.com" },
      template_id: "d-0123456789abcdef0123456789abcdef",
    });
    expect(res.status).toBe(202);
    const [stored] = getTwilioStore(setup.store).sendgridMessages.all();
    expect(stored.template_id).toBe("d-0123456789abcdef0123456789abcdef");
    expect(stored.subject).toBeNull();

    const missingContent = await send(mail({ content: undefined }));
    expect(await errorsOf(missingContent)).toEqual([expect.objectContaining({ field: "content" })]);

    const badTemplate = await send(mail({ template_id: 42 }));
    expect(await errorsOf(badTemplate)).toEqual([
      expect.objectContaining({ field: "template_id", message: "The template ID must be a string, you provided 42." }),
    ]);
  });

  it("validates attachments", async () => {
    const res = await send(
      mail({
        attachments: [
          { content: "not base64!", filename: "a.txt" },
          { content: "aGk=" },
          { content: "aGk=", filename: "b.txt", disposition: "download" },
          { content: "aGk=", filename: "logo.png", disposition: "inline", content_id: "logo" },
        ],
      }),
    );
    expect(await errorsOf(res)).toEqual([
      { message: "The attachment content must be base64 encoded.", field: "attachments.0.content", help: null },
      { message: "filename is required.", field: "attachments.1.filename", help: null },
      {
        message: 'The disposition of your attachment can be either "inline" or "attachment". You provided "download".',
        field: "attachments.2.disposition",
        help: null,
      },
    ]);
  });

  it("validates reply-to, headers, categories, scheduling, and settings", async () => {
    const now = Math.floor(Date.now() / 1000);
    const res = await send(
      mail({
        reply_to: { email: "replies@example.com" },
        reply_to_list: [{ email: "a@example.com" }],
        headers: { Subject: "Override", "X-Valid": "yes" },
        categories: Array.from({ length: 11 }, (_, index) => `c${index}`),
        send_at: now + 73 * 60 * 60,
        mail_settings: { sandbox_mode: { enable: "yes" } },
        tracking_settings: { click_tracking: { enable: 1 } },
      }),
    );
    expect((await errorsOf(res)).map((error) => error.field)).toEqual([
      "reply_to_list",
      "headers.Subject",
      "categories",
      "send_at",
      "mail_settings.sandbox_mode.enable",
      "tracking_settings.click_tracking.enable",
    ]);

    const replyList = await send(
      mail({ reply_to_list: [{ email: "a@example.com" }, { email: "b@example.com", name: "B" }], send_at: now + 60 }),
    );
    expect(replyList.status).toBe(202);
  });

  it("returns SendGrid errors for unparseable bodies and other methods", async () => {
    const res = await send("{not json");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ errors: [{ message: "invalid request", field: null, help: null }] });

    const get = await setup.app.request(MAIL_SEND_URL, {
      headers: { Authorization: `Bearer ${DEFAULT_SENDGRID_API_KEY}` },
    });
    expect(get.status).toBe(405);
    expect(await get.json()).toEqual({ errors: [{ message: "method not allowed", field: null, help: null }] });
  });

  it("lists captured mail in the inspector", async () => {
    await send(mail({ subject: "Inspector <subject>" }));
    const res = await setup.app.request("http://localhost/?tab=sendgrid");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("SendGrid Mail Send");
    expect(html).toContain("guest@example.com");
    expect(html).toContain("Inspector &lt;subject&gt;");
    expect(html).not.toContain(DEFAULT_SENDGRID_API_KEY);
  });
});
