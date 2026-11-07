import { describe, it, expect, afterEach, vi } from "vitest";
import { stripeId } from "../helpers.js";
import { createTestApp, captureWebhooks, verify, sdk, api, base, authHeaders } from "./support.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Json = Record<string, any>;

describe("Stripe events", () => {
  describe("webhook envelope", () => {
    it("delivers customer.created as a signed Event object", async () => {
      const { app } = createTestApp({ webhook: true });
      const hooks = captureWebhooks();

      const res = await api(app, "POST", "/v1/customers", { name: "Jane" }, { "Idempotency-Key": "idem-123" });
      expect(res.status).toBe(200);
      const requestId = res.headers.get("Request-Id");
      expect(requestId).toMatch(/^req_[A-Za-z0-9]+$/);

      expect(hooks.deliveries).toHaveLength(1);
      const delivery = hooks.deliveries[0];
      const event = verify(delivery.body, delivery.headers["Stripe-Signature"]);

      expect(event.id).toMatch(/^evt_[A-Za-z0-9]+$/);
      expect(event.object).toBe("event");
      expect(event.type).toBe("customer.created");
      expect(event.api_version).toBe("2026-10-28.endive");
      expect(event.livemode).toBe(false);
      expect(event.pending_webhooks).toBe(1);
      expect(event.created).toBeTypeOf("number");
      expect(event.request).toEqual({ id: requestId, idempotency_key: "idem-123" });
      expect((event.data.object as Json).id).toBe(res.body.id);
      expect("previous_attributes" in event.data).toBe(false);
      expect(Object.keys(event)).toEqual([
        "id",
        "object",
        "api_version",
        "created",
        "data",
        "livemode",
        "pending_webhooks",
        "request",
        "type",
      ]);
    });

    it("sends no Idempotency-Key as null", async () => {
      const { app } = createTestApp({ webhook: true });
      const hooks = captureWebhooks();
      await api(app, "POST", "/v1/products", { name: "Widget" });
      expect(hooks.events[0].request).toEqual({ id: expect.stringMatching(/^req_/), idempotency_key: null });
    });

    it("counts pending_webhooks across matching endpoints only", async () => {
      const { app } = createTestApp({
        seed: {
          webhooks: [
            { url: "https://a.example/hook", events: ["*"] },
            { url: "https://b.example/hook", events: ["customer.created"] },
            { url: "https://c.example/hook", events: ["product.created"] },
          ],
        },
      });
      const hooks = captureWebhooks();
      await api(app, "POST", "/v1/customers", { name: "Two endpoints" });
      expect(hooks.deliveries.map((d) => d.url)).toEqual(["https://a.example/hook", "https://b.example/hook"]);
      expect(hooks.events.every((e) => e.pending_webhooks === 2)).toBe(true);
    });

    it("stores events even without any webhook endpoint", async () => {
      const { app } = createTestApp();
      const created = await api(app, "POST", "/v1/customers", { name: "Quiet" });
      const list = await api<{ data: Json[] }>(app, "GET", "/v1/events?type=customer.created");
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0].data.object.id).toBe(created.body.id);
      expect(list.body.data[0].pending_webhooks).toBe(0);
    });

    it("uses the seeded api_version for later events", async () => {
      const { app } = createTestApp({ webhook: true, seed: { api_version: "2025-09-30.clover" } });
      const hooks = captureWebhooks();
      await api(app, "POST", "/v1/customers", { name: "Pinned" });
      expect(hooks.events[0].api_version).toBe("2025-09-30.clover");
    });

    it("leaves request ids null for events not caused by an API request", async () => {
      const { app } = createTestApp({ webhook: true });
      const session = await api(app, "POST", "/v1/checkout/sessions", { mode: "payment" });
      const hooks = captureWebhooks();
      await app.request(`${base}/checkout/${session.body.id}/complete`, { method: "POST" });
      const completed = hooks.ofType("checkout.session.completed");
      expect(completed).toHaveLength(1);
      expect(completed[0].request).toEqual({ id: null, idempotency_key: null });
    });
  });

  describe("request ids", () => {
    it("returns a Request-Id header on every /v1 response, errors included", async () => {
      const { app } = createTestApp();
      const ok = await app.request(`${base}/v1/customers`, { headers: authHeaders() });
      const missing = await app.request(`${base}/v1/customers/cus_nope`, { headers: authHeaders() });
      expect(ok.headers.get("Request-Id")).toMatch(/^req_[A-Za-z0-9]+$/);
      expect(missing.status).toBe(404);
      expect(missing.headers.get("Request-Id")).toMatch(/^req_[A-Za-z0-9]+$/);
      expect(ok.headers.get("Request-Id")).not.toBe(missing.headers.get("Request-Id"));
    });
  });

  describe("GET /v1/events/:id", () => {
    it("returns the delivered body with pending_webhooks 0 after a 2xx delivery", async () => {
      const { app } = createTestApp({ webhook: true });
      const hooks = captureWebhooks(200);
      await api(app, "POST", "/v1/customers", { name: "Delivered" });
      const delivered = hooks.events[0];

      const fetched = await api(app, "GET", `/v1/events/${delivered.id}`);
      expect(fetched.status).toBe(200);
      expect(fetched.body).toEqual({ ...delivered, pending_webhooks: 0 });
    });

    it("keeps pending_webhooks 1 after a failed delivery", async () => {
      const { app } = createTestApp({ webhook: true });
      const hooks = captureWebhooks(500);
      await api(app, "POST", "/v1/customers", { name: "Failed" });
      const fetched = await api(app, "GET", `/v1/events/${hooks.events[0].id}`);
      expect(fetched.body.pending_webhooks).toBe(1);
    });

    it("returns resource_missing for an unknown event", async () => {
      const { app } = createTestApp();
      const res = await api<{ error: Json }>(app, "GET", "/v1/events/evt_unknown");
      expect(res.status).toBe(404);
      expect(res.body.error.type).toBe("invalid_request_error");
      expect(res.body.error.code).toBe("resource_missing");
      expect(res.body.error.message).toBe("No such event: 'evt_unknown'");
    });
  });

  describe("GET /v1/events", () => {
    async function seedEvents() {
      const ctx = createTestApp();
      const customer = await api(ctx.app, "POST", "/v1/customers", { name: "A" });
      await api(ctx.app, "POST", "/v1/products", { name: "Widget" });
      await api(ctx.app, "POST", `/v1/customers/${customer.body.id}`, { name: "B" });
      return ctx;
    }

    it("lists newest first in list shape", async () => {
      const { app } = await seedEvents();
      const res = await api<{ object: string; url: string; has_more: boolean; data: Json[] }>(app, "GET", "/v1/events");
      expect(res.body.object).toBe("list");
      expect(res.body.url).toBe("/v1/events");
      expect(res.body.has_more).toBe(false);
      expect(res.body.data.map((e) => e.type)).toEqual(["customer.updated", "product.created", "customer.created"]);
    });

    it("filters by type", async () => {
      const { app } = await seedEvents();
      const res = await api<{ data: Json[] }>(app, "GET", "/v1/events?type=product.created");
      expect(res.body.data.map((e) => e.type)).toEqual(["product.created"]);
    });

    it("filters by a type wildcard", async () => {
      const { app } = await seedEvents();
      const res = await api<{ data: Json[] }>(app, "GET", "/v1/events?type=customer.*");
      expect(res.body.data.map((e) => e.type)).toEqual(["customer.updated", "customer.created"]);
    });

    it("filters by types[]", async () => {
      const { app } = await seedEvents();
      const res = await api<{ data: Json[] }>(
        app,
        "GET",
        "/v1/events?types[]=customer.created&types[]=product.created",
      );
      expect(res.body.data.map((e) => e.type)).toEqual(["product.created", "customer.created"]);
    });

    it("filters by indexed types and paginates through the sdk", async () => {
      const { app } = await seedEvents();
      const stripe = sdk(app);
      const page1 = await stripe.events.list({ types: ["customer.created", "customer.updated"], limit: 1 });
      expect(page1.data.map((e) => e.type)).toEqual(["customer.updated"]);
      expect(page1.has_more).toBe(true);
      const page2 = await stripe.events.list({
        types: ["customer.created", "customer.updated"],
        limit: 1,
        starting_after: page1.data[0].id,
      });
      expect(page2.data.map((e) => e.type)).toEqual(["customer.created"]);
      expect(page2.has_more).toBe(false);
    });

    it("filters by created range", async () => {
      const { app } = await seedEvents();
      const all = await api<{ data: Json[] }>(app, "GET", "/v1/events");
      const created = all.body.data[0].created as number;
      const inRange = await api<{ data: Json[] }>(app, "GET", `/v1/events?created[gte]=${created}`);
      expect(inRange.body.data).toHaveLength(3);
      const future = await api<{ data: Json[] }>(app, "GET", `/v1/events?created[gt]=${created + 1000}`);
      expect(future.body.data).toHaveLength(0);
    });

    it("filters by delivery_success", async () => {
      const { app } = createTestApp({ webhook: true });
      captureWebhooks((event) => (event.type === "customer.created" ? 500 : 200));
      await api(app, "POST", "/v1/customers", { name: "Fails" });
      await api(app, "POST", "/v1/products", { name: "Succeeds" });
      const failed = await api<{ data: Json[] }>(app, "GET", "/v1/events?delivery_success=false");
      const succeeded = await api<{ data: Json[] }>(app, "GET", "/v1/events?delivery_success=true");
      expect(failed.body.data.map((e) => e.type)).toEqual(["customer.created"]);
      expect(succeeded.body.data.map((e) => e.type)).toEqual(["product.created"]);
    });
  });

  describe("event payloads", () => {
    it("carries previous_attributes on customer.updated", async () => {
      const { app } = createTestApp({ webhook: true });
      const customer = await api(app, "POST", "/v1/customers", { name: "A", email: "a@example.com" });
      const hooks = captureWebhooks();
      await api(app, "POST", `/v1/customers/${customer.body.id}`, { name: "B", email: "a@example.com" });

      const updated = hooks.ofType("customer.updated");
      expect(updated).toHaveLength(1);
      expect(updated[0].data.previous_attributes).toEqual({ name: "A" });
      expect((updated[0].data.object as Json).name).toBe("B");
    });

    it("reports previous metadata keys, null for added keys", async () => {
      const { app } = createTestApp({ webhook: true });
      const customer = await api(app, "POST", "/v1/customers", { metadata: { plan: "free" } });
      const hooks = captureWebhooks();
      await api(app, "POST", `/v1/customers/${customer.body.id}`, { metadata: { plan: "pro", seats: "3" } });
      expect(hooks.events[0].data.previous_attributes).toEqual({ metadata: { plan: "free", seats: null } });
    });

    it("emits no customer.updated when nothing changed", async () => {
      const { app } = createTestApp({ webhook: true });
      const customer = await api(app, "POST", "/v1/customers", { name: "Same" });
      const hooks = captureWebhooks();
      const res = await api(app, "POST", `/v1/customers/${customer.body.id}`, { name: "Same" });
      expect(res.status).toBe(200);
      expect(hooks.deliveries).toHaveLength(0);
    });

    it("sends a charge.succeeded object equal to GET /v1/charges/:id", async () => {
      const { app } = createTestApp({ webhook: true });
      const customer = await api(app, "POST", "/v1/customers", { name: "Payer" });
      const pi = await api(app, "POST", "/v1/payment_intents", {
        amount: 2500,
        currency: "usd",
        customer: customer.body.id,
        payment_method: "pm_card_visa",
      });
      const hooks = captureWebhooks();
      await api(app, "POST", `/v1/payment_intents/${pi.body.id}/confirm`, {});

      const charges = hooks.ofType("charge.succeeded");
      expect(charges).toHaveLength(1);
      const charge = charges[0].data.object as Json;
      const fetched = await api(app, "GET", `/v1/charges/${charge.id}`);
      expect(charge).toEqual(fetched.body);
      expect(charge).toMatchObject({
        object: "charge",
        amount: 2500,
        amount_captured: 2500,
        amount_refunded: 0,
        captured: true,
        paid: true,
        refunded: false,
        status: "succeeded",
        customer: customer.body.id,
        payment_intent: pi.body.id,
        // pm_card_visa is cloned into a new pm_ when it is set on the intent, as on Stripe.
        payment_method: (pi.body as Json).payment_method,
        failure_code: null,
        livemode: false,
      });
      expect(hooks.ofType("payment_intent.succeeded")).toHaveLength(1);
    });

    it("snapshots data.object so later changes do not rewrite stored events", async () => {
      const { app } = createTestApp();
      const customer = await api(app, "POST", "/v1/customers", { name: "Before", metadata: { a: "1" } });
      await api(app, "POST", `/v1/customers/${customer.body.id}`, { name: "After", metadata: { a: "2" } });
      const created = await api<{ data: Json[] }>(app, "GET", "/v1/events?type=customer.created");
      expect(created.body.data[0].data.object.name).toBe("Before");
      expect(created.body.data[0].data.object.metadata).toEqual({ a: "1" });
    });
  });

  describe("expand", () => {
    async function paymentIntentWithCustomer() {
      const ctx = createTestApp();
      const customer = await api(ctx.app, "POST", "/v1/customers", { email: "exp@example.com" });
      const pi = await api(ctx.app, "POST", "/v1/payment_intents", {
        amount: 1000,
        currency: "usd",
        customer: customer.body.id,
      });
      return { ...ctx, customerId: customer.body.id as string, piId: pi.body.id as string };
    }

    it("expands through the sdk's indexed expand[0] query encoding", async () => {
      const { app, customerId, piId } = await paymentIntentWithCustomer();
      const pi = await sdk(app).paymentIntents.retrieve(piId, { expand: ["customer"] });
      expect(typeof pi.customer).toBe("object");
      expect((pi.customer as Json).id).toBe(customerId);
      expect((pi.customer as Json).object).toBe("customer");
    });

    it("expands from a POST body", async () => {
      const { app, customerId } = await paymentIntentWithCustomer();
      const pi = await sdk(app).paymentIntents.create({
        amount: 700,
        currency: "usd",
        customer: customerId,
        expand: ["customer"],
      });
      expect((pi.customer as Json).id).toBe(customerId);
    });

    it("expands from a form body using expand[]", async () => {
      const { app, customerId } = await paymentIntentWithCustomer();
      const res = await app.request(`${base}/v1/payment_intents`, {
        method: "POST",
        headers: { Authorization: "Bearer sk_test_abc123", "Content-Type": "application/x-www-form-urlencoded" },
        body: `amount=500&currency=usd&customer=${customerId}&expand[]=customer`,
      });
      const body = (await res.json()) as Json;
      expect(body.customer.id).toBe(customerId);
    });

    it("expands dotted paths through objects and data lists", async () => {
      const { app, customerId, piId } = await paymentIntentWithCustomer();
      await api(app, "POST", `/v1/payment_intents/${piId}/confirm`, { payment_method: "pm_card_visa" });
      const stripe = sdk(app);

      const charges = await stripe.charges.list({ expand: ["data.payment_intent.customer"] });
      const charge = charges.data[0];
      expect((charge.payment_intent as Json).id).toBe(piId);
      expect((charge.payment_intent as Json).customer.id).toBe(customerId);
    });

    it("includes fields that are only returned when expanded", async () => {
      const { app, piId } = await paymentIntentWithCustomer();
      await api(app, "POST", `/v1/payment_intents/${piId}/confirm`, { payment_method: "pm_card_visa" });
      const list = await api<{ data: Json[] }>(app, "GET", `/v1/charges?payment_intent=${piId}`);
      const chargeId = list.body.data[0].id as string;
      expect("refunds" in list.body.data[0]).toBe(false);

      const charge = await sdk(app).charges.retrieve(chargeId, { expand: ["refunds"] });
      expect(charge.refunds).toEqual({
        object: "list",
        data: [],
        has_more: false,
        total_count: 0,
        url: `/v1/charges/${chargeId}/refunds`,
      });
    });

    it("rejects expansions deeper than four levels", async () => {
      const { app, piId } = await paymentIntentWithCustomer();
      const res = await api<{ error: Json }>(app, "GET", `/v1/payment_intents/${piId}?expand[]=a.b.c.d.e`);
      expect(res.status).toBe(400);
      expect(res.body.error.type).toBe("invalid_request_error");
      expect(res.body.error.param).toBe("expand");
    });

    it("ignores expand paths that name inherited object members", async () => {
      const { app, piId } = await paymentIntentWithCustomer();
      const res = await api<Json>(
        app,
        "GET",
        `/v1/payment_intents/${piId}?expand[]=toString&expand[]=constructor&expand[]=customer.__proto__`,
      );
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(piId);
      expect(res.body.customer.object).toBe("customer");
      expect(Object.keys(res.body)).not.toContain("toString");
    });

    it("does not let bracket keys reach Object.prototype", async () => {
      const { app } = createTestApp();
      await api(app, "GET", "/v1/customers?__proto__[polluted]=yes&constructor[prototype][polluted]=yes");
      await app.request(`${base}/v1/customers`, {
        method: "POST",
        headers: { Authorization: "Bearer sk_test_abc123", "Content-Type": "application/x-www-form-urlencoded" },
        body: "name=x&__proto__[polluted]=yes&metadata[__proto__][polluted]=yes",
      });
      expect(({} as Json).polluted).toBeUndefined();
    });

    it("keeps the expand[]=customer query form working", async () => {
      const { app, customerId, piId } = await paymentIntentWithCustomer();
      const res = await api<Json>(app, "GET", `/v1/payment_intents/${piId}?expand[]=customer`);
      expect(res.body.customer.id).toBe(customerId);
    });
  });

  describe("ids", () => {
    it("generates base62 ids", () => {
      for (let i = 0; i < 1000; i++) {
        expect(stripeId("cus")).toMatch(/^cus_[A-Za-z0-9]{24}$/);
      }
    });
  });
});
