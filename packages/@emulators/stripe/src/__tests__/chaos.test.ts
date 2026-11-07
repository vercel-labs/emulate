import { describe, it, expect, afterEach, vi } from "vitest";
import { Store } from "@emulators/core";
import { seedFromConfig } from "../index.js";
import { createTestApp, captureWebhooks, verify, sdk, api, base, WEBHOOK_URL } from "./support.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Json = Record<string, any>;

async function confirmPayment(app: Parameters<typeof api>[0]) {
  const pi = await api(app, "POST", "/v1/payment_intents", {
    amount: 1500,
    currency: "usd",
    payment_method: "pm_card_visa",
  });
  return api(app, "POST", `/v1/payment_intents/${pi.body.id}/confirm`, {});
}

describe("Stripe webhook endpoints", () => {
  it("creates an endpoint, returns its secret once and delivers verifiable events to it", async () => {
    const { app } = createTestApp();
    const created = await api<Json>(app, "POST", "/v1/webhook_endpoints", {
      url: "https://app.example/hooks",
      enabled_events: ["customer.created"],
      description: "Billing hooks",
      metadata: { team: "billing" },
    });
    expect(created.status).toBe(200);
    expect(created.body.id).toMatch(/^we_[A-Za-z0-9]+$/);
    expect(created.body.secret).toMatch(/^whsec_[A-Za-z0-9]+$/);
    expect(Object.keys(created.body)).toEqual([
      "id",
      "object",
      "api_version",
      "application",
      "created",
      "description",
      "enabled_events",
      "livemode",
      "metadata",
      "secret",
      "status",
      "url",
    ]);
    expect(created.body).toMatchObject({
      object: "webhook_endpoint",
      api_version: null,
      application: null,
      description: "Billing hooks",
      enabled_events: ["customer.created"],
      livemode: false,
      metadata: { team: "billing" },
      status: "enabled",
      url: "https://app.example/hooks",
    });

    const fetched = await api<Json>(app, "GET", `/v1/webhook_endpoints/${created.body.id}`);
    expect(fetched.status).toBe(200);
    expect("secret" in fetched.body).toBe(false);
    expect(fetched.body.id).toBe(created.body.id);

    const hooks = captureWebhooks();
    await api(app, "POST", "/v1/products", { name: "Not subscribed" });
    await api(app, "POST", "/v1/customers", { name: "Subscribed" });
    expect(hooks.deliveries).toHaveLength(1);
    const delivery = hooks.deliveries[0];
    expect(delivery.url).toBe("https://app.example/hooks");
    const event = verify(delivery.body, delivery.headers["Stripe-Signature"], created.body.secret);
    expect(event.type).toBe("customer.created");
  });

  it("works through the stripe-node SDK and keeps api_version when given", async () => {
    const { app } = createTestApp();
    const stripe = sdk(app);
    const endpoint = await stripe.webhookEndpoints.create({
      url: "https://sdk.example/hooks",
      enabled_events: ["*"],
      api_version: "2026-10-28.endive",
    });
    expect(endpoint.api_version).toBe("2026-10-28.endive");
    const list = await stripe.webhookEndpoints.list();
    expect(list.data.map((e) => e.id)).toContain(endpoint.id);
    expect(list.data.every((e) => !("secret" in e))).toBe(true);
  });

  it("updates url, enabled_events, description, metadata and disabled", async () => {
    const { app } = createTestApp();
    const created = await api<Json>(app, "POST", "/v1/webhook_endpoints", {
      url: "https://old.example/hooks",
      enabled_events: ["customer.created"],
    });
    const updated = await api<Json>(app, "POST", `/v1/webhook_endpoints/${created.body.id}`, {
      url: "https://new.example/hooks",
      enabled_events: ["product.created"],
      description: "Renamed",
      metadata: { a: "1" },
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      url: "https://new.example/hooks",
      enabled_events: ["product.created"],
      description: "Renamed",
      metadata: { a: "1" },
      status: "enabled",
    });
    expect("secret" in updated.body).toBe(false);

    const hooks = captureWebhooks();
    await api(app, "POST", "/v1/customers", { name: "Ignored" });
    await api(app, "POST", "/v1/products", { name: "Delivered" });
    expect(hooks.deliveries.map((d) => [d.url, d.event.type])).toEqual([
      ["https://new.example/hooks", "product.created"],
    ]);

    const disabled = await api<Json>(app, "POST", `/v1/webhook_endpoints/${created.body.id}`, { disabled: true });
    expect(disabled.body.status).toBe("disabled");
    await api(app, "POST", "/v1/products", { name: "Not delivered" });
    expect(hooks.deliveries).toHaveLength(1);
    const events = await api<{ data: Json[] }>(app, "GET", "/v1/events?type=product.created");
    expect(events.body.data[0].pending_webhooks).toBe(0);

    const enabled = await api<Json>(app, "POST", `/v1/webhook_endpoints/${created.body.id}`, { disabled: "false" });
    expect(enabled.body.status).toBe("enabled");
    await api(app, "POST", "/v1/products", { name: "Delivered again" });
    expect(hooks.deliveries).toHaveLength(2);
  });

  it("deletes an endpoint and stops delivering to it", async () => {
    const { app } = createTestApp();
    const created = await api<Json>(app, "POST", "/v1/webhook_endpoints", {
      url: "https://gone.example/hooks",
      enabled_events: ["*"],
    });
    const deleted = await api<Json>(app, "DELETE", `/v1/webhook_endpoints/${created.body.id}`);
    expect(deleted.body).toEqual({ id: created.body.id, object: "webhook_endpoint", deleted: true });
    const missing = await api<{ error: Json }>(app, "GET", `/v1/webhook_endpoints/${created.body.id}`);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatchObject({
      type: "invalid_request_error",
      code: "resource_missing",
      message: `No such webhook_endpoint: '${created.body.id}'`,
    });

    const hooks = captureWebhooks();
    await api(app, "POST", "/v1/customers", { name: "Nobody listens" });
    expect(hooks.deliveries).toHaveLength(0);
  });

  it("rejects missing url, missing enabled_events and invalid urls", async () => {
    const { app } = createTestApp();
    const noUrl = await api<{ error: Json }>(app, "POST", "/v1/webhook_endpoints", { enabled_events: ["*"] });
    expect(noUrl.status).toBe(400);
    expect(noUrl.body.error).toMatchObject({
      type: "invalid_request_error",
      code: "parameter_missing",
      param: "url",
      message: "Missing required param: url.",
    });
    const noEvents = await api<{ error: Json }>(app, "POST", "/v1/webhook_endpoints", {
      url: "https://x.example/hooks",
    });
    expect(noEvents.status).toBe(400);
    expect(noEvents.body.error).toMatchObject({ code: "parameter_missing", param: "enabled_events" });
    const badUrl = await api<{ error: Json }>(app, "POST", "/v1/webhook_endpoints", {
      url: "not a url",
      enabled_events: ["*"],
    });
    expect(badUrl.status).toBe(400);
    expect(badUrl.body.error).toMatchObject({ code: "url_invalid", param: "url" });
  });

  it("lists seeded webhooks and does not register them twice", async () => {
    const { app } = createTestApp({ webhook: true });
    const list = await api<{ object: string; data: Json[] }>(app, "GET", "/v1/webhook_endpoints");
    expect(list.body.object).toBe("list");
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({
      object: "webhook_endpoint",
      url: WEBHOOK_URL,
      enabled_events: ["*"],
      status: "enabled",
    });
    expect(list.body.data[0].id).toMatch(/^we_/);

    const hooks = captureWebhooks();
    await api(app, "POST", "/v1/customers", { name: "Once" });
    expect(hooks.deliveries).toHaveLength(1);
  });

  it("delivers to a runtime endpoint exactly once after a snapshot is restored", async () => {
    const first = createTestApp();
    const created = await api<Json>(first.app, "POST", "/v1/webhook_endpoints", {
      url: "https://restored.example/hooks",
      enabled_events: ["customer.created"],
    });
    const snapshot = first.store.snapshot();

    // Restored into the same store: the dispatcher already has the endpoint.
    first.store.restore(snapshot);
    let hooks = captureWebhooks();
    await api(first.app, "POST", "/v1/customers", { name: "Same process" });
    expect(hooks.deliveries).toHaveLength(1);
    vi.unstubAllGlobals();

    // Restored into a fresh emulator, as after a restart.
    const second = createTestApp();
    second.store.restore(snapshot);
    hooks = captureWebhooks();
    await api(second.app, "POST", "/v1/customers", { name: "New process" });
    await api(second.app, "POST", "/v1/customers", { name: "Still once" });
    expect(hooks.deliveries).toHaveLength(2);
    expect(hooks.deliveries.every((d) => d.url === "https://restored.example/hooks")).toBe(true);
    verify(hooks.deliveries[0].body, hooks.deliveries[0].headers["Stripe-Signature"], created.body.secret);
    expect(second.webhooks.getSubscriptions("stripe")).toHaveLength(1);
  });

  it("stops delivering to an endpoint that a restored snapshot does not contain", async () => {
    const { app, store, webhooks } = createTestApp();
    const snapshot = store.snapshot();
    await api(app, "POST", "/v1/webhook_endpoints", { url: "https://later.example/hooks", enabled_events: ["*"] });
    store.restore(snapshot);

    const hooks = captureWebhooks();
    await api(app, "POST", "/v1/customers", { name: "After restore" });
    expect(hooks.deliveries).toHaveLength(0);
    expect(webhooks.getSubscriptions("stripe")).toHaveLength(0);
  });
});

