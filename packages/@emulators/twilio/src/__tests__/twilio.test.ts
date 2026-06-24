import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getTwilioStore,
  DEFAULT_ACCOUNT_SID,
  DEFAULT_MESSAGING_SERVICE_SID,
  DEFAULT_PHONE_NUMBER,
  DEFAULT_VERIFY_SERVICE_SID,
} from "../index.js";
import { basicAuth, createTwilioTestApp, formBody, formHeaders } from "./helpers.js";

describe("Twilio emulator", () => {
  let setup: ReturnType<typeof createTwilioTestApp>;

  beforeEach(() => {
    setup = createTwilioTestApp();
    vi.restoreAllMocks();
  });

  it("requires Basic auth and fetches the seeded account", async () => {
    const missingAuth = await setup.app.request(`http://localhost/2010-04-01/Accounts/${DEFAULT_ACCOUNT_SID}.json`);
    expect(missingAuth.status).toBe(401);

    const res = await setup.app.request(`http://localhost/2010-04-01/Accounts/${DEFAULT_ACCOUNT_SID}.json`, {
      headers: { Authorization: basicAuth() },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.sid).toBe(DEFAULT_ACCOUNT_SID);
    expect(body.friendly_name).toBe("Local Twilio Account");
  });

  it("creates, reads, updates, and deletes messages", async () => {
    const create = await setup.app.request(
      `http://localhost/2010-04-01/Accounts/${DEFAULT_ACCOUNT_SID}/Messages.json`,
      {
        method: "POST",
        headers: formHeaders(),
        body: formBody({ To: "+15550001111", From: DEFAULT_PHONE_NUMBER, Body: "Ahoy" }),
      },
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as any;
    expect(created.sid).toMatch(/^SM/);
    expect(created.status).toBe("queued");

    const list = await setup.app.request(`http://localhost/2010-04-01/Accounts/${DEFAULT_ACCOUNT_SID}/Messages.json`, {
      headers: { Authorization: basicAuth() },
    });
    const listed = (await list.json()) as any;
    expect(listed.messages).toHaveLength(1);

    const update = await setup.app.request(
      `http://localhost/2010-04-01/Accounts/${DEFAULT_ACCOUNT_SID}/Messages/${created.sid}.json`,
      {
        method: "POST",
        headers: formHeaders(),
        body: formBody({ Status: "delivered" }),
      },
    );
    const updated = (await update.json()) as any;
    expect(updated.status).toBe("delivered");

    const del = await setup.app.request(
      `http://localhost/2010-04-01/Accounts/${DEFAULT_ACCOUNT_SID}/Messages/${created.sid}.json`,
      {
        method: "DELETE",
        headers: { Authorization: basicAuth() },
      },
    );
    expect(del.status).toBe(204);
  });

  it("dispatches signed message callbacks and captures deliveries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    );
    const number = getTwilioStore(setup.store).phoneNumbers.findOneBy("phone_number", DEFAULT_PHONE_NUMBER)!;
    getTwilioStore(setup.store).phoneNumbers.update(number.id, {
      status_callback: "http://app.local/twilio/status",
    });

    await setup.app.request(`http://localhost/2010-04-01/Accounts/${DEFAULT_ACCOUNT_SID}/Messages.json`, {
      method: "POST",
      headers: formHeaders(),
      body: formBody({ To: "+15550001111", From: DEFAULT_PHONE_NUMBER, Body: "Callback" }),
    });

    const delivery = getTwilioStore(setup.store).webhookDeliveries.all()[0];
    expect(delivery.event).toBe("message.queued");
    expect(delivery.request_headers["X-Twilio-Signature"]).toBeTruthy();
    expect(delivery.request_body.MessageStatus).toBe("queued");
  });

  it("simulates inbound SMS webhooks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    );
    const number = getTwilioStore(setup.store).phoneNumbers.findOneBy("phone_number", DEFAULT_PHONE_NUMBER)!;
    getTwilioStore(setup.store).phoneNumbers.update(number.id, {
      sms_url: "http://app.local/twilio/inbound",
      sms_method: "POST",
    });

    const inbound = await setup.app.request("http://localhost/_twilio/simulate/inbound-message", {
      method: "POST",
      headers: formHeaders(),
      body: formBody({ To: DEFAULT_PHONE_NUMBER, From: "+15550009999", Body: "hello from user" }),
    });
    expect(inbound.status).toBe(201);
    const message = (await inbound.json()) as any;
    expect(message.direction).toBe("inbound");
    expect(message.status).toBe("received");

    const delivery = getTwilioStore(setup.store).webhookDeliveries.all()[0];
    expect(delivery.event).toBe("message.inbound");
    expect(delivery.url).toBe("http://app.local/twilio/inbound");
    expect(delivery.request_headers["X-Twilio-Signature"]).toBeTruthy();
    expect(delivery.request_body.Body).toBe("hello from user");
    expect(delivery.request_body.From).toBe("+15550009999");
  });

  it("routes inbound SMS through assigned Messaging Service inbound URLs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    );
    const service = getTwilioStore(setup.store).messagingServices.findOneBy("sid", DEFAULT_MESSAGING_SERVICE_SID)!;
    getTwilioStore(setup.store).messagingServices.update(service.id, {
      inbound_request_url: "http://app.local/twilio/messaging-service-inbound",
    });

    const inbound = await setup.app.request("http://localhost/_twilio/simulate/inbound-message", {
      method: "POST",
      headers: formHeaders(),
      body: formBody({ To: DEFAULT_PHONE_NUMBER, From: "+15550008888", Body: "service inbound" }),
    });
    expect(inbound.status).toBe(201);
    const message = (await inbound.json()) as any;
    expect(message.messaging_service_sid).toBe(DEFAULT_MESSAGING_SERVICE_SID);

    const delivery = getTwilioStore(setup.store).webhookDeliveries.all()[0];
    expect(delivery.event).toBe("message.inbound");
    expect(delivery.url).toBe("http://app.local/twilio/messaging-service-inbound");
    expect(delivery.request_body.MessagingServiceSid).toBe(DEFAULT_MESSAGING_SERVICE_SID);
    expect(delivery.request_body.Body).toBe("service inbound");
  });

  it("runs Verify start and check flows", async () => {
    const start = await setup.app.request(
      `http://localhost/verify/v2/Services/${DEFAULT_VERIFY_SERVICE_SID}/Verifications`,
      {
        method: "POST",
        headers: formHeaders(),
        body: formBody({ To: "+15550002222", Channel: "sms" }),
      },
    );
    expect(start.status).toBe(201);
    const verification = (await start.json()) as any;
    expect(verification.status).toBe("pending");

    const codeRes = await setup.app.request(
      `http://localhost/_twilio/simulate/verification-code?To=${encodeURIComponent("+15550002222")}`,
      {
        headers: { Authorization: basicAuth() },
      },
    );
    expect(codeRes.status).toBe(200);
    const code = (await codeRes.json()) as any;
    expect(code.code).toBe("123456");
    expect(code.verification_sid).toBe(verification.sid);

    const check = await setup.app.request(
      `http://localhost/verify/v2/Services/${DEFAULT_VERIFY_SERVICE_SID}/VerificationCheck`,
      {
        method: "POST",
        headers: formHeaders(),
        body: formBody({ To: "+15550002222", Code: "123456" }),
      },
    );
    const checked = (await check.json()) as any;
    expect(checked.status).toBe("approved");
    expect(checked.valid).toBe(true);

    const inspector = await setup.app.request("http://localhost/?tab=verify");
    const html = await inspector.text();
    expect(html).toContain("123456");
    expect(html).toContain(verification.sid);
  });

  it("supports custom OTP codes and local verification status controls", async () => {
    const start = await setup.app.request(
      `http://localhost/verify/v2/Services/${DEFAULT_VERIFY_SERVICE_SID}/Verifications`,
      {
        method: "POST",
        headers: formHeaders(),
        body: formBody({ To: "+15550004444", Channel: "sms", CustomCode: "654321" }),
      },
    );
    expect(start.status).toBe(201);
    const verification = (await start.json()) as any;

    const lookup = await setup.app.request(
      `http://localhost/_twilio/simulate/verification-code?ServiceSid=${DEFAULT_VERIFY_SERVICE_SID}&To=${encodeURIComponent("+15550004444")}`,
      {
        headers: { Authorization: basicAuth() },
      },
    );
    expect(lookup.status).toBe(200);
    const localCode = (await lookup.json()) as any;
    expect(localCode.code).toBe("654321");
    expect(localCode.verification_sid).toBe(verification.sid);

    const force = await setup.app.request("http://localhost/_twilio/simulate/verification-status", {
      method: "POST",
      headers: formHeaders(),
      body: formBody({ To: "+15550004444", ServiceSid: DEFAULT_VERIFY_SERVICE_SID, Status: "approved" }),
    });
    expect(force.status).toBe(200);
    const forced = (await force.json()) as any;
    expect(forced.status).toBe("approved");
    expect(forced.valid).toBe(true);
  });

  it("creates and completes calls", async () => {
    const create = await setup.app.request(`http://localhost/2010-04-01/Accounts/${DEFAULT_ACCOUNT_SID}/Calls.json`, {
      method: "POST",
      headers: formHeaders(),
      body: formBody({ To: "+15550003333", From: DEFAULT_PHONE_NUMBER, Twiml: "<Response><Say>Hi</Say></Response>" }),
    });
    expect(create.status).toBe(201);
    const call = (await create.json()) as any;
    expect(call.sid).toMatch(/^CA/);
    expect(call.status).toBe("ringing");

    const complete = await setup.app.request(
      `http://localhost/2010-04-01/Accounts/${DEFAULT_ACCOUNT_SID}/Calls/${call.sid}.json`,
      {
        method: "POST",
        headers: formHeaders(),
        body: formBody({ Status: "completed" }),
      },
    );
    const completed = (await complete.json()) as any;
    expect(completed.status).toBe("completed");
  });

  it("creates Conversations resources", async () => {
    const serviceRes = await setup.app.request("http://localhost/conversations/v1/Services", {
      method: "POST",
      headers: formHeaders(),
      body: formBody({ FriendlyName: "Support" }),
    });
    expect(serviceRes.status).toBe(201);
    const service = (await serviceRes.json()) as any;
    expect(service.sid).toMatch(/^IS/);

    const conversationRes = await setup.app.request(
      `http://localhost/conversations/v1/Services/${service.sid}/Conversations`,
      {
        method: "POST",
        headers: formHeaders(),
        body: formBody({ FriendlyName: "Ticket 1", UniqueName: "ticket-1" }),
      },
    );
    const conversation = (await conversationRes.json()) as any;
    expect(conversation.sid).toMatch(/^CH/);

    const participantRes = await setup.app.request(
      `http://localhost/conversations/v1/Services/${service.sid}/Conversations/${conversation.sid}/Participants`,
      {
        method: "POST",
        headers: formHeaders(),
        body: formBody({ Identity: "agent@example.com" }),
      },
    );
    const participant = (await participantRes.json()) as any;
    expect(participant.sid).toMatch(/^MB/);

    const messageRes = await setup.app.request(
      `http://localhost/conversations/v1/Services/${service.sid}/Conversations/${conversation.sid}/Messages`,
      {
        method: "POST",
        headers: formHeaders(),
        body: formBody({ Author: "agent@example.com", Body: "Hello" }),
      },
    );
    const message = (await messageRes.json()) as any;
    expect(message.sid).toMatch(/^IM/);
    expect(message.index).toBe(0);
  });
});
