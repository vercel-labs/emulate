import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, afterEach } from "vitest";
import Stripe from "stripe";
import { createServer, serve } from "@emulators/core";
import { stripePlugin } from "../index.js";

/**
 * The billing lifecycle of a SaaS (a 7 day trial with a card on file, a flat monthly plan and a
 * metered overage price whose first 1000 units are free, webhooks driving entitlement) run over
 * real HTTP: the emulator listens on a port the way `emulate` serves it, stripe-node talks to it
 * with its default Node client, and a local webhook receiver verifies every delivery with
 * stripe.webhooks.constructEvent before recording it.
 */

type Json = Record<string, any>;

const API_KEY = "sk_test_billing_scenarios";
const DAY = 86400;
const HOUR = 3600;
const T = Math.floor(Date.UTC(2026, 0, 15, 12, 0, 0) / 1000);
const TRIAL_END = T + 7 * DAY;
const FEB_15 = Math.floor(Date.UTC(2026, 1, 15, 12, 0, 0) / 1000);
const MAR_15 = Math.floor(Date.UTC(2026, 2, 15, 12, 0, 0) / 1000);
const APR_15 = Math.floor(Date.UTC(2026, 3, 15, 12, 0, 0) / 1000);
const SUCCESS_URL = "https://saas.example/welcome?session_id={CHECKOUT_SESSION_ID}";

const verifier = new Stripe(API_KEY);

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    const ready = () => resolve((server.address() as AddressInfo).port);
    if (server.listening) ready();
    else server.once("listening", ready);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

interface Delivery {
  raw: string;
  signature: string;
  event: Stripe.Event;
}

/** A webhook endpoint as an app would run it: it verifies the signature and answers 2xx. */
class Receiver {
  readonly deliveries: Delivery[] = [];
  readonly rejected: string[] = [];
  secret: string | undefined;
  /** The status the endpoint answers a verified event with. */
  status: (event: Stripe.Event) => number = () => 200;
  private readonly server = createHttpServer(async (req, res) => {
    const raw = await readBody(req);
    const signature = String(req.headers["stripe-signature"] ?? "");
    try {
      if (!this.secret) throw new Error("No endpoint secret yet");
      const event = verifier.webhooks.constructEvent(raw, signature, this.secret);
      this.deliveries.push({ raw, signature, event });
      res.statusCode = this.status(event);
    } catch (error) {
      this.rejected.push(error instanceof Error ? error.message : String(error));
      res.statusCode = 400;
    }
    res.end();
  });
  url = "";

  async start(): Promise<void> {
    this.server.listen(0, "127.0.0.1");
    this.url = `http://127.0.0.1:${await listen(this.server)}/webhooks/stripe`;
  }

  stop(): Promise<void> {
    return close(this.server);
  }

  get events(): Stripe.Event[] {
    return this.deliveries.map((d) => d.event);
  }

  get types(): string[] {
    return this.events.map((e) => e.type);
  }

  ofType(type: string): Stripe.Event[] {
    return this.events.filter((e) => e.type === type);
  }

  /** Events delivered from index `from` on. */
  since(from: number): Stripe.Event[] {
    return this.events.slice(from);
  }
}

interface Emulator {
  baseUrl: string;
  stripe: Stripe;
  receiver: Receiver;
  endpoint: Stripe.WebhookEndpoint;
  /** Call an emulator-only control route. */
  control(method: string, path: string, body?: Json): Promise<{ status: number; body: Json }>;
}

const running: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const stop of running.splice(0)) await stop();
});

/** Serve the emulator on a free port, start a receiver and register it as a webhook endpoint. */
async function startEmulator(): Promise<Emulator> {
  // The base URL needs the port, so the app is attached once the server listens, as `emulate` does.
  const target: { fetch?: (request: Request) => Response | Promise<Response> } = {};
  const server = serve({
    fetch: (request) => (target.fetch ? target.fetch(request) : new Response("Starting", { status: 503 })),
    port: 0,
  });
  const port = await listen(server);
  const baseUrl = `http://localhost:${port}`;
  const { app, store } = createServer(stripePlugin, {
    port,
    baseUrl,
    tokens: { [API_KEY]: { login: "saas", id: 1, scopes: [] } },
  });
  stripePlugin.seed?.(store, baseUrl);
  target.fetch = app.fetch;

  const receiver = new Receiver();
  await receiver.start();
  running.push(async () => {
    await close(server);
    await receiver.stop();
    expect(receiver.rejected, "every delivery verifies").toEqual([]);
  });

  const stripe = new Stripe(API_KEY, {
    host: "localhost",
    port,
    protocol: "http",
    maxNetworkRetries: 0,
    telemetry: false,
  });
  const endpoint = await stripe.webhookEndpoints.create({ url: receiver.url, enabled_events: ["*"] });
  expect(endpoint.secret).toMatch(/^whsec_/);
  receiver.secret = endpoint.secret;

  const control = async (method: string, path: string, body?: Json) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Json };
  };

  return { baseUrl, stripe, receiver, endpoint, control };
}

interface Saas extends Emulator {
  clock: Stripe.TestHelpers.TestClock;
  product: Stripe.Product;
  flat: Stripe.Price;
  metered: Stripe.Price;
  meter: Stripe.Billing.Meter;
}

/** The SaaS catalogue, and a test clock frozen at T for its customers. */
async function saas(): Promise<Saas> {
  const emulator = await startEmulator();
  const { stripe } = emulator;
  const product = await stripe.products.create({ name: "Pro" });
  const flat = await stripe.prices.create({
    product: product.id,
    currency: "usd",
    unit_amount: 2900,
    recurring: { interval: "month" },
    lookup_key: "pro_monthly",
  });
  const meter = await stripe.billing.meters.create({
    display_name: "API requests",
    event_name: "api_requests",
    default_aggregation: { formula: "sum" },
  });
  const metered = await stripe.prices.create({
    product: product.id,
    currency: "usd",
    recurring: { interval: "month", usage_type: "metered", meter: meter.id },
    billing_scheme: "tiered",
    tiers_mode: "graduated",
    tiers: [
      { up_to: 1000, unit_amount: 0 },
      { up_to: "inf", unit_amount: 3 },
    ],
  });
  const clock = await stripe.testHelpers.testClocks.create({ frozen_time: T, name: "billing scenarios" });
  return { ...emulator, clock, product, flat, metered, meter };
}

