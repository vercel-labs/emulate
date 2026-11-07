import type { RouteContext } from "@emulators/core";
import { renderCardPage, renderCheckoutPage, escapeHtml } from "@emulators/core";
import type { CheckoutLineItem } from "@emulators/core";
import { getStripeStore } from "../store.js";
import { stripeId, parseStripeBody, stripeError, stripeList, expandedJson } from "../helpers.js";
import { formatCheckoutSession as formatSession, stripeExpandResolver } from "../formatters.js";
import { eventBatch } from "../events.js";
import type { StripeCheckoutSession } from "../entities.js";

const SERVICE_LABEL = "Stripe";

export function checkoutSessionRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const ss = getStripeStore(store);
  const expand = stripeExpandResolver(ss, baseUrl);

  app.post("/v1/checkout/sessions", async (c) => {
    const body = await parseStripeBody(c);
    if (!body.mode)
      return stripeError(c, 400, "invalid_request_error", "Missing required param: mode.", undefined, "mode");

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
        const li = body.line_items[i] as Record<string, unknown>;
        if (!li || typeof li !== "object") {
          return stripeError(
            c,
            400,
            "invalid_request_error",
            `Invalid line_items[${i}]: must be an object.`,
            undefined,
            `line_items[${i}]`,
          );
        }
        if (!li.price || typeof li.price !== "string") {
          return stripeError(
            c,
            400,
            "invalid_request_error",
            `Missing required param: line_items[${i}][price].`,
            undefined,
            `line_items[${i}][price]`,
          );
        }
        if (!ss.prices.findOneBy("stripe_id", li.price)) {
          return stripeError(
            c,
            400,
            "invalid_request_error",
            `No such price: '${li.price}'`,
            "resource_missing",
            `line_items[${i}][price]`,
          );
        }
        const qty = typeof li.quantity === "number" ? li.quantity : parseInt(li.quantity as string, 10);
        if (!Number.isFinite(qty) || qty < 1) {
          return stripeError(
            c,
            400,
            "invalid_request_error",
            `Invalid line_items[${i}][quantity]: must be a positive integer.`,
            undefined,
            `line_items[${i}][quantity]`,
          );
        }
        lineItems.push({ price: li.price, quantity: qty });
      }
    }

    const session = ss.checkoutSessions.insert({
      stripe_id: stripeId("cs"),
      mode: body.mode as StripeCheckoutSession["mode"],
      status: "open",
      payment_status: "unpaid",
      customer_id: (body.customer as string) ?? null,
      success_url: (body.success_url as string) ?? null,
      cancel_url: (body.cancel_url as string) ?? null,
      line_items: lineItems,
      metadata: (body.metadata as Record<string, string>) ?? {},
    });
    return expandedJson(c, formatSession(session, baseUrl), expand, body);
  });

  app.get("/v1/checkout/sessions/:id", (c) => {
    const session = ss.checkoutSessions.findOneBy("stripe_id", c.req.param("id"));
    if (!session)
      return stripeError(
        c,
        404,
        "invalid_request_error",
        `No such checkout session: '${c.req.param("id")}'`,
        "resource_missing",
      );
    return expandedJson(c, formatSession(session, baseUrl), expand);
  });

  app.post("/v1/checkout/sessions/:id/expire", async (c) => {
    const session = ss.checkoutSessions.findOneBy("stripe_id", c.req.param("id"));
    if (!session)
      return stripeError(
        c,
        404,
        "invalid_request_error",
        `No such checkout session: '${c.req.param("id")}'`,
        "resource_missing",
      );
    if (session.status !== "open") {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        "Only open sessions can be expired.",
        "checkout_session_not_open",
      );
    }
    const body = await parseStripeBody(c);
    const updated = ss.checkoutSessions.update(session.id, { status: "expired" })!;

    const ev = eventBatch(ctx, c);
    ev.emit("checkout.session.expired", formatSession(updated, baseUrl));
    await ev.commit();

    return expandedJson(c, formatSession(updated, baseUrl), expand, body);
  });

  app.get("/v1/checkout/sessions", (c) => {
    let items = ss.checkoutSessions.all();
    const customerId = c.req.query("customer");
    const status = c.req.query("status");
    const paymentStatus = c.req.query("payment_status");
    if (customerId) items = items.filter((s) => s.customer_id === customerId);
    if (status) items = items.filter((s) => s.status === status);
    if (paymentStatus) items = items.filter((s) => s.payment_status === paymentStatus);
    return stripeList(c, items, "/v1/checkout/sessions", (s) => formatSession(s, baseUrl), { expand });
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

    const lineItems: CheckoutLineItem[] = session.line_items.map((li) => {
      const priceObj = ss.prices.findOneBy("stripe_id", li.price);
      const product = priceObj ? ss.products.findOneBy("stripe_id", priceObj.product_id) : null;
      const unitPrice = priceObj?.unit_amount ?? 0;
      return {
        name: product?.name ?? li.price,
        quantity: li.quantity,
        unitPrice,
        totalPrice: unitPrice * li.quantity,
        currency: priceObj?.currency ?? "usd",
      };
    });

    const subtotal = lineItems.reduce((sum, li) => sum + li.totalPrice, 0);
    const currency = lineItems.length > 0 ? lineItems[0].currency : "usd";

    return c.html(
      renderCheckoutPage(
        {
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
      return c.redirect("/checkout/" + c.req.param("id"));
    }

    const updated = ss.checkoutSessions.update(session.id, { status: "complete", payment_status: "paid" })!;

    // Completed on the hosted page, not through the API, so the event carries no request.
    const ev = eventBatch(ctx);
    ev.emit("checkout.session.completed", formatSession(updated, baseUrl));
    await ev.commit();

    if (session.success_url) {
      const url = session.success_url.replace("{CHECKOUT_SESSION_ID}", updated.stripe_id);
      return c.redirect(url);
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
