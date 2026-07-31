import { createHmac } from "node:crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "@emulators/core";
import {
  Store,
  WebhookDispatcher,
  authMiddleware,
  createApiErrorHandler,
  createErrorHandler,
  type TokenMap,
} from "@emulators/core";
import { stripePlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:14000";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("sk_test_abc123", {
    login: "test-account",
    id: 1,
    scopes: [],
  });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  stripePlugin.register(app as any, store, webhooks, base, tokenMap);
  stripePlugin.seed?.(store, base);

  return { app, store, webhooks, tokenMap };
}

function auth(): Record<string, string> {
  return {
    Authorization: "Bearer sk_test_abc123",
    "Content-Type": "application/json",
  };
}

describe("Stripe plugin", () => {
  let app: Hono;
  let webhooks: WebhookDispatcher;
  let store: Store;

  beforeEach(() => {
    const ctx = createTestApp();
    app = ctx.app;
    webhooks = ctx.webhooks;
    store = ctx.store;
  });

  describe("customers", () => {
    it("creates and retrieves a customer", async () => {
      const createRes = await app.request(`${base}/v1/customers`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ email: "user@test.com", name: "Jane Doe" }),
      });
      expect(createRes.status).toBe(200);
      const customer = (await createRes.json()) as { id: string; object: string; email: string; name: string };
      expect(customer.id).toMatch(/^cus_/);
      expect(customer.object).toBe("customer");
      expect(customer.email).toBe("user@test.com");

      const getRes = await app.request(`${base}/v1/customers/${customer.id}`, { headers: auth() });
      expect(getRes.status).toBe(200);
      const fetched = (await getRes.json()) as { id: string; email: string };
      expect(fetched.id).toBe(customer.id);
    });

    it("creates a customer from form-urlencoded body", async () => {
      const createRes = await app.request(`${base}/v1/customers`, {
        method: "POST",
        headers: {
          Authorization: "Bearer sk_test_abc123",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "email=form%40test.com&name=Form+User",
      });
      expect(createRes.status).toBe(200);
      const customer = (await createRes.json()) as { id: string; email: string; name: string };
      expect(customer.email).toBe("form@test.com");
      expect(customer.name).toBe("Form User");
    });

    it("returns Stripe-format error for missing customer", async () => {
      const res = await app.request(`${base}/v1/customers/cus_nonexistent`, { headers: auth() });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { type: string; message: string; code: string } };
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.code).toBe("resource_missing");
      expect(body.error.message).toContain("cus_nonexistent");
    });

    it("lists with cursor pagination", async () => {
      // Create 3 customers
      const ids: string[] = [];
      for (const name of ["Alice", "Bob", "Carol"]) {
        const res = await app.request(`${base}/v1/customers`, {
          method: "POST",
          headers: auth(),
          body: JSON.stringify({ name }),
        });
        const c = (await res.json()) as { id: string };
        ids.push(c.id);
      }

      // List with limit=2
      const page1 = await app.request(`${base}/v1/customers?limit=2`, { headers: auth() });
      const p1 = (await page1.json()) as { data: Array<{ id: string }>; has_more: boolean };
      expect(p1.data.length).toBe(2);
      expect(p1.has_more).toBe(true);

      // Next page using starting_after
      const lastId = p1.data[p1.data.length - 1].id;
      const page2 = await app.request(`${base}/v1/customers?limit=2&starting_after=${lastId}`, { headers: auth() });
      const p2 = (await page2.json()) as { data: Array<{ id: string }>; has_more: boolean };
      expect(p2.data.length).toBeGreaterThanOrEqual(1);
      // Ensure no overlap
      const p2Ids = p2.data.map((c) => c.id);
      expect(p2Ids).not.toContain(p1.data[0].id);
      expect(p2Ids).not.toContain(p1.data[1].id);
    });

    it("filters by email", async () => {
      await app.request(`${base}/v1/customers`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ email: "unique@test.com" }),
      });
      const res = await app.request(`${base}/v1/customers?email=unique@test.com`, { headers: auth() });
      const body = (await res.json()) as { data: Array<{ email: string }> };
      expect(body.data.every((c) => c.email === "unique@test.com")).toBe(true);
    });

    it("cascades delete to related entities", async () => {
      const custRes = await app.request(`${base}/v1/customers`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ email: "cascade@test.com" }),
      });
      const cust = (await custRes.json()) as { id: string };

      // Create a payment intent linked to this customer
      const piRes = await app.request(`${base}/v1/payment_intents`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ amount: 1000, currency: "usd", customer: cust.id }),
      });
      const pi = (await piRes.json()) as { id: string; customer: string };
      expect(pi.customer).toBe(cust.id);

      // Delete customer
      await app.request(`${base}/v1/customers/${cust.id}`, { method: "DELETE", headers: auth() });

      // Payment intent should have null customer
      const piCheck = await app.request(`${base}/v1/payment_intents/${pi.id}`, { headers: auth() });
      const piAfter = (await piCheck.json()) as { customer: string | null };
      expect(piAfter.customer).toBeNull();
    });
  });

  describe("payment intents", () => {
    it("creates a payment intent", async () => {
      const res = await app.request(`${base}/v1/payment_intents`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ amount: 2000, currency: "usd" }),
      });
      expect(res.status).toBe(200);
      const pi = (await res.json()) as { id: string; object: string; amount: number; status: string };
      expect(pi.id).toMatch(/^pi_/);
      expect(pi.status).toBe("requires_payment_method");
    });

    it("confirms a payment intent and creates a charge", async () => {
      const createRes = await app.request(`${base}/v1/payment_intents`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ amount: 5000, currency: "usd", payment_method: "pm_card_visa" }),
      });
      const pi = (await createRes.json()) as { id: string; status: string };
      expect(pi.status).toBe("requires_confirmation");

      const confirmRes = await app.request(`${base}/v1/payment_intents/${pi.id}/confirm`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({}),
      });
      expect(confirmRes.status).toBe(200);
      const confirmed = (await confirmRes.json()) as { status: string };
      expect(confirmed.status).toBe("succeeded");

      const chargesRes = await app.request(`${base}/v1/charges?payment_intent=${pi.id}`, { headers: auth() });
      const charges = (await chargesRes.json()) as { data: Array<{ amount: number; status: string }> };
      expect(charges.data).toHaveLength(1);
      expect(charges.data[0].amount).toBe(5000);
    });

    it("cancels a payment intent", async () => {
      const createRes = await app.request(`${base}/v1/payment_intents`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ amount: 1000, currency: "eur" }),
      });
      const pi = (await createRes.json()) as { id: string };

      const cancelRes = await app.request(`${base}/v1/payment_intents/${pi.id}/cancel`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({}),
      });
      expect(cancelRes.status).toBe(200);
      const canceled = (await cancelRes.json()) as { status: string };
      expect(canceled.status).toBe("canceled");
    });

    it("returns Stripe error for confirming succeeded intent", async () => {
      const createRes = await app.request(`${base}/v1/payment_intents`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ amount: 1000, currency: "usd", payment_method: "pm_card_visa" }),
      });
      const pi = (await createRes.json()) as { id: string };

      await app.request(`${base}/v1/payment_intents/${pi.id}/confirm`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({}),
      });

      const res = await app.request(`${base}/v1/payment_intents/${pi.id}/confirm`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { type: string; code: string } };
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.code).toBe("payment_intent_unexpected_state");
    });

    it("filters by status", async () => {
      await app.request(`${base}/v1/payment_intents`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ amount: 100, currency: "usd" }),
      });

      const res = await app.request(`${base}/v1/payment_intents?status=requires_payment_method`, { headers: auth() });
      const body = (await res.json()) as { data: Array<{ status: string }> };
      expect(body.data.every((pi) => pi.status === "requires_payment_method")).toBe(true);
    });

    it("supports expand[]=customer", async () => {
      const custRes = await app.request(`${base}/v1/customers`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ email: "expand@test.com", name: "Expand Test" }),
      });
      const cust = (await custRes.json()) as { id: string };

      const piRes = await app.request(`${base}/v1/payment_intents`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ amount: 3000, currency: "usd", customer: cust.id }),
      });
      const pi = (await piRes.json()) as { id: string; customer: string };

      // Without expand - customer is a string ID
      expect(typeof pi.customer).toBe("string");

      // With expand - customer is an object
      const expanded = await app.request(`${base}/v1/payment_intents/${pi.id}?expand[]=customer`, { headers: auth() });
      const body = (await expanded.json()) as { customer: { id: string; object: string; email: string } };
      expect(typeof body.customer).toBe("object");
      expect(body.customer.object).toBe("customer");
      expect(body.customer.email).toBe("expand@test.com");
    });
  });

  describe("products and prices", () => {
    it("creates a product and price", async () => {
      const prodRes = await app.request(`${base}/v1/products`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ name: "T-Shirt" }),
      });
      expect(prodRes.status).toBe(200);
      const product = (await prodRes.json()) as { id: string; name: string };
      expect(product.id).toMatch(/^prod_/);

      const priceRes = await app.request(`${base}/v1/prices`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ product: product.id, currency: "usd", unit_amount: 2000 }),
      });
      expect(priceRes.status).toBe(200);
      const price = (await priceRes.json()) as { id: string; product: string; unit_amount: number };
      expect(price.id).toMatch(/^price_/);
      expect(price.product).toBe(product.id);
    });

    it("supports expand[]=product on prices", async () => {
      const prodRes = await app.request(`${base}/v1/products`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ name: "Expandable Widget" }),
      });
      const product = (await prodRes.json()) as { id: string };

      const priceRes = await app.request(`${base}/v1/prices`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ product: product.id, currency: "usd", unit_amount: 500 }),
      });
      const price = (await priceRes.json()) as { id: string };

      const expanded = await app.request(`${base}/v1/prices/${price.id}?expand[]=product`, { headers: auth() });
      const body = (await expanded.json()) as { product: { id: string; object: string; name: string } };
      expect(typeof body.product).toBe("object");
      expect(body.product.object).toBe("product");
      expect(body.product.name).toBe("Expandable Widget");
    });
  });

  describe("checkout sessions", () => {
    it("supports a packaged YapHaus subscription checkout with signed webhook and authoritative retrieval", async () => {
      seedFromConfig(
        store,
        base,
        {
          api_version: "2026-06-24.preview",
          products: [{ id: "prod_console_dev", name: "YapHaus managed relay" }],
          prices: [
            {
              id: "price_console_dev",
              product_name: "YapHaus managed relay",
              currency: "usd",
              unit_amount: 6900,
              tax_behavior: "inclusive",
              recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
            },
          ],
          webhooks: [
            {
              url: "http://127.0.0.1:8787/webhooks/stripe",
              events: ["*"],
              secret: "whsec_local_stripe_secret",
            },
          ],
        },
        webhooks,
      );
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      try {
        const createRes = await app.request(`${base}/v1/checkout/sessions`, {
          method: "POST",
          headers: auth(),
          body: JSON.stringify({
            mode: "subscription",
            line_items: [{ price: "price_console_dev", quantity: 1 }],
            client_reference_id: "4cb64de3-bb27-4d99-8a74-f3cc191e3e14",
            metadata: {
              offer_intent_id: "4cb64de3-bb27-4d99-8a74-f3cc191e3e14",
              terms_version: "2026-07-30",
            },
            success_url: "http://127.0.0.1:4322/welcome/checkout/{CHECKOUT_SESSION_ID}",
          }),
        });
        expect(createRes.status).toBe(200);
        const created = (await createRes.json()) as { id: string; url: string };
        expect(created.id).toMatch(/^cs_test_/);
        expect(created.url).toBe(`${base}/checkout/${created.id}`);

        const hostedCheckout = await app.request(created.url);
        const hostedCheckoutHtml = await hostedCheckout.text();
        expect(hostedCheckoutHtml).toContain('id="checkout-email"');
        expect(hostedCheckoutHtml).toContain('autocomplete="email" required');

        const missingEmail = await app.request(`${base}/checkout/${created.id}/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "",
        });
        expect(missingEmail.status).toBe(422);
        expect(fetchMock).not.toHaveBeenCalled();

        const completed = await app.request(`${base}/checkout/${created.id}/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "email=buyer%40example.com",
        });
        expect(completed.status).toBe(302);
        expect(completed.headers.get("location")).toBe(`http://127.0.0.1:4322/welcome/checkout/${created.id}`);

        const authoritative = await app.request(`${base}/v1/checkout/sessions/${created.id}`, {
          headers: auth(),
        });
        const session = (await authoritative.json()) as Record<string, any>;
        expect(session).toMatchObject({
          id: created.id,
          mode: "subscription",
          status: "complete",
          payment_status: "paid",
          client_reference_id: "4cb64de3-bb27-4d99-8a74-f3cc191e3e14",
          amount_subtotal: 6900,
          currency: "usd",
          livemode: false,
        });
        expect(session.customer.email).toBe("buyer@example.com");
        expect(session.subscription.id).toMatch(/^sub_/);
        expect(session.line_items.data[0].price).toMatchObject({
          id: "price_console_dev",
          type: "recurring",
          billing_scheme: "per_unit",
          tax_behavior: "inclusive",
          unit_amount: 6900,
          recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
        });
        const subscriptionResponse = await app.request(
          `${base}/v1/subscriptions/${session.subscription.id}?expand[]=items.data.price.product`,
          { headers: auth() },
        );
        const subscription = (await subscriptionResponse.json()) as Record<string, any>;
        expect(subscription.items.data).toHaveLength(1);
        expect(subscription.items.data[0]).toMatchObject({
          quantity: 1,
          price: {
            id: "price_console_dev",
            unit_amount: 6900,
            currency: "usd",
            tax_behavior: "inclusive",
            product: { id: "prod_console_dev", active: true },
          },
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        const body = String(init.body);
        const headers = init.headers as Record<string, string>;
        const signature = headers["Stripe-Signature"];
        expect(signature).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
        const timestamp = signature.split(",")[0]!.slice(2);
        const expected = createHmac("sha256", "whsec_local_stripe_secret").update(`${timestamp}.${body}`).digest("hex");
        expect(signature).toBe(`t=${timestamp},v1=${expected}`);
        const event = JSON.parse(body);
        expect(event).toMatchObject({
          api_version: "2026-06-24.preview",
          livemode: false,
          type: "checkout.session.completed",
        });

        fetchMock.mockClear();
        const canceledResponse = await app.request(
          `${base}/v1/subscriptions/${session.subscription.id}`,
          { method: "DELETE", headers: auth() },
        );
        const canceled = (await canceledResponse.json()) as Record<string, any>;
        expect(canceled.status).toBe("canceled");
        expect(canceled.items.data[0].price.product.id).toBe("prod_console_dev");
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [, cancelInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        const cancelBody = String(cancelInit.body);
        const cancelHeaders = cancelInit.headers as Record<string, string>;
        expect(cancelHeaders["Stripe-Signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
        expect(JSON.parse(cancelBody)).toMatchObject({
          type: "customer.subscription.deleted",
          data: {
            object: {
              id: session.subscription.id,
              status: "canceled",
              items: { data: [{ price: { id: "price_console_dev" } }] },
            },
          },
        });
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("creates and expires a checkout session", async () => {
      const createRes = await app.request(`${base}/v1/checkout/sessions`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ mode: "payment", success_url: "https://example.com/success" }),
      });
      expect(createRes.status).toBe(200);
      const session = (await createRes.json()) as { id: string; object: string; status: string; url: string };
      expect(session.id).toMatch(/^cs_/);
      expect(session.status).toBe("open");
      expect(session.url).toBeTruthy();

      const expireRes = await app.request(`${base}/v1/checkout/sessions/${session.id}/expire`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({}),
      });
      expect(expireRes.status).toBe(200);
      const expired = (await expireRes.json()) as { status: string; url: string | null };
      expect(expired.status).toBe("expired");
      expect(expired.url).toBeNull();
    });

    it("completes payment and setup sessions without creating subscriptions", async () => {
      for (const mode of ["payment", "setup"] as const) {
        const createRes = await app.request(`${base}/v1/checkout/sessions`, {
          method: "POST",
          headers: auth(),
          body: JSON.stringify({ mode }),
        });
        expect(createRes.status).toBe(200);
        const created = (await createRes.json()) as { id: string };

        const completed = await app.request(`${base}/checkout/${created.id}/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `email=${mode}%40example.com`,
        });
        expect(completed.status).toBe(200);

        const authoritative = await app.request(`${base}/v1/checkout/sessions/${created.id}`, {
          headers: auth(),
        });
        const session = (await authoritative.json()) as Record<string, any>;
        expect(session).toMatchObject({
          id: created.id,
          mode,
          status: "complete",
          payment_status: mode === "setup" ? "no_payment_required" : "paid",
          subscription: null,
        });
        if (mode === "payment") {
          expect(session.payment_intent).toMatchObject({ status: "succeeded" });
          const paymentIntent = await app.request(`${base}/v1/payment_intents/${session.payment_intent.id}`, {
            headers: auth(),
          });
          expect(paymentIntent.status).toBe(200);
          expect(await paymentIntent.json()).toMatchObject({
            id: session.payment_intent.id,
            amount: 0,
            currency: "usd",
            status: "succeeded",
          });
        } else {
          expect(session.payment_intent).toBeNull();
        }
      }
    });

    it("rejects a subscription completion without a line item", async () => {
      const createRes = await app.request(`${base}/v1/checkout/sessions`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ mode: "subscription" }),
      });
      expect(createRes.status).toBe(200);
      const created = (await createRes.json()) as { id: string };

      const completed = await app.request(`${base}/checkout/${created.id}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "email=subscription%40example.com",
      });
      expect(completed.status).toBe(422);
      expect(await completed.text()).toContain("A subscription checkout needs at least one line item.");

      const authoritative = await app.request(`${base}/v1/checkout/sessions/${created.id}`, {
        headers: auth(),
      });
      expect(await authoritative.json()).toMatchObject({
        id: created.id,
        status: "open",
        subscription: null,
        payment_intent: null,
      });
    });

    it("lists with status filter", async () => {
      await app.request(`${base}/v1/checkout/sessions`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ mode: "payment" }),
      });

      const res = await app.request(`${base}/v1/checkout/sessions?status=open`, { headers: auth() });
      const body = (await res.json()) as { data: Array<{ status: string }> };
      expect(body.data.every((s) => s.status === "open")).toBe(true);
    });
  });

  describe("customer sessions", () => {
    it("creates a customer session", async () => {
      const custRes = await app.request(`${base}/v1/customers`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ email: "session@test.com" }),
      });
      const cust = (await custRes.json()) as { id: string };

      const res = await app.request(`${base}/v1/customer_sessions`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({
          customer: cust.id,
          components: { payment_element: { enabled: true } },
        }),
      });
      expect(res.status).toBe(200);
      const session = (await res.json()) as {
        object: string;
        client_secret: string;
        customer: string;
        components: Record<string, unknown>;
        created: number;
        expires_at: number;
      };
      expect(session.object).toBe("customer_session");
      expect(session.client_secret).toBeTruthy();
      expect(session.customer).toBe(cust.id);
      expect(session.components).toEqual({ payment_element: { enabled: true } });
      expect(session.created).toBeTypeOf("number");
      expect(session.expires_at).toBeGreaterThan(session.created);
    });

    it("returns error for missing customer param", async () => {
      const res = await app.request(`${base}/v1/customer_sessions`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { type: string; param: string } };
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.param).toBe("customer");
    });

    it("returns error for nonexistent customer", async () => {
      const res = await app.request(`${base}/v1/customer_sessions`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ customer: "cus_nonexistent" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { type: string; code: string } };
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.code).toBe("resource_missing");
    });
  });

  describe("payment methods", () => {
    it("lists payment methods for a customer", async () => {
      const custRes = await app.request(`${base}/v1/customers`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ email: "methods@test.com" }),
      });
      const cust = (await custRes.json()) as { id: string };

      const res = await app.request(`${base}/v1/payment_methods?customer=${cust.id}&type=card`, {
        headers: auth(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: unknown[];
        has_more: boolean;
        object: string;
        url: string;
      };
      expect(body.object).toBe("list");
      expect(body.url).toBe("/v1/payment_methods");
      expect(body.has_more).toBe(false);
      expect(body.data).toEqual([]);
    });

    it("returns error for nonexistent customer", async () => {
      const res = await app.request(`${base}/v1/payment_methods?customer=cus_nonexistent&type=card`, {
        headers: auth(),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; param: string; type: string } };
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.code).toBe("resource_missing");
      expect(body.error.param).toBe("customer");
    });
  });

  describe("seed", () => {
    it("seeds customers and products from config", async () => {
      const store = new Store();
      stripePlugin.seed?.(store, base);
      seedFromConfig(store, base, {
        customers: [{ email: "seed@test.com", name: "Seeded User" }],
        products: [{ name: "Widget" }],
        prices: [{ product_name: "Widget", currency: "usd", unit_amount: 999 }],
      });

      const { getStripeStore } = await import("../store.js");
      const ss = getStripeStore(store);
      const customers = ss.customers.all();
      expect(customers.some((c) => c.email === "seed@test.com")).toBe(true);

      const products = ss.products.all();
      const widget = products.find((p) => p.name === "Widget");
      expect(widget).toBeDefined();

      const prices = ss.prices.findBy("product_id", widget!.stripe_id);
      expect(prices).toHaveLength(1);
      expect(prices[0].unit_amount).toBe(999);
    });
  });
});
