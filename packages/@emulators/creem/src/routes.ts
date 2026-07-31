import { randomBytes } from "node:crypto";
import {
  escapeHtml,
  renderCardPage,
  renderCheckoutPage,
  renderInspectorPage,
  type CheckoutLineItem,
  type RouteContext,
} from "@emulators/core";
import { getCreemStore } from "./store.js";

const SERVICE_LABEL = "Creem";

function creemId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("base64url").slice(0, 24)}`;
}

function metadataFromUrl(url: string): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const [key, value] of new URL(url).searchParams) {
    const match = /^metadata\[([A-Za-z0-9_-]+)\]$/.exec(key);
    if (match && value) metadata[match[1]] = value;
  }
  return metadata;
}

function completeEvent(
  checkout: {
    creem_id: string;
    mode: "test";
    metadata: Record<string, string>;
    customer_id: string | null;
    customer_email: string | null;
    order_id: string | null;
    subscription_id: string | null;
  },
  product: {
    creem_id: string;
    amount: number;
    currency: string;
  },
) {
  return {
    id: creemId("evt"),
    eventType: "checkout.completed",
    created_at: Math.floor(Date.now() / 1000),
    object: {
      id: checkout.creem_id,
      object: "checkout",
      status: "completed",
      mode: checkout.mode,
      product: {
        id: product.creem_id,
      },
      customer: {
        id: checkout.customer_id,
        email: checkout.customer_email,
      },
      order: {
        id: checkout.order_id,
        status: "paid",
        amount: product.amount,
        currency: product.currency,
      },
      subscription: {
        id: checkout.subscription_id,
      },
      metadata: checkout.metadata,
    },
  };
}

function checkoutReturnUrl(value: string | null, checkoutId: string): string | null {
  if (!value) return null;
  if (value.includes("{CHECKOUT_ID}")) {
    return value.replace("{CHECKOUT_ID}", encodeURIComponent(checkoutId));
  }
  const url = new URL(value);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/checkout/${encodeURIComponent(checkoutId)}`;
  return url.toString();
}

