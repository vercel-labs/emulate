import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getTwilioStore,
  seedFromConfig,
  DEFAULT_ACCOUNT_SID,
  DEFAULT_API_KEY_SID,
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

  it("applies seed config to default resources without duplicating them", () => {
    seedFromConfig(setup.store, "http://localhost:4301", {
      account: {
        sid: DEFAULT_ACCOUNT_SID,
        auth_token: "custom_auth_token",
        friendly_name: "Custom Twilio Account",
      },
      api_keys: [{ sid: DEFAULT_API_KEY_SID, secret: "custom_api_secret", friendly_name: "Custom API Key" }],
      phone_numbers: [
        {
          phone_number: DEFAULT_PHONE_NUMBER,
          friendly_name: "Custom SMS Number",
          sms_url: "http://app.local/twilio/sms",
          sms_method: "GET",
          voice_url: "http://app.local/twilio/voice",
        },
      ],
      messaging_services: [
        {
          friendly_name: "Local Messaging Service",
          phone_numbers: [DEFAULT_PHONE_NUMBER],
          inbound_request_url: "http://app.local/twilio/messaging-service-inbound",
          status_callback: "http://app.local/twilio/status",
        },
      ],
      verify_services: [{ friendly_name: "Local Verify Service", code: "654321", default_channel: "call" }],
      conversations: { services: [{ friendly_name: "Local Conversations" }] },
    });

    const ts = getTwilioStore(setup.store);
    expect(ts.accounts.findOneBy("sid", DEFAULT_ACCOUNT_SID)?.friendly_name).toBe("Custom Twilio Account");
    expect(ts.apiKeys.all()).toHaveLength(1);
    expect(ts.apiKeys.findOneBy("sid", DEFAULT_API_KEY_SID)?.secret).toBe("custom_api_secret");
    expect(ts.phoneNumbers.all()).toHaveLength(1);
    expect(ts.phoneNumbers.findOneBy("phone_number", DEFAULT_PHONE_NUMBER)?.sms_url).toBe(
      "http://app.local/twilio/sms",
    );
    expect(ts.phoneNumbers.findOneBy("phone_number", DEFAULT_PHONE_NUMBER)?.sms_method).toBe("GET");
    expect(ts.messagingServices.all()).toHaveLength(1);
    expect(ts.messagingServices.findOneBy("sid", DEFAULT_MESSAGING_SERVICE_SID)?.inbound_request_url).toBe(
      "http://app.local/twilio/messaging-service-inbound",
    );
    expect(ts.messagingServicePhoneNumbers.all()).toHaveLength(1);
    expect(ts.verifyServices.all()).toHaveLength(1);
    expect(ts.verifyServices.findOneBy("sid", DEFAULT_VERIFY_SERVICE_SID)?.code).toBe("654321");
    expect(ts.conversationServices.all()).toHaveLength(1);
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

  it("validates MessagingServiceSid even when From is supplied", async () => {
    const create = await setup.app.request(
      `http://localhost/2010-04-01/Accounts/${DEFAULT_ACCOUNT_SID}/Messages.json`,
      {
        method: "POST",
        headers: formHeaders(),
        body: formBody({
          To: "+15550001111",
          From: DEFAULT_PHONE_NUMBER,
          MessagingServiceSid: "MG11111111111111111111111111111111",
          Body: "Invalid service",
        }),
      },
    );
    expect(create.status).toBe(400);
    const error = (await create.json()) as any;
    expect(error.code).toBe(20404);
    expect(getTwilioStore(setup.store).messages.all()).toHaveLength(0);
  });

  it("removes Messaging Service sender assignments when phone numbers are deleted", async () => {
    const ts = getTwilioStore(setup.store);
    const number = ts.phoneNumbers.findOneBy("phone_number", DEFAULT_PHONE_NUMBER)!;
    expect(ts.messagingServicePhoneNumbers.findBy("phone_number_sid", number.sid)).toHaveLength(1);

    const del = await setup.app.request(
      `http://localhost/2010-04-01/Accounts/${DEFAULT_ACCOUNT_SID}/IncomingPhoneNumbers/${number.sid}.json`,
      {
        method: "DELETE",
        headers: { Authorization: basicAuth() },
      },
    );
    expect(del.status).toBe(204);
    expect(ts.messagingServicePhoneNumbers.findBy("phone_number_sid", number.sid)).toHaveLength(0);

    const create = await setup.app.request(
      `http://localhost/2010-04-01/Accounts/${DEFAULT_ACCOUNT_SID}/Messages.json`,
      {
        method: "POST",
        headers: formHeaders(),
        body: formBody({
          To: "+15550001111",
          MessagingServiceSid: DEFAULT_MESSAGING_SERVICE_SID,
          Body: "No sender",
        }),
      },
    );
    expect(create.status).toBe(400);
    const error = (await create.json()) as any;
    expect(error.code).toBe(21712);
    expect(ts.messages.all()).toHaveLength(0);
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

  it("sends inbound webhook params in the query string for GET callbacks", async () => {
    let requestedUrl = "";
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      requestedUrl = String(url);
      return new Response("ok", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const number = getTwilioStore(setup.store).phoneNumbers.findOneBy("phone_number", DEFAULT_PHONE_NUMBER)!;
    getTwilioStore(setup.store).phoneNumbers.update(number.id, {
      sms_url: "http://app.local/twilio/inbound",
      sms_method: "GET",
    });

    const inbound = await setup.app.request("http://localhost/_twilio/simulate/inbound-message", {
      method: "POST",
      headers: formHeaders(),
      body: formBody({ To: DEFAULT_PHONE_NUMBER, From: "+15550009999", Body: "hello over get" }),
    });
    expect(inbound.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callbackUrl = new URL(requestedUrl);
    expect(`${callbackUrl.origin}${callbackUrl.pathname}`).toBe("http://app.local/twilio/inbound");
    expect(callbackUrl.searchParams.get("To")).toBe(DEFAULT_PHONE_NUMBER);
    expect(callbackUrl.searchParams.get("From")).toBe("+15550009999");
    expect(callbackUrl.searchParams.get("Body")).toBe("hello over get");

    const delivery = getTwilioStore(setup.store).webhookDeliveries.all()[0];
    expect(delivery.method).toBe("GET");
    expect(new URL(delivery.url).searchParams.get("MessageSid")).toBe(delivery.request_body.MessageSid);
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

  it("rejects invalid simulator status values without mutating resources", async () => {
    const messageRes = await setup.app.request(
      `http://localhost/2010-04-01/Accounts/${DEFAULT_ACCOUNT_SID}/Messages.json`,
      {
        method: "POST",
        headers: formHeaders(),
        body: formBody({ To: "+15550001111", From: DEFAULT_PHONE_NUMBER, Body: "Status check" }),
      },
    );
    const message = (await messageRes.json()) as any;

    const invalidMessageStatus = await setup.app.request("http://localhost/_twilio/simulate/message-status", {
      method: "POST",
      headers: formHeaders(),
      body: formBody({ MessageSid: message.sid, Status: "totally-done" }),
    });
    expect(invalidMessageStatus.status).toBe(400);
    expect(getTwilioStore(setup.store).messages.findOneBy("sid", message.sid)?.status).toBe("queued");

    const callRes = await setup.app.request(`http://localhost/2010-04-01/Accounts/${DEFAULT_ACCOUNT_SID}/Calls.json`, {
      method: "POST",
      headers: formHeaders(),
      body: formBody({ To: "+15550003333", From: DEFAULT_PHONE_NUMBER, Twiml: "<Response><Say>Hi</Say></Response>" }),
    });
    const call = (await callRes.json()) as any;

    const invalidCallStatus = await setup.app.request("http://localhost/_twilio/simulate/call-status", {
      method: "POST",
      headers: formHeaders(),
      body: formBody({ CallSid: call.sid, Status: "totally-done" }),
    });
    expect(invalidCallStatus.status).toBe(400);
    expect(getTwilioStore(setup.store).calls.findOneBy("sid", call.sid)?.status).toBe("ringing");
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
