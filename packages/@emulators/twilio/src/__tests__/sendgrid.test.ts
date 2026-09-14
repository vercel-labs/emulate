import { describe, expect, it } from "vitest";
import { createTwilioTestApp } from "./helpers.js";
import { seedFromConfig } from "../index.js";

describe("SendGrid Mail Send", () => {
  const mail = {
    from: { email: "invites@example.com", name: "Reception" },
    personalizations: [{ to: [{ email: "guest@example.com" }] }],
    subject: "Your invitation",
    content: [{ type: "text/html", value: '<a href="https://example.com/invite/123">Accept</a>' }],
  };

  it("uses SendGrid API keys from seed config instead of the default key", async () => {
    const { app, store } = createTwilioTestApp();
    seedFromConfig(store, "http://localhost", { sendgrid: { api_keys: ["SG.seeded"] } });
    for (const [key, expected] of [
      ["SG.seeded", 202],
      ["SG.emulate-test-key", 401],
    ] as const) {
      const response = await app.request("http://localhost/v3/mail/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(mail),
      });
      expect(response.status).toBe(expected);
    }
  });

  it("accepts mail with an empty 202 response and captures the original content", async () => {
    const { app, store } = createTwilioTestApp();
    const payload = {
      ...mail,
      personalizations: [
        {
          to: [{ email: "first@example.com" }],
          cc: [{ email: "copy@example.com" }],
          bcc: [{ email: "hidden@example.com" }],
        },
        { to: [{ email: "second@example.com" }], subject: "Second invitation" },
      ],
      reply_to: { email: "host@example.com" },
      headers: { "X-Test": "captured" },
      content: [...mail.content, { type: "text/plain", value: "Your invitation" }],
      attachments: [
        {
          filename: "image.bin",
          content: Buffer.from([0, 255, 128]).toString("base64"),
          disposition: "inline",
          content_id: "image",
        },
      ],
    };
    const response = await app.request("http://localhost/v3/mail/send", {
      method: "POST",
      headers: { Authorization: "Bearer SG.emulate-test-key", "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
    const id = response.headers.get("x-message-id");
    expect(id).toBeTruthy();
    expect(store.collection("twilio.sendgrid.emails").all()).toEqual([
      expect.objectContaining({ message_id: id, request: payload }),
    ]);
  });

  it.each([
    ["from", { ...mail, from: { email: "invalid" } }],
    ["personalizations", { ...mail, personalizations: [] }],
    ["content", { ...mail, content: [] }],
  ])("rejects invalid %s without capturing mail", async (field, body) => {
    const { app, store } = createTwilioTestApp();
    const response = await app.request("http://localhost/v3/mail/send", {
      method: "POST",
      headers: { Authorization: "Bearer SG.emulate-test-key", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ errors: [expect.objectContaining({ field })] });
    expect(store.collection("twilio.sendgrid.emails").all()).toEqual([]);
  });

  it("rejects an unknown API key", async () => {
    const { app } = createTwilioTestApp();
    const response = await app.request("http://localhost/v3/mail/send", {
      method: "POST",
      headers: { Authorization: "Bearer not-configured", "Content-Type": "application/json" },
      body: JSON.stringify(mail),
    });
    expect(response.status).toBe(401);
  });

  it("validates sandbox mail without capturing a delivery", async () => {
    const { app, store } = createTwilioTestApp();
    const response = await app.request("http://localhost/v3/mail/send", {
      method: "POST",
      headers: { Authorization: "Bearer SG.emulate-test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ ...mail, mail_settings: { sandbox_mode: { enable: true } } }),
    });
    expect(response.status).toBe(200);
    expect(store.collection("twilio.sendgrid.emails").all()).toEqual([]);
  });

  it.each([
    ["subject", { ...mail, subject: "" }],
    ["body", null],
    ["body", []],
    ["headers", { ...mail, headers: { "X-Test": "value\r\ninjected" } }],
    ["attachments.0.type", { ...mail, attachments: [{ filename: "file.bin", content: "aGk=", type: 123 }] }],
    [
      "attachments.0.content_id",
      { ...mail, attachments: [{ filename: "file.bin", content: "aGk=", content_id: 123 }] },
    ],
    [
      "attachments.0.disposition",
      { ...mail, attachments: [{ filename: "file.bin", content: "aGk=", disposition: "bad" }] },
    ],
    ["reply_to", { ...mail, reply_to: { email: "bad" } }],
    ["from", { ...mail, from: { email: "valid@example.com", name: 42 } }],
    ["attachments.0.filename", { ...mail, attachments: [{ content: "aGk=" }] }],
    ["mail_settings.sandbox_mode.enable", { ...mail, mail_settings: { sandbox_mode: { enable: "true" } } }],
    ["personalizations.0.to", { ...mail, personalizations: [{ to: [{ email: "bad" }] }] }],
    ["personalizations.0.cc", { ...mail, personalizations: [{ to: [{ email: "guest@example.com" }], cc: [{}] }] }],
    ["attachments.0.content", { ...mail, attachments: [{ filename: "file.pdf", content: "not base64!" }] }],
  ])("rejects malformed %s before acceptance", async (field, body) => {
    const { app, store } = createTwilioTestApp();
    const response = await app.request("http://localhost/v3/mail/send", {
      method: "POST",
      headers: { Authorization: "Bearer SG.emulate-test-key", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ errors: [expect.objectContaining({ field })] });
    expect(store.collection("twilio.sendgrid.emails").all()).toEqual([]);
  });

  it("rejects unsupported MIME content", async () => {
    const { app, store } = createTwilioTestApp();
    const response = await app.request("http://localhost/v3/mail/send", {
      method: "POST",
      headers: { Authorization: "Bearer SG.emulate-test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ ...mail, content: [{ type: "application/json", value: "{}" }] }),
    });
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ errors: [expect.objectContaining({ field: "content.0.type" })] });
    expect(store.collection("twilio.sendgrid.emails").all()).toEqual([]);
  });

  it("rejects malformed JSON using a SendGrid error", async () => {
    const { app } = createTwilioTestApp();
    const response = await app.request("http://localhost/v3/mail/send", {
      method: "POST",
      headers: { Authorization: "Bearer SG.emulate-test-key", "Content-Type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ errors: [expect.objectContaining({ field: "body" })] });
  });

  it.each(["template_id", "send_at"])(
    "fails explicitly for unsupported %s instead of pretending to deliver",
    async (field) => {
      const { app, store } = createTwilioTestApp();
      const response = await app.request("http://localhost/v3/mail/send", {
        method: "POST",
        headers: { Authorization: "Bearer SG.emulate-test-key", "Content-Type": "application/json" },
        body: JSON.stringify({ ...mail, [field]: field === "template_id" ? "d-test-template" : 2000000000 }),
      });
      expect(response.status).toBe(501);
      expect(await response.json()).toMatchObject({ errors: [expect.objectContaining({ field })] });
      expect(store.collection("twilio.sendgrid.emails").all()).toEqual([]);
    },
  );

  it("rejects a request without Bearer authentication using SendGrid errors", async () => {
    const { app } = createTwilioTestApp();
    const response = await app.request("http://localhost/v3/mail/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      errors: [{ message: "Permission denied, wrong credentials", field: null, help: null }],
    });
  });
});
