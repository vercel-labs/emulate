import twilio from "twilio";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ACCOUNT_SID, DEFAULT_AUTH_TOKEN, DEFAULT_PHONE_NUMBER, DEFAULT_VERIFY_SERVICE_SID } from "../index.js";
import { createTwilioTestApp, LocalTwilioRequestClient } from "./helpers.js";

describe("Twilio SDK compatibility", () => {
  let setup: ReturnType<typeof createTwilioTestApp>;
  let requestClient: LocalTwilioRequestClient;
  let client: ReturnType<typeof twilio>;

  beforeEach(() => {
    setup = createTwilioTestApp();
    requestClient = new LocalTwilioRequestClient(setup.app);
    client = twilio(DEFAULT_ACCOUNT_SID, DEFAULT_AUTH_TOKEN, { httpClient: requestClient as any });
  });

  it("creates and lists messages through twilio-node", async () => {
    const message = await client.messages.create({
      to: "+15550004444",
      from: DEFAULT_PHONE_NUMBER,
      body: "Hello from SDK",
    });
    expect(message.sid).toMatch(/^SM/);
    expect(message.status).toBe("queued");

    const messages = await client.messages.list({ limit: 10 });
    expect(messages.map((item) => item.sid)).toContain(message.sid);
  });

  it("starts and checks Verify flows through twilio-node", async () => {
    const verification = await client.verify.v2.services(DEFAULT_VERIFY_SERVICE_SID).verifications.create({
      to: "+15550005555",
      channel: "sms",
    });
    expect(verification.status).toBe("pending");

    const check = await client.verify.v2.services(DEFAULT_VERIFY_SERVICE_SID).verificationChecks.create({
      to: "+15550005555",
      code: "123456",
    });
    expect(check.status).toBe("approved");
    expect(check.valid).toBe(true);
  });

  it("paginates product-host service lists through twilio-node", async () => {
    const created = await client.messaging.v1.services.create({ friendlyName: "Paged Messaging Service" });
    const services = await client.messaging.v1.services.list({ pageSize: 1, limit: 2 });

    expect(services.map((service) => service.sid)).toContain(created.sid);
    expect(requestClient.lastResponse?.statusCode).toBe(200);
  });

  it("creates and updates calls through twilio-node", async () => {
    const call = await client.calls.create({
      to: "+15550006666",
      from: DEFAULT_PHONE_NUMBER,
      twiml: "<Response><Say>Hi</Say></Response>",
    });
    expect(call.sid).toMatch(/^CA/);
    expect(call.status).toBe("ringing");

    const updated = await client.calls(call.sid).update({ status: "completed" });
    expect(updated.status).toBe("completed");
  });
});
