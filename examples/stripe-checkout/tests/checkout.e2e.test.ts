import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { AddressInfo } from "node:net";
import Stripe from "stripe";
import { createServer } from "@emulators/core";
import { stripePlugin } from "@emulators/stripe";

type Server = ReturnType<typeof serve>;

async function listen(fetch: (req: Request) => Response | Promise<Response>): Promise<{
  url: string;
  port: number;
  server: Server;
}> {
  const server = serve({ fetch, port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, port, server };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

describe("Stripe checkout — full purchase loop, no Stripe account, no internet", () => {
  const events: Array<{ type: string; sessionId?: string }> = [];
  let emulator: Awaited<ReturnType<typeof listen>>;
  let receiver: Awaited<ReturnType<typeof listen>>;
  let stripe: Stripe;

  beforeAll(async () => {
    const { app, webhooks } = createServer(stripePlugin, {
      tokens: { sk_test_emulated: { login: "test-account", id: 1, scopes: [] } },
    });
    emulator = await listen(app.fetch);

    const recv = new Hono();
    recv.post("/webhooks/stripe", async (c) => {
      const body = (await c.req.json()) as { type: string; data?: { object?: { id?: string } } };
      events.push({ type: body.type, sessionId: body.data?.object?.id });
      return c.body(null, 204);
    });
    receiver = await listen(recv.fetch);

    webhooks.register({
      url: `${receiver.url}/webhooks/stripe`,
      events: ["*"],
      active: true,
      owner: "stripe",
    });

    stripe = new Stripe("sk_test_emulated", {
      host: "127.0.0.1",
      port: emulator.port,
      protocol: "http",
    });
  });

  afterAll(async () => {
    await Promise.all([closeServer(emulator.server), closeServer(receiver.server)]);
  });

  it("user buys a license, webhook fires, session is paid", async () => {
    const product = await stripe.products.create({ name: "Lifetime License" });
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: 2900,
      currency: "usd",
    });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: price.id, quantity: 1 }],
      success_url: "http://localhost:3000/success",
    });
    expect(session.id).toMatch(/^cs_/);
    expect(session.url).toContain(`/checkout/${session.id}`);

    // The hosted Checkout page POSTs here when the user clicks "Pay and
    // Complete". We do the same headlessly.
    const completeRes = await fetch(`${emulator.url}/checkout/${session.id}/complete`, {
      method: "POST",
      redirect: "manual",
    });
    expect(completeRes.status).toBeGreaterThanOrEqual(300);
    expect(completeRes.status).toBeLessThan(400);

    // The dispatcher awaits webhook delivery before issuing the redirect,
    // so the event is already in our receiver by now.
    const completed = events.find(
      (e) => e.type === "checkout.session.completed" && e.sessionId === session.id,
    );
    expect(completed).toBeDefined();

    const fetched = await stripe.checkout.sessions.retrieve(session.id);
    expect(fetched.status).toBe("complete");
    expect(fetched.payment_status).toBe("paid");
  });
});
