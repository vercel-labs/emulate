import type { RouteContext } from "@emulators/core";
import { renderCardPage, escapeHtml, escapeAttr } from "@emulators/core";
import { getStripeStore } from "../store.js";
import { stripeId, toUnixTimestamp, parseStripeBody, stripeError, stripeList } from "../helpers.js";
import type { StripeCheckoutSession } from "../entities.js";

const SERVICE_LABEL = "Stripe";

function formatSession(s: StripeCheckoutSession, baseUrl: string) {
  return {
    id: s.stripe_id,
    object: "checkout.session",
    mode: s.mode,
    status: s.status,
    payment_status: s.payment_status,
    customer: s.customer_id,
    success_url: s.success_url,
    cancel_url: s.cancel_url,
    metadata: s.metadata,
    created: toUnixTimestamp(s.created_at),
    livemode: false,
    url: s.status === "open" ? `${baseUrl}/checkout/${s.stripe_id}` : null,
  };
}

export function checkoutSessionRoutes({ app, store, webhooks, baseUrl }: RouteContext): void {
  const ss = getStripeStore(store);

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
    return c.json(formatSession(session, baseUrl), 200);
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
    return c.json(formatSession(session, baseUrl));
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
    const updated = ss.checkoutSessions.update(session.id, { status: "expired" })!;

    await webhooks.dispatch(
      "checkout.session.expired",
      undefined,
      { type: "checkout.session.expired", data: { object: formatSession(updated, baseUrl) } },
      "stripe",
    );

    return c.json(formatSession(updated, baseUrl));
  });

  app.get("/v1/checkout/sessions", (c) => {
    let items = ss.checkoutSessions.all();
    const customerId = c.req.query("customer");
    const status = c.req.query("status");
    const paymentStatus = c.req.query("payment_status");
    if (customerId) items = items.filter((s) => s.customer_id === customerId);
    if (status) items = items.filter((s) => s.status === status);
    if (paymentStatus) items = items.filter((s) => s.payment_status === paymentStatus);
    return stripeList(c, items, "/v1/checkout/sessions", (s) => formatSession(s, baseUrl));
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

    const lineItemsHtml =
      session.line_items.length > 0
        ? session.line_items
            .map((li) => {
              const priceObj = ss.prices.findOneBy("stripe_id", li.price);
              const product = priceObj ? ss.products.findOneBy("stripe_id", priceObj.product_id) : null;
              const name = product?.name ?? li.price;
              const amount = priceObj
                ? `$${(priceObj.unit_amount! / 100).toFixed(2)} ${priceObj.currency.toUpperCase()}`
                : "";
              return `<div class="org-row">
            <span class="org-icon">$</span>
            <span class="org-name">${escapeHtml(name)}</span>
            <span class="emu-bar-service">${escapeHtml(amount)} x ${li.quantity}</span>
          </div>`;
            })
            .join("")
        : '<p class="empty">No line items</p>';

    const body = `
      ${lineItemsHtml}
      <form class="user-form" method="post" action="/checkout/${escapeAttr(session.stripe_id)}/complete">
        <button type="submit" class="user-btn">
          <span class="avatar">$</span>
          <span class="user-text">
            <span class="user-login">Pay and Complete</span>
          </span>
        </button>
      </form>
      ${session.cancel_url ? `<p class="info-text"><a href="${escapeAttr(session.cancel_url)}" class="btn-revoke">Cancel</a></p>` : ""}
    `;

    return c.html(
      renderCardPage("Checkout", `Complete your ${escapeHtml(session.mode)} payment.`, body, SERVICE_LABEL),
    );
  });

  app.post("/checkout/:id/complete", async (c) => {
    const session = ss.checkoutSessions.findOneBy("stripe_id", c.req.param("id"));
    if (!session || session.status !== "open") {
      return c.redirect("/checkout/" + c.req.param("id"));
    }

    const updated = ss.checkoutSessions.update(session.id, { status: "complete", payment_status: "paid" })!;

    await webhooks.dispatch(
      "checkout.session.completed",
      undefined,
      { type: "checkout.session.completed", data: { object: formatSession(updated, baseUrl) } },
      "stripe",
    );

    if (session.success_url) {
      return c.redirect(session.success_url);
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
