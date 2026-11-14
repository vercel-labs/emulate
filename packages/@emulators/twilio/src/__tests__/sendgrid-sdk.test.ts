import type { AddressInfo } from "node:net";
import client from "@sendgrid/client";
import mail from "@sendgrid/mail";
import { serve } from "@emulators/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SENDGRID_API_KEY, getTwilioStore } from "../index.js";
import { createTwilioTestApp } from "./helpers.js";

describe("SendGrid SDK compatibility", () => {
  const setup = createTwilioTestApp();
  let close: () => Promise<void>;
  let baseUrl: string;

  // setApiKey resets the base URL to api.sendgrid.com, so point the client at the emulator afterwards.
  function useApiKey(apiKey: string) {
    mail.setClient(client);
    mail.setApiKey(apiKey);
    client.setDefaultRequest("baseUrl", baseUrl);
  }

  beforeAll(async () => {
    const server = serve({ fetch: (request) => setup.app.fetch(request), port: 0 });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    close = () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    useApiKey(DEFAULT_SENDGRID_API_KEY);
  });

  afterAll(async () => {
    await close?.();
  });

  it("sends through @sendgrid/mail and exposes X-Message-Id", async () => {
    const [response] = await mail.send({
      from: { email: "reception@example.com", name: "Reception" },
      to: ["guest@example.com", "second@example.com"],
      cc: "host@example.com",
      subject: "Your invitation",
      text: "Welcome",
      html: "<p>Welcome</p>",
      replyTo: "replies@example.com",
      attachments: [{ content: Buffer.from([0, 255, 1]).toString("base64"), filename: "data.bin" }],
    });

    expect(response.statusCode).toBe(202);
    expect(response.body).toBe("");
    const messageId = response.headers["x-message-id"];
    expect(messageId).toBeTruthy();

    const stored = getTwilioStore(setup.store).sendgridMessages.findOneBy("message_id", messageId);
    expect(stored?.recipients).toEqual(["guest@example.com", "second@example.com", "host@example.com"]);
    expect(stored?.request).toMatchObject({
      reply_to: { email: "replies@example.com" },
      content: [
        { type: "text/plain", value: "Welcome" },
        { type: "text/html", value: "<p>Welcome</p>" },
      ],
      attachments: [{ content: "AP8B", filename: "data.bin" }],
    });
  });

  it("sends one personalization per recipient with sendMultiple", async () => {
    const [response] = await mail.sendMultiple({
      from: "reception@example.com",
      to: ["a@example.com", "b@example.com"],
      subject: "Hello {{name}}",
      templateId: "d-0123456789abcdef0123456789abcdef",
      dynamicTemplateData: { name: "friend" },
    });
    expect(response.statusCode).toBe(202);
    const stored = getTwilioStore(setup.store).sendgridMessages.findOneBy(
      "message_id",
      response.headers["x-message-id"],
    );
    expect((stored?.request.personalizations as unknown[]).length).toBe(2);
    expect(stored?.template_id).toBe("d-0123456789abcdef0123456789abcdef");
  });

  it("surfaces validation errors as a ResponseError with SendGrid's errors array", async () => {
    await expect(
      mail.send({ from: "reception@example.com", to: "guest@example.com", text: "No subject" }),
    ).rejects.toMatchObject({
      code: 400,
      response: {
        body: {
          errors: [expect.objectContaining({ field: "subject", message: expect.stringContaining("subject") })],
        },
      },
    });
  });

  it("rejects an unknown API key", async () => {
    useApiKey("SG.not.seeded");
    try {
      await expect(
        mail.send({ from: "reception@example.com", to: "guest@example.com", subject: "Hi", text: "Hi" }),
      ).rejects.toMatchObject({
        code: 401,
        response: {
          body: { errors: [expect.objectContaining({ message: expect.stringContaining("authorization grant") })] },
        },
      });
    } finally {
      useApiKey(DEFAULT_SENDGRID_API_KEY);
    }
  });
});
