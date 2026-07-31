import { createHmac } from "node:crypto";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { creemPlugin, getCreemStore, seedFromConfig } from "../index.js";

const baseUrl = "http://127.0.0.1:14001";
const webhookSecret = "creem-local-webhook-secret";

describe("Creem plugin", () => {
  let app: Hono;
  let store: Store;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = new Store();
    const webhooks = new WebhookDispatcher();
    app = new Hono();
    creemPlugin.register(app as never, store, webhooks, baseUrl);
    seedFromConfig(
      store,
      baseUrl,
      {
        products: [
          {
            id: "prod_console_dev",
            name: "YapHaus managed relay",
            amount: 6900,
            currency: "USD",
            return_url: "http://127.0.0.1:4322/welcome",
          },
        ],
        webhooks: [
          {
            url: "http://127.0.0.1:8787/webhooks/creem",
            events: ["*"],
            secret: webhookSecret,
          },
        ],
      },
      webhooks,
    );
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("completes hosted checkout, signs the real Creem shape, and redirects", async () => {
    const checkoutId = "ch_4cb64de3bb274d998a74f3cc191e3e14";
    const open = await app.request(
      `${baseUrl}/test/payment/prod_console_dev?checkout_id=${checkoutId}&metadata%5Btenant_slug%5D=alpha&metadata%5Boffer_intent_id%5D=4cb64de3-bb27-4d99-8a74-f3cc191e3e14`,
    );
    expect(open.status).toBe(200);
    const openHtml = await open.text();
    expect(openHtml).toContain("YapHaus managed relay");
    expect(openHtml).toContain('id="checkout-email"');
    expect(openHtml).toContain('autocomplete="email" required');

    const missingEmail = await app.request(`${baseUrl}/checkout/${checkoutId}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect(missingEmail.status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();

    const complete = await app.request(`${baseUrl}/checkout/${checkoutId}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "email=buyer%40example.com",
    });
    expect(complete.status).toBe(302);
    expect(complete.headers.get("location")).toBe(`http://127.0.0.1:4322/welcome/checkout/${checkoutId}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = String(init.body);
    const headers = init.headers as Record<string, string>;
    const event = JSON.parse(body);
    expect(event.eventType).toBe("checkout.completed");
    expect(event.object.status).toBe("completed");
    expect(event.object.product).toEqual({ id: "prod_console_dev" });
    expect(event.object.order).toMatchObject({ status: "paid", amount: 6900, currency: "USD" });
    expect(event.object.customer.email).toBe("buyer@example.com");
    expect(event.object.metadata.tenant_slug).toBe("alpha");
    expect(headers["Creem-Signature"]).toBe(createHmac("sha256", webhookSecret).update(body).digest("hex"));
  });

  it("cancels a subscription and sends a signed lifecycle webhook", async () => {
    const checkoutId = "ch_cancel_test";
    await app.request(`${baseUrl}/test/payment/prod_console_dev?checkout_id=${checkoutId}`);
    await app.request(`${baseUrl}/checkout/${checkoutId}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "email=test%40example.com",
    });
    fetchMock.mockClear();

    const subscription = getCreemStore(store).subscriptions.all()[0]!;
    const canceled = await app.request(`${baseUrl}/_creem/subscriptions/${subscription.creem_id}/cancel`, {
      method: "POST",
    });
    expect(canceled.status).toBe(200);
    expect((await canceled.json()) as { status: string }).toMatchObject({ status: "canceled" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const event = JSON.parse(String(init.body));
    expect(event.eventType).toBe("subscription.canceled");
    expect(event.object.id).toBe(subscription.creem_id);
  });
});
