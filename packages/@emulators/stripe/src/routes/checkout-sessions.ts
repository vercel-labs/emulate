import type { RouteContext, CheckoutLineItem } from "@emulators/core";
import { renderCardPage, renderCheckoutPage, escapeHtml } from "@emulators/core";
import { getStripeStore, type StripeStore } from "../store.js";
import { stripeId, toUnixTimestamp, parseStripeBody, stripeError, stripeList } from "../helpers.js";
import type { StripeCheckoutSession, StripePrice, StripeProduct } from "../entities.js";
import { formatSubscription } from "./subscriptions.js";

const SERVICE_LABEL = "Stripe";

function formatProduct(product: StripeProduct) {
  return {
    id: product.stripe_id,
    object: "product",
    name: product.name,
    description: product.description,
    active: product.active,
    metadata: product.metadata,
    created: toUnixTimestamp(product.created_at),
    livemode: false,
  };
}

function formatPrice(price: StripePrice, ss: StripeStore) {
  const product = ss.products.findOneBy("stripe_id", price.product_id);
  return {
    id: price.stripe_id,
    object: "price",
    product: product ? formatProduct(product) : price.product_id,
    currency: price.currency,
    unit_amount: price.unit_amount,
    type: price.type,
    billing_scheme: price.billing_scheme,
    tax_behavior: price.tax_behavior,
    recurring: price.recurring,
    active: price.active,
    metadata: price.metadata,
    created: toUnixTimestamp(price.created_at),
    livemode: false,
  };
}

function sessionAmount(session: StripeCheckoutSession, ss: StripeStore): number {
  return session.line_items.reduce((sum, item) => {
    const price = ss.prices.findOneBy("stripe_id", item.price);
    return sum + (price?.unit_amount ?? 0) * item.quantity;
  }, 0);
}

function sessionCurrency(session: StripeCheckoutSession, ss: StripeStore): string {
  const first = session.line_items[0];
  return (first && ss.prices.findOneBy("stripe_id", first.price)?.currency) || "usd";
}

function formatSession(session: StripeCheckoutSession, baseUrl: string, ss: StripeStore) {
  const customer = session.customer_id ? ss.customers.findOneBy("stripe_id", session.customer_id) : undefined;
  const subscription = session.subscription_id
    ? ss.subscriptions.findOneBy("stripe_id", session.subscription_id)
    : undefined;
  const amount = sessionAmount(session, ss);
  const currency = sessionCurrency(session, ss);
  const paymentIntent = session.payment_intent_id
    ? {
        id: session.payment_intent_id,
        object: "payment_intent",
        amount,
        currency,
        customer: session.customer_id,
        status: "succeeded",
        livemode: false,
      }
    : null;
  const lineItems = session.line_items.map((item) => {
    const price = ss.prices.findOneBy("stripe_id", item.price);
    return {
      id: stripeId("li"),
      object: "item",
      amount_subtotal: (price?.unit_amount ?? 0) * item.quantity,
      amount_total: (price?.unit_amount ?? 0) * item.quantity,
      currency: price?.currency ?? currency,
      quantity: item.quantity,
      price: price ? formatPrice(price, ss) : item.price,
    };
  });
  return {
    id: session.stripe_id,
    object: "checkout.session",
    mode: session.mode,
    status: session.status,
    payment_status: session.payment_status,
    customer: customer
      ? {
          id: customer.stripe_id,
          object: "customer",
          email: customer.email,
          name: customer.name,
          livemode: false,
        }
      : null,
    customer_details: customer ? { email: customer.email, name: customer.name } : null,
    client_reference_id: session.client_reference_id,
    success_url: session.success_url,
    cancel_url: session.cancel_url,
    expires_at: session.expires_at,
    metadata: session.metadata,
    amount_subtotal: amount,
    amount_total: amount,
    currency,
    line_items: {
      object: "list",
      data: lineItems,
      has_more: false,
      url: `/v1/checkout/sessions/${session.stripe_id}/line_items`,
    },
    subscription: subscription
      ? {
          ...formatSubscription(subscription, ss),
          customer: customer
            ? {
                id: customer.stripe_id,
                object: "customer",
                email: customer.email,
                name: customer.name,
                livemode: false,
              }
            : subscription.customer_id,
          latest_invoice: {
            id: stripeId("in"),
            object: "invoice",
            payment_intent: paymentIntent,
            payments: {
              object: "list",
              data: paymentIntent
                ? [
                    {
                      object: "invoice_payment",
                      payment: {
                        type: "payment_intent",
                        payment_intent: paymentIntent.id,
                      },
                    },
                  ]
                : [],
            },
          },
        }
      : null,
    payment_intent: paymentIntent,
    created: toUnixTimestamp(session.created_at),
    livemode: false,
    url: session.status === "open" ? `${baseUrl}/checkout/${session.stripe_id}` : null,
  };
}

