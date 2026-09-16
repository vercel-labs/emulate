import { createServer } from "node:http";
import { once } from "node:events";
import { MailService } from "@sendgrid/mail";
import { Client } from "@sendgrid/client";
import { expect, it } from "vitest";
import { createTwilioTestApp } from "./helpers.js";

it("accepts the unchanged official SendGrid mail client over HTTP", async () => {
  const { app, store } = createTwilioTestApp();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    const result = await app.request(`http://localhost${request.url}`, {
      method: request.method,
      headers,
      body: Buffer.concat(chunks),
    });
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP listener");
    const client = new Client();
    const mail = new MailService();
    mail.setClient(client);
    mail.setApiKey("SG.emulate-test-key");
    const baseUrl = `http://127.0.0.1:${address.port}/`;
    client.setDefaultRequest("baseUrl", baseUrl);
    expect(Reflect.get(client.createRequest({ method: "POST", url: "/v3/mail/send" }), "baseURL")).toBe(baseUrl);
    const [accepted] = await mail.send({
      from: "reception@example.com",
      to: "guest@example.com",
      subject: "Your invitation",
      html: "<p>Welcome</p>",
      replyTo: "host@example.com",
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.headers["x-message-id"]).toBeTruthy();
    expect(store.collection("twilio.sendgrid.emails").all()).toEqual([
      expect.objectContaining({
        request: expect.objectContaining({
          reply_to: { email: "host@example.com" },
          content: [{ type: "text/html", value: "<p>Welcome</p>" }],
        }),
      }),
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