export function creemRoutes({ app, store, webhooks }: RouteContext): void {
  const cs = getCreemStore(store);

  const renderProductCheckout = (requestUrl: string, productId: string) => {
    const product = cs.products.findOneBy("creem_id", productId);
    if (!product) {
      return renderCardPage(
        "Product Not Found",
        "This Creem test product is not configured.",
        `<p class="empty">${escapeHtml(productId)}</p>`,
        SERVICE_LABEL,
      );
    }
    const url = new URL(requestUrl);
    const requestedId = url.searchParams.get("checkout_id");
    const checkoutId = requestedId && /^ch_[A-Za-z0-9_-]+$/.test(requestedId) ? requestedId : creemId("ch");
    let checkout = cs.checkouts.findOneBy("creem_id", checkoutId);
    if (!checkout) {
      checkout = cs.checkouts.insert({
        creem_id: checkoutId,
        product_id: product.creem_id,
        status: "open",
        mode: "test",
        metadata: metadataFromUrl(requestUrl),
        customer_id: null,
        customer_email: null,
        order_id: null,
        subscription_id: null,
      });
    }
    const lineItems: CheckoutLineItem[] = [
      {
        name: product.name,
        quantity: 1,
        unitPrice: product.amount,
        totalPrice: product.amount,
        currency: product.currency,
      },
    ];
    return renderCheckoutPage(
      {
        merchantName: "YapHaus",
        lineItems,
        subtotal: product.amount,
        total: product.amount,
        currency: product.currency,
        sessionId: checkout.creem_id,
      },
      SERVICE_LABEL,
    );
  };

  app.get("/test/payment/:productId", (c) => c.html(renderProductCheckout(c.req.url, c.req.param("productId"))));
  app.get("/payment/:productId", (c) => c.html(renderProductCheckout(c.req.url, c.req.param("productId"))));

  app.post("/checkout/:id/complete", async (c) => {
    const checkout = cs.checkouts.findOneBy("creem_id", c.req.param("id"));
    if (!checkout || checkout.status !== "open") {
      return c.redirect(`/checkout/${encodeURIComponent(c.req.param("id"))}`);
    }
    const product = cs.products.findOneBy("creem_id", checkout.product_id);
    if (!product) {
      return c.html(
        renderCardPage(
          "Product Not Found",
          "This Creem test product is not configured.",
          '<p class="empty">Payment was not completed.</p>',
          SERVICE_LABEL,
        ),
        404,
      );
    }
    const submitted = await c.req.parseBody();
    const email =
      typeof submitted.email === "string" && submitted.email.includes("@")
        ? submitted.email.trim().toLowerCase()
        : "";
    if (!email) {
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
    const customerId = creemId("cust");
    const orderId = creemId("ord");
    const subscriptionId = creemId("sub");
    const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const completed = cs.checkouts.update(checkout.id, {
      status: "completed",
      customer_id: customerId,
      customer_email: email,
      order_id: orderId,
      subscription_id: subscriptionId,
    })!;
    cs.subscriptions.insert({
      creem_id: subscriptionId,
      checkout_id: completed.creem_id,
      customer_id: customerId,
      customer_email: email,
      status: "active",
      current_period_end_date: periodEnd,
    });
    await webhooks.dispatch(
      "checkout.completed",
      undefined,
      completeEvent(completed, product),
      "creem",
    );
    const destination = checkoutReturnUrl(product.return_url, completed.creem_id);
    if (destination) return c.redirect(destination);
    return c.html(
      renderCardPage(
        "Payment Complete",
        "Your test payment was successful.",
        '<p class="empty check">Payment received</p>',
        SERVICE_LABEL,
      ),
    );
  });

  app.post("/_creem/subscriptions/:id/cancel", async (c) => {
    const subscription = cs.subscriptions.findOneBy("creem_id", c.req.param("id"));
    if (!subscription) {
      return c.json({ error: "subscription_not_found" }, 404);
    }
    const canceled = cs.subscriptions.update(subscription.id, { status: "canceled" })!;
    const event = {
      id: creemId("evt"),
      eventType: "subscription.canceled",
      created_at: Math.floor(Date.now() / 1000),
      object: {
        object: "subscription",
        id: canceled.creem_id,
        status: canceled.status,
        customer: {
          id: canceled.customer_id,
          email: canceled.customer_email,
        },
        current_period_end_date: canceled.current_period_end_date,
      },
    };
    await webhooks.dispatch("subscription.canceled", undefined, event, "creem");
    return c.json(event.object);
  });

  app.get("/", (c) => {
    const checkouts = cs.checkouts
      .all()
      .map(
        (checkout) =>
          `<tr><td>${escapeHtml(checkout.creem_id)}</td><td>${escapeHtml(checkout.product_id)}</td><td>${escapeHtml(checkout.status)}</td></tr>`,
      )
      .join("");
    const subscriptions = cs.subscriptions
      .all()
      .map(
        (subscription) =>
          `<tr><td>${escapeHtml(subscription.creem_id)}</td><td>${escapeHtml(subscription.customer_email)}</td><td>${escapeHtml(subscription.status)}</td></tr>`,
      )
      .join("");
    return c.html(
      renderInspectorPage(
        "Creem",
        [
          { id: "checkouts", label: "Checkouts", href: "/?tab=checkouts" },
          { id: "subscriptions", label: "Subscriptions", href: "/?tab=subscriptions" },
        ],
        c.req.query("tab") === "subscriptions" ? "subscriptions" : "checkouts",
        c.req.query("tab") === "subscriptions"
          ? `<section class="inspector-section"><h2>Subscriptions</h2><table class="inspector-table"><thead><tr><th>ID</th><th>Customer</th><th>Status</th></tr></thead><tbody>${subscriptions}</tbody></table></section>`
          : `<section class="inspector-section"><h2>Checkouts</h2><table class="inspector-table"><thead><tr><th>ID</th><th>Product</th><th>Status</th></tr></thead><tbody>${checkouts}</tbody></table></section>`,
        SERVICE_LABEL,
      ),
    );
  });
}