function obj(event: Stripe.Event): Json {
  return event.data.object as unknown as Json;
}

function previous(event: Stripe.Event): Json {
  return (event.data.previous_attributes ?? {}) as Json;
}

/** Assert that the types occur in this order among the events (others may come between). */
function expectInOrder(events: Stripe.Event[], expected: string[]) {
  const seen: string[] = events.map((e) => e.type);
  let from = 0;
  for (const type of expected) {
    const at = seen.indexOf(type, from);
    expect(at, `${type} at or after position ${from} in [${seen.join(", ")}]`).toBeGreaterThanOrEqual(0);
    from = at + 1;
  }
}

function typesOf(events: Stripe.Event[]): string[] {
  return events.map((e) => e.type);
}

/** The subscription.updated event that moved the status to `status`. */
function statusChange(events: Stripe.Event[], status: string): Stripe.Event | undefined {
  return events.find(
    (e) => e.type === "customer.subscription.updated" && obj(e).status === status && "status" in previous(e),
  );
}

/** Advance the clock and return the events the advance delivered. */
async function advance(s: Saas, frozenTime: number): Promise<Stripe.Event[]> {
  const from = s.receiver.events.length;
  const clock = await s.stripe.testHelpers.testClocks.advance(s.clock.id, { frozen_time: frozenTime });
  expect(clock).toMatchObject({ id: s.clock.id, object: "test_helpers.test_clock", status: "advancing" });
  const sent = s.receiver.since(from);
  expect(sent[0]?.type).toBe("test_helpers.test_clock.advancing");
  expect(sent.at(-1)?.type).toBe("test_helpers.test_clock.ready");
  expect(await s.stripe.testHelpers.testClocks.retrieve(s.clock.id)).toMatchObject({
    status: "ready",
    frozen_time: frozenTime,
  });
  return sent;
}

async function clockCustomer(s: Saas, card?: string): Promise<Stripe.Customer> {
  return s.stripe.customers.create({
    email: "founder@saas.example",
    test_clock: s.clock.id,
    ...(card && { payment_method: card, invoice_settings: { default_payment_method: card } }),
  });
}