describe("Stripe webhook chaos", () => {
  it("returns the default config and rejects out of range values", async () => {
    const { app } = createTestApp();
    const initial = await api<Json>(app, "GET", "/_stripe/webhooks/chaos");
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ enabled: false, drop: null, duplicate: null, delay: null, reorder: "none" });

    const bad = await api<{ error: Json }>(app, "POST", "/_stripe/webhooks/chaos", { drop: { rate: 2 } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.type).toBe("invalid_request_error");
    expect(bad.body.error.param).toBe("drop.rate");

    const badReorder = await api<{ error: Json }>(app, "POST", "/_stripe/webhooks/chaos", { reorder: "sideways" });
    expect(badReorder.status).toBe(400);
    expect(badReorder.body.error.param).toBe("reorder");

    const unknown = await api<{ error: Json }>(app, "POST", "/_stripe/webhooks/chaos", { explode: true });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.param).toBe("explode");
  });

  it("duplicates an event under the same evt_ id, and both copies verify", async () => {
    const { app } = createTestApp({ webhook: true });
    const set = await api<Json>(app, "POST", "/_stripe/webhooks/chaos", {
      duplicate: { types: ["customer.created"] },
    });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ enabled: true, duplicate: { rate: 1, types: ["customer.created"], count: 1 } });

    const hooks = captureWebhooks();
    await api(app, "POST", "/v1/customers", { name: "Twice" });
    await api(app, "POST", "/v1/products", { name: "Once" });
    const customerEvents = hooks.ofType("customer.created");
    expect(customerEvents).toHaveLength(2);
    expect(customerEvents[0].id).toBe(customerEvents[1].id);
    for (const delivery of hooks.deliveries) verify(delivery.body, delivery.headers["Stripe-Signature"]);
    expect(hooks.ofType("product.created")).toHaveLength(1);

    const fetched = await api<Json>(app, "GET", `/v1/events/${customerEvents[0].id}`);
    expect(fetched.body.pending_webhooks).toBe(0);
  });

  it("drops an event, lists it as dropped and redelivers it on request", async () => {
    const { app } = createTestApp({ webhook: true });
    await api(app, "POST", "/_stripe/webhooks/chaos", { drop: { rate: 1 } });
    const hooks = captureWebhooks();
    await api(app, "POST", "/v1/customers", { name: "Lost" });
    expect(hooks.deliveries).toHaveLength(0);

    const events = await api<{ data: Json[] }>(app, "GET", "/v1/events?type=customer.created");
    const eventId = events.body.data[0].id as string;
    const fetched = await api<Json>(app, "GET", `/v1/events/${eventId}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.pending_webhooks).toBe(1);

    const log = await api<{ object: string; data: Json[] }>(app, "GET", "/_stripe/webhooks/deliveries");
    expect(log.body.object).toBe("list");
    expect(log.body.data).toEqual([
      expect.objectContaining({
        event_id: eventId,
        type: "customer.created",
        status: "dropped",
        status_code: null,
        url: WEBHOOK_URL,
      }),
    ]);

    const redelivered = await api<Json>(app, "POST", `/_stripe/events/${eventId}/redeliver`);
    expect(redelivered.status).toBe(200);
    expect(redelivered.body.event_id).toBe(eventId);
    expect(redelivered.body.deliveries).toEqual([
      expect.objectContaining({ url: WEBHOOK_URL, status_code: 200, succeeded: true }),
    ]);
    expect(hooks.deliveries).toHaveLength(1);
    expect(hooks.events[0].id).toBe(eventId);
    verify(hooks.deliveries[0].body, hooks.deliveries[0].headers["Stripe-Signature"]);

    const after = await api<Json>(app, "GET", `/v1/events/${eventId}`);
    expect(after.body.pending_webhooks).toBe(0);
    const logAfter = await api<{ data: Json[] }>(app, "GET", "/_stripe/webhooks/deliveries");
    expect(logAfter.body.data.map((d) => d.status)).toEqual(["dropped", "succeeded"]);
    expect(logAfter.body.data[1].status_code).toBe(200);
  });

  it("returns resource_missing when redelivering an unknown event", async () => {
    const { app } = createTestApp({ webhook: true });
    const res = await api<{ error: Json }>(app, "POST", "/_stripe/events/evt_missing/redeliver");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: "resource_missing", message: "No such event: 'evt_missing'" });
  });

  it("holds a delayed event until flush, across a snapshot restore", async () => {
    const { app, store } = createTestApp({ webhook: true });
    await api(app, "POST", "/_stripe/webhooks/chaos", { delay: { types: ["payment_intent.succeeded"] } });
    let hooks = captureWebhooks();
    await confirmPayment(app);
    expect(hooks.events.map((e) => e.type)).toEqual(["payment_intent.created", "charge.succeeded"]);

    const held = await api<{ data: Json[] }>(app, "GET", "/_stripe/webhooks/deliveries?status=held");
    expect(held.body.data).toHaveLength(1);
    expect(held.body.data[0]).toMatchObject({ type: "payment_intent.succeeded", status: "held", status_code: null });
    const heldId = held.body.data[0].event_id as string;

    const snapshot = store.snapshot();
    vi.unstubAllGlobals();
    const restored = createTestApp({ webhook: true });
    restored.store.restore(snapshot);
    hooks = captureWebhooks();

    const flushed = await api<Json>(restored.app, "POST", "/_stripe/webhooks/flush", {});
    expect(flushed.status).toBe(200);
    expect(flushed.body.flushed).toEqual([heldId]);
    expect(flushed.body.remaining).toBe(0);
    expect(hooks.events.map((e) => e.id)).toEqual([heldId]);
    expect(hooks.events[0].type).toBe("payment_intent.succeeded");
    verify(hooks.deliveries[0].body, hooks.deliveries[0].headers["Stripe-Signature"]);

    const again = await api<Json>(restored.app, "POST", "/_stripe/webhooks/flush", {});
    expect(again.body.flushed).toEqual([]);
  });

  it("flushes only the requested event_ids, in the requested order", async () => {
    const { app } = createTestApp({ webhook: true });
    await api(app, "POST", "/_stripe/webhooks/chaos", { delay: { types: ["customer.created"] } });
    const hooks = captureWebhooks();
    await api(app, "POST", "/v1/customers", { name: "One" });
    await api(app, "POST", "/v1/customers", { name: "Two" });
    await api(app, "POST", "/v1/customers", { name: "Three" });
    expect(hooks.deliveries).toHaveLength(0);
    const held = await api<{ data: Json[] }>(app, "GET", "/_stripe/webhooks/deliveries?status=held");
    const ids = held.body.data.map((d) => d.event_id as string);
    expect(ids).toHaveLength(3);

    const partial = await api<Json>(app, "POST", "/_stripe/webhooks/flush", { event_ids: [ids[0]] });
    expect(partial.body).toMatchObject({ flushed: [ids[0]], remaining: 2 });
    const rest = await api<Json>(app, "POST", "/_stripe/webhooks/flush", { order: "reverse" });
    expect(rest.body.flushed).toEqual([ids[2], ids[1]]);
    expect(hooks.events.map((e) => e.id)).toEqual([ids[0], ids[2], ids[1]]);

    const bad = await api<{ error: Json }>(app, "POST", "/_stripe/webhooks/flush", { order: "sideways" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.param).toBe("order");
  });

  it("reverses a batch so charge.succeeded arrives before payment_intent.succeeded", async () => {
    const { app } = createTestApp({ webhook: true });
    await api(app, "POST", "/_stripe/webhooks/chaos", { reorder: "reverse" });
    const pi = await api(app, "POST", "/v1/payment_intents", {
      amount: 1500,
      currency: "usd",
      payment_method: "pm_card_visa",
    });
    const hooks = captureWebhooks();
    await api(app, "POST", `/v1/payment_intents/${pi.body.id}/confirm`, {});
    expect(hooks.events.map((e) => e.type)).toEqual(["charge.succeeded", "payment_intent.succeeded"]);
  });

  it("makes identical seeded decisions in two fresh emulators", async () => {
    async function decisions(): Promise<boolean[]> {
      const { app } = createTestApp({ webhook: true });
      await api(app, "POST", "/_stripe/webhooks/chaos", { seed: 42, drop: { rate: 0.5 } });
      const hooks = captureWebhooks();
      const delivered: boolean[] = [];
      for (let i = 0; i < 20; i++) {
        const before = hooks.deliveries.length;
        await api(app, "POST", "/v1/customers", { name: `Customer ${i}` });
        delivered.push(hooks.deliveries.length > before);
      }
      vi.unstubAllGlobals();
      return delivered;
    }
    const a = await decisions();
    const b = await decisions();
    expect(a).toEqual(b);
    expect(a).toContain(true);
    expect(a).toContain(false);
  });

  it("restores normal delivery after DELETE", async () => {
    const { app } = createTestApp({ webhook: true });
    await api(app, "POST", "/_stripe/webhooks/chaos", { drop: { rate: 1 } });
    const cleared = await api<Json>(app, "DELETE", "/_stripe/webhooks/chaos");
    expect(cleared.status).toBe(200);
    expect(cleared.body.enabled).toBe(false);
    const hooks = captureWebhooks();
    await api(app, "POST", "/v1/customers", { name: "Normal" });
    expect(hooks.deliveries).toHaveLength(1);
  });

  it("applies webhook_chaos from the seed config without any API call", async () => {
    const store = new Store();
    expect(() => seedFromConfig(store, base, { webhook_chaos: { drop: { rate: -1 } } })).toThrow(/drop\.rate/);

    const { app } = createTestApp({
      seed: {
        webhook_chaos: { reorder: "reverse" },
        webhooks: [{ url: "https://seeded.example/hooks", events: ["*"], secret: "whsec_seeded" }],
      },
    });
    const pi = await api(app, "POST", "/v1/payment_intents", {
      amount: 900,
      currency: "usd",
      payment_method: "pm_card_visa",
    });
    const hooks = captureWebhooks();
    await api(app, "POST", `/v1/payment_intents/${pi.body.id}/confirm`, {});
    expect(hooks.events.map((e) => e.type)).toEqual(["charge.succeeded", "payment_intent.succeeded"]);
    verify(hooks.deliveries[0].body, hooks.deliveries[0].headers["Stripe-Signature"], "whsec_seeded");

    const chaos = await api<Json>(app, "GET", "/_stripe/webhooks/chaos");
    expect(chaos.body).toMatchObject({ enabled: true, reorder: "reverse" });
  });

  it("serves the delivery log for core deliveries without chaos", async () => {
    const { app } = createTestApp({ webhook: true });
    captureWebhooks(500);
    await api(app, "POST", "/v1/customers", { name: "Fails" });
    const log = await api<{ data: Json[] }>(app, "GET", "/_stripe/webhooks/deliveries");
    expect(log.body.data).toEqual([
      expect.objectContaining({ type: "customer.created", status: "failed", status_code: 500, url: WEBHOOK_URL }),
    ]);
    const form = await app.request(`${base}/_stripe/webhooks/chaos`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "seed=7&drop[rate]=0.25&drop[types][0]=customer.created",
    });
    expect(form.status).toBe(200);
    expect(await form.json()).toMatchObject({ seed: 7, drop: { rate: 0.25, types: ["customer.created"] } });
  });
});