function stripeEvent(store: RouteContext["store"], type: string, object: Record<string, unknown>) {
  return {
    id: stripeId("evt"),
    object: "event",
    api_version: store.getData<string>("stripe.api_version") ?? "2026-06-24.preview",
    created: Math.floor(Date.now() / 1000),
    data: { object },
    livemode: false,
    pending_webhooks: 1,
    type,
  };
}

export function checkoutSessionRoutes({ app, store, webhooks, baseUrl }: RouteContext): void {
  const ss = getStripeStore(store);

  app.post("/v1/checkout/sessions", async (c) => {
    const body = await parseStripeBody(c);
    if (!body.mode) {
      return stripeError(c, 400, "invalid_request_error", "Missing required param: mode.", undefined, "mode");
    }
    if (body.customer && !ss.customers.findOneBy("stripe_id", body.customer as string)) {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        `No such customer: '${body.customer}'`,
        "resource_missing",
        "customer",
      );
    }

    const lineItems: Array<{ price: string; quantity: number }> = [];
    if (body.line_items) {
      if (!Array.isArray(body.line_items)) {
        return stripeError(c, 400, "invalid_request_error", "line_items must be an array.", undefined, "line_items");
      }
      for (let i = 0; i < body.line_items.length; i++) {
        const item = body.line_items[i] as Record<string, unknown>;
        if (!item?.price || typeof item.price !== "string") {
          return stripeError(
            c,
            400,
            "invalid_request_error",
            `Missing required param: line_items[${i}][price].`,
            undefined,
            `line_items[${i}][price]`,
          );
        }
        if (!ss.prices.findOneBy("stripe_id", item.price)) {
          return stripeError(
            c,
            400,
            "invalid_request_error",
            `No such price: '${item.price}'`,
            "resource_missing",
            `line_items[${i}][price]`,
          );
        }
        const quantity = typeof item.quantity === "number" ? item.quantity : Number(item.quantity ?? 1);
        if (!Number.isSafeInteger(quantity) || quantity < 1) {
          return stripeError(
            c,
            400,
            "invalid_request_error",
            `Invalid line_items[${i}][quantity]: must be a positive integer.`,
            undefined,
            `line_items[${i}][quantity]`,
          );
        }
        lineItems.push({ price: item.price, quantity });
      }
    }

    const session = ss.checkoutSessions.insert({
      stripe_id: stripeId("cs_test"),
      mode: body.mode as StripeCheckoutSession["mode"],
      status: "open",
      payment_status: "unpaid",
      customer_id: (body.customer as string) ?? null,
      client_reference_id: (body.client_reference_id as string) ?? null,
      success_url: (body.success_url as string) ?? null,
      cancel_url: (body.cancel_url as string) ?? null,
      expires_at: typeof body.expires_at === "number" ? body.expires_at : null,
      line_items: lineItems,
      metadata: (body.metadata as Record<string, string>) ?? {},
      subscription_id: null,
      payment_intent_id: null,
    });
    return c.json(formatSession(session, baseUrl, ss), 200);
  });

  app.get("/v1/checkout/sessions/:id", (c) => {
    const session = ss.checkoutSessions.findOneBy("stripe_id", c.req.param("id"));
    if (!session) {
      return stripeError(
        c,
        404,
        "invalid_request_error",
        `No such checkout session: '${c.req.param("id")}'`,
        "resource_missing",
      );
    }
    return c.json(formatSession(session, baseUrl, ss));
  });

  app.post("/v1/checkout/sessions/:id/expire", async (c) => {
    const session = ss.checkoutSessions.findOneBy("stripe_id", c.req.param("id"));
    if (!session) {
      return stripeError(
        c,
        404,
        "invalid_request_error",
        `No such checkout session: '${c.req.param("id")}'`,
        "resource_missing",
      );
    }
    if (session.status !== "open") {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        "Only open sessions can be expired.",
        "checkout_session_not_open",
      );
    }
    const updated = ss.checkoutSessions.update(session.id, { status: "expired" })!;
    const formatted = formatSession(updated, baseUrl, ss);
    await webhooks.dispatch(
      "checkout.session.expired",
      undefined,
      stripeEvent(store, "checkout.session.expired", formatted),
      "stripe",
    );
    return c.json(formatted);
  });

  app.get("/v1/checkout/sessions", (c) => {
    let items = ss.checkoutSessions.all();
    const customerId = c.req.query("customer");
    const status = c.req.query("status");
    const paymentStatus = c.req.query("payment_status");
    if (customerId) items = items.filter((session) => session.customer_id === customerId);
    if (status) items = items.filter((session) => session.status === status);
    if (paymentStatus) items = items.filter((session) => session.payment_status === paymentStatus);
    return stripeList(c, items, "/v1/checkout/sessions", (session) => formatSession(session, baseUrl, ss));
  });

  app.get("/checkout/:id", (c) => {
    const session = ss.checkoutSessions.findOneBy("stripe_id", c.req.param("id"));
    if (!session) {
      return c.html(
        renderCardPage(
          "Session Not Found",
          "This checkout session does not exist.",
          '<p class="empty">The session ID is invalid or has been removed.</p>',
          SERVICE_LABEL,
        ),
        404,
      );
    }
    if (session.status !== "open") {
      return c.html(
        renderCardPage(
          "Session Expired",
          "This checkout session is no longer available.",
          `<p class="empty">Status: ${escapeHtml(session.status)}</p>`,
          SERVICE_LABEL,
        ),
      );
    }

    const lineItems: CheckoutLineItem[] = session.line_items.map((item) => {
      const price = ss.prices.findOneBy("stripe_id", item.price);
      const product = price ? ss.products.findOneBy("stripe_id", price.product_id) : null;
      const unitPrice = price?.unit_amount ?? 0;
      return {
        name: product?.name ?? item.price,
        quantity: item.quantity,
        unitPrice,
        totalPrice: unitPrice * item.quantity,
        currency: price?.currency ?? "usd",
      };
    });
    const subtotal = lineItems.reduce((sum, item) => sum + item.totalPrice, 0);
    const currency = lineItems[0]?.currency ?? "usd";
    return c.html(
      renderCheckoutPage(
        {
          merchantName: "YapHaus",
          lineItems,
          subtotal,
          total: subtotal,
          currency,
          sessionId: session.stripe_id,
          cancelUrl: session.cancel_url,
        },
        SERVICE_LABEL,
      ),
    );
  });

  app.post("/checkout/:id/complete", async (c) => {
    const session = ss.checkoutSessions.findOneBy("stripe_id", c.req.param("id"));
    if (!session || session.status !== "open") {
      return c.redirect(`/checkout/${c.req.param("id")}`);
    }
    const submitted = await c.req.parseBody();
    const submittedEmail = typeof submitted.email === "string" ? submitted.email.trim().toLowerCase() : "";
    if (!submittedEmail || !submittedEmail.includes("@")) {
      return c.html(
        renderCardPage(
          "Email Required",
          "Enter a customer email address to complete this test checkout.",
          '<p class="empty">Payment was not completed.</p>',
          SERVICE_LABEL,
        ),
        422,
      );
    }
    const subscriptionLineItem = session.mode === "subscription" ? session.line_items[0] : null;
    if (session.mode === "subscription" && !subscriptionLineItem) {
      return c.html(
        renderCardPage(
          "Line Item Required",
          "A subscription checkout needs at least one line item.",
          '<p class="empty">Payment was not completed.</p>',
          SERVICE_LABEL,
        ),
        422,
      );
    }
    let customer = session.customer_id ? ss.customers.findOneBy("stripe_id", session.customer_id) : undefined;
    if (!customer) {
      customer = ss.customers.insert({
        stripe_id: stripeId("cus"),
        email: submittedEmail,
        name: "Test Customer",
        description: "Hosted checkout customer",
        metadata: {},
      });
    }
    let paymentIntentId: string | null = null;
    let subscriptionId: string | null = null;

    if (subscriptionLineItem) {
      paymentIntentId = stripeId("pi");
      const subscription = ss.subscriptions.insert({
        stripe_id: stripeId("sub"),
        customer_id: customer.stripe_id,
        price_id: subscriptionLineItem.price,
        quantity: subscriptionLineItem.quantity,
        status: "active",
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        cancel_at_period_end: false,
        metadata: { offer_intent_id: session.metadata.offer_intent_id ?? "" },
      });
      subscriptionId = subscription.stripe_id;
    } else if (session.mode === "payment") {
      const paymentIntent = ss.paymentIntents.insert({
        stripe_id: stripeId("pi"),
        amount: sessionAmount(session, ss),
        currency: sessionCurrency(session, ss),
        status: "succeeded",
        customer_id: customer.stripe_id,
        description: "Checkout session payment",
        payment_method: null,
        metadata: session.metadata,
      });
      paymentIntentId = paymentIntent.stripe_id;
    }

    const updated = ss.checkoutSessions.update(session.id, {
      status: "complete",
      payment_status: session.mode === "setup" ? "no_payment_required" : "paid",
      customer_id: customer.stripe_id,
      subscription_id: subscriptionId,
      payment_intent_id: paymentIntentId,
    })!;
    const formatted = formatSession(updated, baseUrl, ss);
    await webhooks.dispatch(
      "checkout.session.completed",
      undefined,
      stripeEvent(store, "checkout.session.completed", formatted),
      "stripe",
    );
    if (session.success_url) {
      return c.redirect(session.success_url.replace("{CHECKOUT_SESSION_ID}", updated.stripe_id));
    }
    return c.html(
      renderCardPage(
        "Payment Complete",
        "Your payment was successful.",
        '<p class="empty check">Payment received</p>',
        SERVICE_LABEL,
      ),
    );
  });
}
