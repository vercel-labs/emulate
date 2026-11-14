import { createHmac, timingSafeEqual } from "crypto";
import { createServer as createHttpServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer, Store, WebhookDispatcher } from "@emulators/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getResendStore, resendPlugin, seedFromConfig, type ResendSeedConfig } from "../index.js";
import { svixSignature } from "../webhooks.js";

const base = "http://localhost:4000";
// A made-up signing secret. The part after whsec_ is valid base64 for a 24-byte key.
const exampleSecret = "whsec_emulateTestSecretDoNotUseInProd0";

interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

let receiver: Server;
let receiverUrl: string;
let received: Received[];

beforeEach(async () => {
  received = [];
  receiver = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ path: req.url ?? "", headers: req.headers, body });
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
});

function setup(config?: ResendSeedConfig) {
  const server = createServer(resendPlugin, { tokens: { re_test: { login: "test", id: 1 } } });
  if (config) seedFromConfig(server.store, base, config, server.webhooks);
  return server;
}

function request(server: ReturnType<typeof setup>, method: string, path: string, body?: unknown) {
  return server.app.request(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer re_test" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function sendEmail(server: ReturnType<typeof setup>) {
  return request(server, "POST", "/emails", {
    from: "sender@example.com",
    to: "user@example.com",
    subject: "Hooked",
  });
}

// Independent of the emulator's signer, following https://docs.svix.com/receiving/verifying-payloads/how-manual.
function verifySvix(secret: string, delivery: Received): boolean {
  const id = String(delivery.headers["svix-id"]);
  const timestamp = String(delivery.headers["svix-timestamp"]);
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const key = Buffer.from(secret.split("_")[1], "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${delivery.body}`).digest();
  return String(delivery.headers["svix-signature"])
    .split(" ")
    .some((entry) => {
      const [version, signature] = entry.split(",");
      const actual = Buffer.from(signature ?? "", "base64");
      return version === "v1" && actual.length === expected.length && timingSafeEqual(actual, expected);
    });
}

describe("Resend webhook signatures", () => {
  it("signs with the Svix scheme", () => {
    // Expected value computed with the svix library's Webhook.sign for the same inputs.
    const signature = svixSignature(
      exampleSecret,
      "msg_emulateExampleDelivery",
      "1767225600",
      '{"event_type":"ping","data":{"success":true}}',
    );
    expect(signature).toBe("v1,eojTRJNaE5ax1s5imPnr3B/GTzgMVqPlB67pBOo03kA=");
  });
});

describe("Resend Webhooks API", () => {
  it("creates, retrieves, lists, updates, and deletes a webhook", async () => {
    const server = setup();
    const createRes = await request(server, "POST", "/webhooks", {
      endpoint: `${receiverUrl}/hook`,
      events: ["email.sent"],
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as { object: string; id: string; signing_secret: string };
    expect(created.object).toBe("webhook");
    expect(created.signing_secret).toMatch(/^whsec_[A-Za-z0-9+/]{32}$/);

    const getRes = await request(server, "GET", `/webhooks/${created.id}`);
    expect(await getRes.json()).toEqual({
      object: "webhook",
      id: created.id,
      created_at: expect.any(String),
      status: "enabled",
      endpoint: `${receiverUrl}/hook`,
      events: ["email.sent"],
      signing_secret: created.signing_secret,
    });

    const listed = (await (await request(server, "GET", "/webhooks")).json()) as {
      object: string;
      has_more: boolean;
      data: Array<Record<string, unknown>>;
    };
    expect(listed.object).toBe("list");
    expect(listed.has_more).toBe(false);
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0].id).toBe(created.id);
    expect(listed.data[0]).not.toHaveProperty("signing_secret");

    const updateRes = await request(server, "PATCH", `/webhooks/${created.id}`, {
      events: ["email.sent", "email.delivered"],
      status: "disabled",
    });
    expect(await updateRes.json()).toEqual({ object: "webhook", id: created.id });
    const updated = (await (await request(server, "GET", `/webhooks/${created.id}`)).json()) as Record<string, unknown>;
    expect(updated.status).toBe("disabled");
    expect(updated.events).toEqual(["email.sent", "email.delivered"]);

    const deleteRes = await request(server, "DELETE", `/webhooks/${created.id}`);
    expect(await deleteRes.json()).toEqual({ object: "webhook", id: created.id, deleted: true });
    expect((await request(server, "GET", `/webhooks/${created.id}`)).status).toBe(404);
  });

  it("validates the endpoint, events, and status", async () => {
    const server = setup();
    expect((await request(server, "POST", "/webhooks", { events: ["email.sent"] })).status).toBe(422);
    expect((await request(server, "POST", "/webhooks", { endpoint: receiverUrl, events: [] })).status).toBe(422);
    const created = (await (
      await request(server, "POST", "/webhooks", { endpoint: receiverUrl, events: ["email.sent"] })
    ).json()) as { id: string };
    const res = await request(server, "PATCH", `/webhooks/${created.id}`, { status: "paused" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { name: string }).name).toBe("validation_error");
    expect((await request(server, "PATCH", "/webhooks/missing", { status: "enabled" })).status).toBe(404);
  });
});

describe("Resend webhook delivery", () => {
  it("delivers subscribed events with Svix headers that verify against the signing secret", async () => {
    const server = setup();
    const created = (await (
      await request(server, "POST", "/webhooks", { endpoint: `${receiverUrl}/hook`, events: ["email.delivered"] })
    ).json()) as { signing_secret: string };

    expect((await sendEmail(server)).status).toBe(200);

    expect(received).toHaveLength(1);
    const [delivery] = received;
    expect(delivery.path).toBe("/hook");
    expect(JSON.parse(delivery.body).type).toBe("email.delivered");
    expect(delivery.headers["content-type"]).toBe("application/json");
    expect(delivery.headers["svix-id"]).toMatch(/^msg_[0-9A-Za-z]+$/);
    expect(delivery.headers["svix-timestamp"]).toMatch(/^\d{10}$/);
    expect(delivery.headers["svix-signature"]).toMatch(/^v1,[A-Za-z0-9+/]+=*$/);
    expect(delivery.headers).not.toHaveProperty("x-hub-signature-256");
    expect(verifySvix(created.signing_secret, delivery)).toBe(true);
    expect(verifySvix("whsec_" + Buffer.alloc(24).toString("base64"), delivery)).toBe(false);
  });

  it("gives each delivery its own svix-id", async () => {
    const server = setup();
    await request(server, "POST", "/webhooks", { endpoint: receiverUrl, events: ["email.sent", "email.delivered"] });
    await sendEmail(server);
    expect(received.map((delivery) => JSON.parse(delivery.body).type)).toEqual(["email.sent", "email.delivered"]);
    expect(new Set(received.map((delivery) => delivery.headers["svix-id"])).size).toBe(2);
  });

  it("stops delivering to disabled and deleted webhooks", async () => {
    const server = setup();
    const { id } = (await (
      await request(server, "POST", "/webhooks", { endpoint: receiverUrl, events: ["email.sent"] })
    ).json()) as { id: string };

    await request(server, "PATCH", `/webhooks/${id}`, { status: "disabled" });
    await sendEmail(server);
    expect(received).toHaveLength(0);

    await request(server, "PATCH", `/webhooks/${id}`, { status: "enabled" });
    await sendEmail(server);
    expect(received).toHaveLength(1);

    await request(server, "DELETE", `/webhooks/${id}`);
    await sendEmail(server);
    expect(received).toHaveLength(1);
  });
});

describe("Resend seeded webhooks", () => {
  it("registers seeded webhooks with an explicit signing secret", async () => {
    const server = setup({
      webhooks: [{ endpoint: receiverUrl, events: ["email.sent"], signing_secret: exampleSecret }],
    });
    await sendEmail(server);
    expect(received).toHaveLength(1);
    expect(verifySvix(exampleSecret, received[0])).toBe(true);
  });

  it("subscribes to every emitted event and derives a stable secret when the seed leaves them out", async () => {
    const config: ResendSeedConfig = { webhooks: [{ endpoint: receiverUrl }] };
    const server = setup(config);
    const [webhook] = getResendStore(server.store).webhooks.all();
    expect(webhook.events).toContain("email.delivered");
    expect(webhook.events).toContain("domain.created");
    expect(webhook.signing_secret).toMatch(/^whsec_/);

    const other = new Store();
    seedFromConfig(other, base, config, new WebhookDispatcher());
    expect(getResendStore(other).webhooks.all()[0].signing_secret).toBe(webhook.signing_secret);

    await request(server, "POST", "/domains", { name: "example.com" });
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0].body).type).toBe("domain.created");
    expect(verifySvix(webhook.signing_secret, received[0])).toBe(true);
  });

  it("does not duplicate a seeded webhook when the seed runs again", () => {
    const store = new Store();
    const webhooks = new WebhookDispatcher();
    const config: ResendSeedConfig = { webhooks: [{ endpoint: receiverUrl }] };
    seedFromConfig(store, base, config, webhooks);
    seedFromConfig(store, base, config, webhooks);
    expect(getResendStore(store).webhooks.all()).toHaveLength(1);
    expect(webhooks.getSubscriptions("resend")).toHaveLength(1);
  });
});