/** Submit the hosted Checkout page with a test card, or "none" to skip the card. */
async function payOnCheckoutPage(s: Emulator, session: Stripe.Checkout.Session, paymentMethod: string) {
  expect(session.url).toBeTruthy();
  const res = await fetch(`${session.url}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "founder@saas.example", payment_method: paymentMethod }).toString(),
    redirect: "manual",
  });
  expect(res.status, await res.clone().text()).toBe(302);
  expect(res.headers.get("location")).toBe(SUCCESS_URL.replace("{CHECKOUT_SESSION_ID}", session.id));
}

interface TrialOptions {
  collection?: "always" | "if_required";
  missing?: "cancel" | "pause" | "create_invoice";
}

/** Scenario 1's flow: a 7 day trial through subscription-mode Checkout. */
async function checkoutTrial(s: Saas, card: string, options: TrialOptions = {}) {
  const customer = await clockCustomer(s);
  const session = await s.stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customer.id,
    line_items: [{ price: s.flat.id, quantity: 1 }, { price: s.metered.id }],
    payment_method_collection: options.collection ?? "always",
    subscription_data: {
      trial_period_days: 7,
      ...(options.missing && { trial_settings: { end_behavior: { missing_payment_method: options.missing } } }),
    },
    success_url: SUCCESS_URL,
    cancel_url: "https://saas.example/pricing",
  });
  expect(session).toMatchObject({ object: "checkout.session", mode: "subscription", status: "open" });
  expect(session.id).toMatch(/^cs_test_/);
  expect(session.subscription).toBeNull();
  const from = s.receiver.events.length;
  await payOnCheckoutPage(s, session, card);
  const done = await s.stripe.checkout.sessions.retrieve(session.id, { expand: ["subscription"] });
  return {
    customer,
    session: done,
    subscription: done.subscription as Stripe.Subscription,
    sent: s.receiver.since(from),
  };
}

/** A subscription created through the API for a clock customer whose default card is `card`. */
async function subscribe(s: Saas, card: string, items?: Stripe.SubscriptionCreateParams.Item[]) {
  const customer = await clockCustomer(s, card);
  const subscription = await s.stripe.subscriptions.create({
    customer: customer.id,
    items: items ?? [{ price: s.flat.id }],
    expand: ["latest_invoice"],
  });
  return { customer, subscription };
}

async function latestInvoice(s: Saas, subscriptionId: string) {
  const sub = await s.stripe.subscriptions.retrieve(subscriptionId, { expand: ["latest_invoice"] });
  return { sub, invoice: sub.latest_invoice as Stripe.Invoice };
}

describe("SaaS billing scenarios over HTTP with a verifying webhook receiver", { timeout: 60_000 }, () => {
  it("1: subscription Checkout with a 7 day trial saves the card and starts a trialing subscription", async () => {
    const s = await saas();
    const { customer, session, subscription, sent } = await checkoutTrial(s, "pm_card_visa");

    expect(session).toMatchObject({
      status: "complete",
      payment_status: "paid",
      customer: customer.id,
      payment_method_collection: "always",
      setup_intent: null,
      payment_intent: null,
    });
    expect(subscription.id).toMatch(/^sub_/);
    expect(subscription).toMatchObject({
      object: "subscription",
      status: "trialing",
      customer: customer.id,
      trial_start: T,
      trial_end: TRIAL_END,
      collection_method: "charge_automatically",
      cancel_at_period_end: false,
      test_clock: s.clock.id,
      livemode: false,
    });
    expect(subscription.trial_settings?.end_behavior.missing_payment_method).toBe("create_invoice");
    expect(subscription.default_payment_method).toMatch(/^pm_/);
    const [flatItem, meteredItem] = subscription.items.data;
    expect(flatItem.id).toMatch(/^si_/);
    expect(flatItem).toMatchObject({
      object: "subscription_item",
      quantity: 1,
      current_period_start: T,
      current_period_end: TRIAL_END,
      price: { id: s.flat.id },
    });
    expect(meteredItem).toMatchObject({ price: { id: s.metered.id }, current_period_end: TRIAL_END });
    expect(meteredItem).not.toHaveProperty("quantity");

    // The card is saved off-session through a SetupIntent, then the subscription and its $0
    // trial invoice are created, and checkout.session.completed arrives last.
    expectInOrder(sent, [
      "setup_intent.created",
      "setup_intent.succeeded",
      "customer.subscription.created",
      "invoice.created",
      "invoice.finalized",
      "invoice.paid",
      "checkout.session.completed",
    ]);
    expect(typesOf(sent)).toContain("payment_method.attached");
    expect(typesOf(sent)).not.toContain("payment_intent.created");
    expect(sent.at(-1)?.type).toBe("checkout.session.completed");

    const created = s.receiver.ofType("customer.subscription.created")[0];
    expect(obj(created)).toMatchObject({ id: subscription.id, status: "trialing", trial_end: TRIAL_END });
    const completed = s.receiver.ofType("checkout.session.completed")[0];
    expect(obj(completed)).toMatchObject({
      id: session.id,
      mode: "subscription",
      status: "complete",
      payment_status: "paid",
      subscription: subscription.id,
      customer: customer.id,
    });
    // The hosted page caused these, not an API request.
    expect(completed.request).toEqual({ id: null, idempotency_key: null });

    const trialInvoice = await s.stripe.invoices.retrieve(session.invoice as string);
    expect(trialInvoice.id).toMatch(/^in_/);
    expect(trialInvoice).toMatchObject({
      billing_reason: "subscription_create",
      status: "paid",
      amount_due: 0,
      total: 0,
      customer: customer.id,
    });
    expect(trialInvoice.parent?.subscription_details?.subscription).toBe(subscription.id);
    expect(subscription.latest_invoice).toBe(trialInvoice.id);
  });

  it("2: customer.subscription.trial_will_end arrives three days before the trial ends", async () => {
    const s = await saas();
    const { subscription } = await checkoutTrial(s, "pm_card_visa");
    expect(s.receiver.ofType("customer.subscription.trial_will_end")).toHaveLength(0);

    const before = await advance(s, TRIAL_END - 3 * DAY - 60);
    expect(typesOf(before)).not.toContain("customer.subscription.trial_will_end");

    const sent = await advance(s, TRIAL_END - 3 * DAY + 60);
    const warnings = sent.filter((e) => e.type === "customer.subscription.trial_will_end");
    expect(warnings).toHaveLength(1);
    expect(obj(warnings[0])).toMatchObject({
      id: subscription.id,
      object: "subscription",
      status: "trialing",
      trial_end: TRIAL_END,
    });
    expect(warnings[0].created).toBe(TRIAL_END - 3 * DAY);
    expect(warnings[0].request).toEqual({ id: null, idempotency_key: null });

    const later = await advance(s, TRIAL_END - 60);
    expect(typesOf(later)).not.toContain("customer.subscription.trial_will_end");
    expect((await s.stripe.subscriptions.retrieve(subscription.id)).status).toBe("trialing");
    expect(s.receiver.ofType("customer.subscription.trial_will_end")).toHaveLength(1);
  });

  it("3: the trial ends with a good card: invoice created, finalized an hour later and paid; active", async () => {
    const s = await saas();
    const { customer, subscription } = await checkoutTrial(s, "pm_card_visa");

    // At the trial end the subscription turns active and its first real invoice is a draft.
    const atEnd = await advance(s, TRIAL_END + 60);
    expectInOrder(atEnd, ["customer.subscription.updated", "invoice.created"]);
    expect(typesOf(atEnd)).not.toContain("invoice.finalized");
    const activated = statusChange(atEnd, "active")!;
    expect(activated).toBeDefined();
    expect(previous(activated).status).toBe("trialing");
    expect(activated.created).toBe(TRIAL_END);
    const draft = obj(atEnd.find((e) => e.type === "invoice.created")!);
    expect(draft).toMatchObject({ status: "draft", billing_reason: "subscription_cycle", amount_due: 2900 });
    expect(draft.automatically_finalizes_at).toBe(TRIAL_END + HOUR);

    // An hour later Billing finalizes it and charges the saved card off-session.
    const collected = await advance(s, TRIAL_END + HOUR + 60);
    expectInOrder(collected, ["invoice.finalized", "invoice.paid"]);
    expect(typesOf(collected)).toContain("invoice.payment_succeeded");
    expect(typesOf(collected)).toContain("payment_intent.succeeded");
    expect(typesOf(collected)).not.toContain("invoice.payment_failed");
    const paid = obj(collected.find((e) => e.type === "invoice.paid")!);
    expect(paid).toMatchObject({
      id: draft.id,
      status: "paid",
      amount_paid: 2900,
      attempt_count: 1,
      customer: customer.id,
      billing_reason: "subscription_cycle",
    });
    expect(paid.parent.subscription_details.subscription).toBe(subscription.id);

    const { sub, invoice } = await latestInvoice(s, subscription.id);
    expect(sub.status).toBe("active");
    expect(invoice.id).toBe(draft.id);
    expect(sub.items.data[0]).toMatchObject({
      current_period_start: TRIAL_END,
      current_period_end: TRIAL_END + 31 * DAY,
    });
  });

  it("4: a card that declines later goes past_due, is retried on the schedule, then canceled", async () => {
    const s = await saas();
    // 4000000000000341 attaches fine and declines every charge.
    const { customer, subscription } = await checkoutTrial(s, "pm_card_chargeCustomerFail");
    expect(subscription.status).toBe("trialing");

    const firstAttempt = TRIAL_END + HOUR;
    const sent = await advance(s, firstAttempt);
    expectInOrder(sent, ["invoice.created", "invoice.finalized", "invoice.payment_failed"]);
    expect(typesOf(sent)).toContain("payment_intent.payment_failed");
    expect(typesOf(sent)).not.toContain("invoice.paid");
    const failed = obj(sent.find((e) => e.type === "invoice.payment_failed")!);
    expect(failed).toMatchObject({ status: "open", attempt_count: 1, next_payment_attempt: firstAttempt + 3 * DAY });
    expect(previous(statusChange(sent, "past_due")!).status).toBe("active");
    expect((await s.stripe.subscriptions.retrieve(subscription.id)).status).toBe("past_due");
    expect(((await s.stripe.customers.retrieve(customer.id)) as Stripe.Customer).delinquent).toBe(true);

    // The documented default schedule: retries 3, 5 and 7 days after the previous attempt.
    const attempts: Array<[number, number | null]> = [];
    for (const at of [firstAttempt + 3 * DAY, firstAttempt + 8 * DAY, firstAttempt + 15 * DAY]) {
      const retry = await advance(s, at);
      for (const e of retry.filter((x) => x.type === "invoice.payment_failed")) {
        attempts.push([obj(e).attempt_count, obj(e).next_payment_attempt]);
      }
      if (at === firstAttempt + 15 * DAY) {
        expectInOrder(retry, ["invoice.payment_failed", "customer.subscription.deleted"]);
        const deleted = obj(retry.find((e) => e.type === "customer.subscription.deleted")!);
        expect(deleted).toMatchObject({ id: subscription.id, status: "canceled", ended_at: at });
      } else {
        expect(typesOf(retry)).not.toContain("customer.subscription.deleted");
      }
    }
    expect(attempts).toEqual([
      [2, firstAttempt + 8 * DAY],
      [3, firstAttempt + 15 * DAY],
      [4, null],
    ]);
    expect(await s.stripe.subscriptions.retrieve(subscription.id)).toMatchObject({
      status: "canceled",
      cancellation_details: { reason: "payment_failed" },
    });
  });

  it("4: a renewal that declines ends unpaid when the retry policy says so", async () => {
    const s = await saas();
    const policy = await s.control("POST", "/_stripe/billing/settings", {
      retry_schedule_days: [2, 4],
      after_retries: { subscription: "unpaid", invoice: "uncollectible" },
    });
    expect(policy.status).toBe(200);
    const { customer, subscription } = await subscribe(s, "pm_card_visa");
    expect(subscription.status).toBe("active");
    // The card starts declining after the first month, as real cards do.
    const card = (customer.invoice_settings.default_payment_method as string) ?? "";
    expect(card).toMatch(/^pm_/);
    expect((await s.control("POST", `/_stripe/simulate/payment_methods/${card}`, { behavior: "decline" })).status).toBe(
      200,
    );

    const renewal = await advance(s, FEB_15 + HOUR);
    expectInOrder(renewal, ["invoice.created", "invoice.finalized", "invoice.payment_failed"]);
    expect(statusChange(renewal, "past_due")).toBeDefined();
    await advance(s, FEB_15 + HOUR + 2 * DAY);
    const last = await advance(s, FEB_15 + HOUR + 6 * DAY);
    expectInOrder(last, ["invoice.payment_failed", "invoice.marked_uncollectible"]);
    expect(previous(statusChange(last, "unpaid")!).status).toBe("past_due");
    const { sub, invoice } = await latestInvoice(s, subscription.id);
    expect(sub.status).toBe("unpaid");
    expect(invoice).toMatchObject({ status: "uncollectible", attempt_count: 3, next_payment_attempt: null });
  });

  it("5: a new default card and paying the open invoice make a past_due subscription active again", async () => {
    const s = await saas();
    const { customer, subscription } = await checkoutTrial(s, "pm_card_chargeCustomerFail");
    await advance(s, TRIAL_END + HOUR);
    const { sub: pastDue, invoice: open } = await latestInvoice(s, subscription.id);
    expect(pastDue.status).toBe("past_due");
    expect(open.status).toBe("open");

    const from = s.receiver.events.length;
    const card = await s.stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id });
    expect(card).toMatchObject({ object: "payment_method", customer: customer.id, card: { last4: "4242" } });
    await s.stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: card.id } });
    // Checkout made its card the subscription's default, which outranks the customer's.
    await s.stripe.subscriptions.update(subscription.id, { default_payment_method: card.id });
    const paid = await s.stripe.invoices.pay(open.id!);
    expect(paid).toMatchObject({ status: "paid", amount_paid: 2900, amount_remaining: 0, next_payment_attempt: null });

    const sent = s.receiver.since(from);
    expectInOrder(sent, ["payment_method.attached", "customer.updated", "invoice.paid"]);
    expect(typesOf(sent)).toContain("invoice.payment_succeeded");
    const reactivated = statusChange(sent, "active")!;
    expect(previous(reactivated).status).toBe("past_due");
    expect(reactivated.request?.id).toMatch(/^req_/);
    expect((await s.stripe.subscriptions.retrieve(subscription.id)).status).toBe("active");
    expect(((await s.stripe.customers.retrieve(customer.id)) as Stripe.Customer).delinquent).toBe(false);

    // The paid invoice is not retried.
    const later = await advance(s, TRIAL_END + HOUR + 4 * DAY);
    expect(typesOf(later)).not.toContain("invoice.payment_failed");
  });

  it("6: cancel_at_period_end cancels at the period end; DELETE cancels at once", async () => {
    const s = await saas();
    const { subscription } = await subscribe(s, "pm_card_visa");
    expect(subscription.items.data[0]).toMatchObject({ current_period_start: T, current_period_end: FEB_15 });

    const from = s.receiver.events.length;
    const scheduled = await s.stripe.subscriptions.update(subscription.id, { cancel_at_period_end: true });
    expect(scheduled).toMatchObject({ status: "active", cancel_at_period_end: true, cancel_at: FEB_15 });
    const update = s.receiver.since(from).find((e) => e.type === "customer.subscription.updated")!;
    expect(previous(update)).toMatchObject({ cancel_at_period_end: false, cancel_at: null });

    const mid = await advance(s, FEB_15 - DAY);
    expect(typesOf(mid)).not.toContain("customer.subscription.deleted");
    const atEnd = await advance(s, FEB_15 + HOUR);
    expect(typesOf(atEnd)).not.toContain("invoice.created");
    const deleted = atEnd.find((e) => e.type === "customer.subscription.deleted")!;
    expect(obj(deleted)).toMatchObject({ id: subscription.id, status: "canceled", ended_at: FEB_15 });
    expect(deleted.created).toBe(FEB_15);

    const other = await subscribe(s, "pm_card_visa");
    const before = s.receiver.events.length;
    const canceled = await s.stripe.subscriptions.cancel(other.subscription.id);
    expect(canceled).toMatchObject({
      status: "canceled",
      canceled_at: FEB_15 + HOUR,
      ended_at: FEB_15 + HOUR,
      cancellation_details: { reason: "cancellation_requested" },
    });
    expect(typesOf(s.receiver.since(before))).toEqual(["customer.subscription.deleted"]);
    await expect(
      s.stripe.subscriptions.update(other.subscription.id, { cancel_at_period_end: false }),
    ).rejects.toBeInstanceOf(Stripe.errors.StripeInvalidRequestError);
  });

  it("6: ending a metered subscription bills the usage of its last period", async () => {
    const s = await saas();
    const items = [{ price: s.flat.id }, { price: s.metered.id }];
    const usage = (customer: string, value: number) =>
      s.stripe.billing.meterEvents.create({
        event_name: "api_requests",
        payload: { stripe_customer_id: customer, value: String(value) },
      });

    // At the period end the subscription ends, and the usage it ran up is invoiced in arrears.
    const scheduled = await subscribe(s, "pm_card_visa", items);
    await usage(scheduled.customer.id, 1400);
    await s.stripe.subscriptions.update(scheduled.subscription.id, { cancel_at_period_end: true });
    const atEnd = await advance(s, FEB_15 + 60);
    expectInOrder(atEnd, ["customer.subscription.deleted", "invoice.created"]);
    const final = obj(atEnd.find((e) => e.type === "invoice.created")!);
    expect(final).toMatchObject({
      status: "draft",
      billing_reason: "subscription_cycle",
      amount_due: 400 * 3,
      period_start: T,
      period_end: FEB_15,
    });
    expect(final.parent.subscription_details.subscription).toBe(scheduled.subscription.id);
    expect(final.lines.data.map((line: Json) => [line.quantity, line.amount])).toEqual([
      [1000, 0],
      [400, 1200],
    ]);
    const collected = await advance(s, FEB_15 + HOUR + 60);
    expectInOrder(collected, ["invoice.finalized", "invoice.paid"]);
    expect(await s.stripe.invoices.retrieve(final.id)).toMatchObject({ status: "paid", amount_paid: 1200 });
    const ended = await s.stripe.subscriptions.retrieve(scheduled.subscription.id);
    expect(ended).toMatchObject({ status: "canceled", latest_invoice: final.id });

    // DELETE with invoice_now bills the usage so far at once; without it the usage is dropped.
    const start = FEB_15 + HOUR + 60;
    const now = start + DAY;
    const billed = await subscribe(s, "pm_card_visa", items);
    const dropped = await subscribe(s, "pm_card_visa", items);
    await usage(billed.customer.id, 1100);
    await usage(dropped.customer.id, 1100);
    await advance(s, now);
    const from = s.receiver.events.length;
    const canceled = await s.stripe.subscriptions.cancel(billed.subscription.id, { invoice_now: true });
    expect(canceled.status).toBe("canceled");
    const sent = s.receiver.since(from);
    expectInOrder(sent, ["customer.subscription.deleted", "invoice.created", "invoice.finalized", "invoice.paid"]);
    const immediate = await s.stripe.invoices.retrieve(canceled.latest_invoice as string);
    expect(immediate).toMatchObject({
      status: "paid",
      billing_reason: "subscription_update",
      amount_paid: 100 * 3,
      period_start: start,
      period_end: now,
    });
    expect(immediate.lines.data.map((line) => [line.quantity, line.amount, line.period])).toEqual([
      [1000, 0, { start, end: now }],
      [100, 300, { start, end: now }],
    ]);

    const before = s.receiver.events.length;
    const plain = await s.stripe.subscriptions.cancel(dropped.subscription.id);
    expect(typesOf(s.receiver.since(before))).toEqual(["customer.subscription.deleted"]);
    expect(plain.latest_invoice).toBe((dropped.subscription.latest_invoice as Stripe.Invoice).id);
  });

  it("7: monthly renewals on the test clock bill once per period and move the item periods", async () => {
    const s = await saas();
    const { subscription } = await subscribe(s, "pm_card_visa");

    // Stripe caps one advance at two intervals of the shortest subscription on the clock.
    const tooFar = await s.stripe.testHelpers.testClocks
      .advance(s.clock.id, { frozen_time: MAR_15 + 20 * DAY })
      .catch((e: unknown) => e);
    expect(tooFar).toBeInstanceOf(Stripe.errors.StripeInvalidRequestError);
    expect((tooFar as Stripe.errors.StripeError).param).toBe("frozen_time");

    const upcoming = await advance(s, FEB_15 - 2 * DAY);
    expect(typesOf(upcoming)).toContain("invoice.upcoming");

    const periods: Array<[number, number]> = [];
    for (const at of [FEB_15 + HOUR, MAR_15 + HOUR, APR_15 + HOUR]) {
      const sent = await advance(s, at);
      expectInOrder(sent, ["customer.subscription.updated", "invoice.created", "invoice.finalized", "invoice.paid"]);
      expect(sent.filter((e) => e.type === "invoice.paid")).toHaveLength(1);
      const item = (await s.stripe.subscriptions.retrieve(subscription.id)).items.data[0];
      periods.push([item.current_period_start, item.current_period_end]);
    }
    const MAY_15 = Math.floor(Date.UTC(2026, 4, 15, 12, 0, 0) / 1000);
    expect(periods).toEqual([
      [FEB_15, MAR_15],
      [MAR_15, APR_15],
      [APR_15, MAY_15],
    ]);

    const invoices = await s.stripe.invoices.list({ subscription: subscription.id, limit: 10 });
    const ordered = [...invoices.data].reverse();
    expect(ordered.map((i) => [i.billing_reason, i.status, i.amount_paid])).toEqual([
      ["subscription_create", "paid", 2900],
      ["subscription_cycle", "paid", 2900],
      ["subscription_cycle", "paid", 2900],
      ["subscription_cycle", "paid", 2900],
    ]);
    expect(ordered.map((i) => i.lines.data[0].period)).toEqual([
      { start: T, end: FEB_15 },
      { start: FEB_15, end: MAR_15 },
      { start: MAR_15, end: APR_15 },
      { start: APR_15, end: MAY_15 },
    ]);
    expect((await s.stripe.subscriptions.retrieve(subscription.id)).status).toBe("active");
  });

  it("8: meter events dedupe on identifier, sum per customer and bill a free first tier", async () => {
    const s = await saas();
    const items = [{ price: s.flat.id }, { price: s.metered.id }];
    const a = await subscribe(s, "pm_card_visa", items);
    const b = await subscribe(s, "pm_card_mastercard", items);
    const report = (customer: string, value: number, identifier: string) =>
      s.stripe.billing.meterEvents.create({
        event_name: "api_requests",
        identifier,
        payload: { stripe_customer_id: customer, value: String(value) },
      });

    const recorded = await report(a.customer.id, 700, "req-a-1");
    expect(recorded).toMatchObject({
      object: "billing.meter_event",
      event_name: "api_requests",
      identifier: "req-a-1",
      timestamp: T,
      payload: { stripe_customer_id: a.customer.id, value: "700" },
    });
    await report(a.customer.id, 800, "req-a-2");
    // A retry with the same identifier within 24 hours is rejected, so it is not counted twice.
    const retried = await report(a.customer.id, 700, "req-a-1").catch((e: unknown) => e);
    expect(retried).toBeInstanceOf(Stripe.errors.StripeInvalidRequestError);
    expect((retried as Stripe.errors.StripeError).code).toBe("duplicate_meter_event");
    await report(b.customer.id, 4000, "req-b-1");
    await advance(s, T + 10 * DAY);
    await report(b.customer.id, 500, "req-b-2");

    const summary = await s.stripe.billing.meters.listEventSummaries(s.meter.id, {
      customer: a.customer.id,
      start_time: T,
      end_time: FEB_15,
    });
    expect(summary.data.map((x) => [x.object, x.aggregated_value])).toEqual([["billing.meter_event_summary", 1500]]);

    await advance(s, FEB_15 + HOUR);
    const meteredLines = (invoice: Stripe.Invoice) =>
      invoice.lines.data
        .filter((line) => line.pricing?.price_details?.price === s.metered.id)
        .map((line) => [line.quantity, line.amount]);
    const invoiceA = (await latestInvoice(s, a.subscription.id)).invoice;
    const invoiceB = (await latestInvoice(s, b.subscription.id)).invoice;
    // 1500 units: 1000 free, 500 at 3 cents. 4500 units: 1000 free, 3500 at 3 cents.
    expect(meteredLines(invoiceA)).toEqual([
      [1000, 0],
      [500, 1500],
    ]);
    expect(meteredLines(invoiceB)).toEqual([
      [1000, 0],
      [3500, 10500],
    ]);
    expect(invoiceA).toMatchObject({ billing_reason: "subscription_cycle", status: "paid", amount_paid: 2900 + 1500 });
    expect(invoiceB).toMatchObject({ status: "paid", amount_paid: 2900 + 10500 });
    const usage = invoiceA.lines.data.find((line) => line.pricing?.price_details?.price === s.metered.id)!;
    // Metered usage is billed in arrears for the period that just ended.
    expect(usage.period).toEqual({ start: T, end: FEB_15 });
  });

  it("9: a card that always asks for 3D Secure leaves the renewal on requires_action until the customer pays", async () => {
    const s = await saas();
    // 4000002760003184 asks for authentication on every charge, off-session ones included.
    const { subscription } = await checkoutTrial(s, "pm_card_authenticationRequired");
    expect(subscription.status).toBe("trialing");

    const sent = await advance(s, TRIAL_END + HOUR);
    expectInOrder(sent, ["invoice.finalized", "payment_intent.requires_action", "invoice.payment_action_required"]);
    expect(typesOf(sent)).not.toContain("invoice.paid");
    const intent = obj(sent.find((e) => e.type === "payment_intent.requires_action")!);
    expect(intent.id).toMatch(/^pi_/);
    expect(intent).toMatchObject({ object: "payment_intent", status: "requires_action", amount: 2900 });
    expect(intent.next_action.type).toBe("use_stripe_sdk");
    const action = obj(sent.find((e) => e.type === "invoice.payment_action_required")!);
    expect(action).toMatchObject({ status: "open", amount_remaining: 2900 });
    expect(action.hosted_invoice_url).toBeTruthy();
    expect((await s.stripe.paymentIntents.retrieve(intent.id)).status).toBe("requires_action");
    const { sub } = await latestInvoice(s, subscription.id);
    expect(sub.status).toBe("past_due");

    // The customer opens the hosted invoice page and pays, passing 3D Secure there.
    const from = s.receiver.events.length;
    const page = await fetch(`${action.hosted_invoice_url}/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ payment_method: "pm_card_authenticationRequired" }).toString(),
      redirect: "manual",
    });
    expect(page.status, await page.clone().text()).toBe(303);
    const recovered = s.receiver.since(from);
    expectInOrder(recovered, ["invoice.paid"]);
    expect(previous(statusChange(recovered, "active")!).status).toBe("past_due");
    expect((await s.stripe.invoices.retrieve(action.id)).status).toBe("paid");

    // Subscribing without a trial: the first invoice waits on authentication, subscription incomplete.
    const direct = await subscribe(s, "pm_card_authenticationRequired");
    expect(direct.subscription.status).toBe("incomplete");
    const first = direct.subscription.latest_invoice as Stripe.Invoice;
    expect(first).toMatchObject({ status: "open" });
    expect(s.receiver.ofType("invoice.payment_action_required").map((e) => obj(e).id)).toContain(first.id);
  });

  it("10: deliveries are real Event objects that verify with stripe.webhooks.constructEvent", async () => {
    const s = await saas();
    const customer = await s.stripe.customers.create(
      { email: "envelope@saas.example" },
      { idempotencyKey: "signup-7" },
    );
    const delivery = s.receiver.deliveries.find((d) => d.event.type === "customer.created")!;
    expect(delivery.signature).toMatch(/^t=\d+,v1=[0-9a-f]{64}/);
    const event = delivery.event;
    expect(Object.keys(event).sort()).toEqual(
      ["api_version", "created", "data", "id", "livemode", "object", "pending_webhooks", "request", "type"].sort(),
    );
    expect(event.id).toMatch(/^evt_/);
    expect(event).toMatchObject({
      object: "event",
      api_version: Stripe.API_VERSION,
      livemode: false,
      pending_webhooks: 1,
      type: "customer.created",
      request: { idempotency_key: "signup-7" },
    });
    expect(event.request?.id).toMatch(/^req_/);
    expect(Number.isInteger(event.created)).toBe(true);
    expect(obj(event)).toMatchObject({ id: customer.id, object: "customer", email: "envelope@saas.example" });

    // A wrong secret or a tampered body fails verification.
    expect(() => verifier.webhooks.constructEvent(delivery.raw, delivery.signature, "whsec_wrong")).toThrow(
      Stripe.errors.StripeSignatureVerificationError,
    );
    expect(() =>
      verifier.webhooks.constructEvent(
        delivery.raw.replace("envelope", "attacker"),
        delivery.signature,
        s.receiver.secret!,
      ),
    ).toThrow(Stripe.errors.StripeSignatureVerificationError);

    // The stored event matches the delivery; once acknowledged nothing is pending.
    const stored = await s.stripe.events.retrieve(event.id);
    expect(stored.data).toEqual(event.data);
    expect(stored.pending_webhooks).toBe(0);
    const listed = await s.stripe.events.list({ type: "customer.created" });
    expect(listed.data.map((e) => e.id)).toContain(event.id);

    await s.stripe.customers.update(customer.id, { name: "Ada" });
    const change = s.receiver.ofType("customer.updated").at(-1)!;
    expect(change.data.previous_attributes).toEqual({ name: null });

    // Billing events raised by the clock carry an all-null request and the simulated time.
    const sub = await s.stripe.subscriptions.create({
      customer: (await clockCustomer(s, "pm_card_visa")).id,
      items: [{ price: s.flat.id }],
    });
    const renewal = await advance(s, FEB_15 + HOUR);
    const paid = renewal.find((e) => e.type === "invoice.paid")!;
    expect(paid.request).toEqual({ id: null, idempotency_key: null });
    expect(obj(paid).parent.subscription_details.subscription).toBe(sub.id);
    for (const e of s.receiver.events) {
      expect(e).toMatchObject({ object: "event", livemode: false, api_version: Stripe.API_VERSION });
      expect(e.id).toMatch(/^evt_/);
    }
  });

  it("11: chaos duplicates, reorders, delays and drops deliveries", async () => {
    const s = await saas();
    const customer = await clockCustomer(s, "pm_card_visa");
    const chaos = await s.control("POST", "/_stripe/webhooks/chaos", {
      seed: 11,
      duplicate: { types: ["invoice.paid"], count: 2 },
      delay: { types: ["customer.subscription.created"] },
      drop: { types: ["invoice.finalized"] },
      reorder: "reverse",
    });
    expect(chaos.status).toBe(200);
    expect(chaos.body).toMatchObject({ enabled: true, seed: 11, reorder: "reverse" });

    const from = s.receiver.events.length;
    const subscription = await s.stripe.subscriptions.create({ customer: customer.id, items: [{ price: s.flat.id }] });
    expect(subscription.status).toBe("active");
    const sent = s.receiver.since(from);
    // Duplicates are the same event, so a consumer can dedupe on event.id.
    const paid = sent.filter((e) => e.type === "invoice.paid");
    expect(paid).toHaveLength(3);
    expect(new Set(paid.map((e) => e.id)).size).toBe(1);
    // Delayed and dropped events are not delivered yet.
    expect(typesOf(sent)).not.toContain("customer.subscription.created");
    expect(typesOf(sent)).not.toContain("invoice.finalized");
    // Reversed: the invoice is reported paid before it is reported created.
    expect(typesOf(sent).indexOf("invoice.paid")).toBeLessThan(typesOf(sent).indexOf("invoice.created"));

    const log = await s.control("GET", "/_stripe/webhooks/deliveries?status=dropped");
    const dropped = (log.body.data as Json[]).find((d) => d.type === "invoice.finalized")!;
    expect(dropped.event_id).toMatch(/^evt_/);

    // The delayed event arrives when the test flushes the outbox.
    const flushed = await s.control("POST", "/_stripe/webhooks/flush", {});
    expect(flushed.status).toBe(200);
    expect(flushed.body.remaining).toBe(0);
    expect(s.receiver.events.at(-1)?.type).toBe("customer.subscription.created");
    expect(obj(s.receiver.events.at(-1)!).id).toBe(subscription.id);

    // A dropped event can be redelivered by id.
    const redelivered = await s.control("POST", `/_stripe/events/${dropped.event_id}/redeliver`);
    expect(redelivered.status).toBe(200);
    expect(s.receiver.events.at(-1)).toMatchObject({ id: dropped.event_id, type: "invoice.finalized" });

    // An endpoint that answers 500 leaves the event pending until it is redelivered.
    await s.control("DELETE", "/_stripe/webhooks/chaos");
    s.receiver.status = (event) => (event.type === "customer.updated" ? 500 : 200);
    await s.stripe.customers.update(customer.id, { name: "Flaky" });
    const failedOnce = s.receiver.ofType("customer.updated").at(-1)!;
    expect((await s.stripe.events.retrieve(failedOnce.id)).pending_webhooks).toBe(1);
    s.receiver.status = () => 200;
    expect((await s.control("POST", `/_stripe/events/${failedOnce.id}/redeliver`)).status).toBe(200);
    expect((await s.stripe.events.retrieve(failedOnce.id)).pending_webhooks).toBe(0);
  });

  it("12: a billing portal session returns a URL that serves the portal", async () => {
    const s = await saas();
    const { customer, subscription } = await subscribe(s, "pm_card_visa");
    const portal = await s.stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url: "https://saas.example/account",
    });
    expect(portal.id).toMatch(/^bps_/);
    expect(portal).toMatchObject({
      object: "billing_portal.session",
      customer: customer.id,
      livemode: false,
      return_url: "https://saas.example/account",
      url: `${s.baseUrl}/billing_portal/${portal.id}`,
    });
    expect(portal.configuration).toMatch(/^bpc_/);
    const page = await fetch(portal.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(subscription.id);
  });

  it("13: if_required with no card and missing_payment_method=cancel cancels at the trial end", async () => {
    const s = await saas();
    const { session, subscription, sent } = await checkoutTrial(s, "none", {
      collection: "if_required",
      missing: "cancel",
    });
    expect(session).toMatchObject({ status: "complete", payment_method_collection: "if_required" });
    expect(subscription).toMatchObject({ status: "trialing", default_payment_method: null });
    expect(subscription.trial_settings?.end_behavior.missing_payment_method).toBe("cancel");
    expect(typesOf(sent)).not.toContain("setup_intent.created");
    expect(typesOf(sent)).not.toContain("payment_method.attached");

    const atEnd = await advance(s, TRIAL_END + HOUR);
    expect(typesOf(atEnd)).not.toContain("invoice.created");
    const deleted = obj(atEnd.find((e) => e.type === "customer.subscription.deleted")!);
    expect(deleted).toMatchObject({ id: subscription.id, status: "canceled", ended_at: TRIAL_END });
    expect(deleted.cancellation_details.reason).toBe("cancellation_requested");
  });

  it("13: if_required with no card and missing_payment_method=pause pauses at the trial end", async () => {
    const s = await saas();
    const { customer, subscription } = await checkoutTrial(s, "none", { collection: "if_required", missing: "pause" });

    const atEnd = await advance(s, TRIAL_END + HOUR);
    expect(typesOf(atEnd)).not.toContain("invoice.created");
    expectInOrder(atEnd, ["customer.subscription.updated", "customer.subscription.paused"]);
    expect(previous(statusChange(atEnd, "paused")!).status).toBe("trialing");
    const paused = await s.stripe.subscriptions.retrieve(subscription.id);
    expect(paused.status).toBe("paused");
    expect(typesOf(await advance(s, TRIAL_END + 40 * DAY))).not.toContain("invoice.created");

    // Adding a card and resuming with resume_on_payment_success charges a fresh period at once.
    const card = await s.stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id });
    await s.stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: card.id } });
    const from = s.receiver.events.length;
    const resumed = await s.stripe.subscriptions.resume(subscription.id, {
      billing_cycle_anchor: { type: "now" },
      payment_behavior: "resume_on_payment_success",
    });
    expect(resumed.status).toBe("active");
    expectInOrder(s.receiver.since(from), ["customer.subscription.resumed"]);
    expect(typesOf(s.receiver.since(from))).toContain("invoice.paid");
  });

  it("13: if_required with no card and missing_payment_method=create_invoice invoices and goes past_due", async () => {
    const s = await saas();
    const { subscription } = await checkoutTrial(s, "none", { collection: "if_required", missing: "create_invoice" });

    const atEnd = await advance(s, TRIAL_END + HOUR);
    expectInOrder(atEnd, [
      "customer.subscription.updated",
      "invoice.created",
      "invoice.finalized",
      "invoice.payment_failed",
    ]);
    const { sub, invoice } = await latestInvoice(s, subscription.id);
    expect(sub.status).toBe("past_due");
    expect(invoice).toMatchObject({
      status: "open",
      billing_reason: "subscription_cycle",
      attempt_count: 1,
      next_payment_attempt: TRIAL_END + HOUR + 3 * DAY,
    });
  });
});
