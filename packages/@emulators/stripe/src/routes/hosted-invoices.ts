import type { Context, RouteContext } from "@emulators/core";
import { renderCardPage, renderPaymentMethodSelect, escapeAttr, escapeHtml } from "@emulators/core";
import { getStripeStore, type StripeStore } from "../store.js";
import { parseStripeBody } from "../helpers.js";
import { defaultInvoicePayment, formatInvoice, hostedInvoiceUrl, invoiceLines } from "../formatters.js";
import { eventBatch, type EventBatch } from "../events.js";
import { asksForAuthentication, resolvePaymentMethod } from "../payments.js";
import { invoicePaymentMethodId, payInvoice, type InvoiceResult, type InvoicingContext } from "../invoicing.js";
import { DEFAULT_CHECKOUT_CARD, HOSTED_CARD_NOTE, SERVICE_LABEL, cardOptions } from "../checkout.js";
import { formatMoney } from "../lines.js";
import { testCardByPaymentMethod } from "../test-cards.js";
import type { StripeInvoice } from "../entities.js";

/** A `<select name="payment_method">` of the test cards the hosted pages offer, with its note. */
export function cardSelect(chosen?: string): string {
  return renderPaymentMethodSelect(cardOptions(chosen), HOSTED_CARD_NOTE);
}

export function money(amount: number, currency: string): string {
  return formatMoney(String(amount), currency);
}

export function day(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

export function errorBlock(message: string | undefined): string {
  return message ? `<div class="checkout-error">${escapeHtml(message)}</div>` : "";
}

/** Whether paying with stored payment method `id` asks the customer for 3D Secure. */
function asksOnPage(ss: StripeStore, id: string): boolean {
  const pm = ss.paymentMethods.findOneBy("stripe_id", id);
  return pm ? asksForAuthentication(pm, false) : false;
}

/**
 * Pay an open invoice from a hosted page, with `paymentMethod` or the invoice's usual payment
 * method. A test card id becomes a new card that is not saved to the customer. The customer is
 * on the page, so a card that asks for 3D Secure is approved there. A failed attempt is kept,
 * with its invoice.payment_failed, as on Stripe.
 */
export function payInvoiceOnPage(
  ctx: InvoicingContext,
  ev: EventBatch,
  inv: StripeInvoice,
  paymentMethod?: string,
): InvoiceResult {
  const ss = getStripeStore(ctx.store);
  let requested = paymentMethod;
  if (requested && testCardByPaymentMethod(requested) && inv.status !== "paid" && inv.status !== "void") {
    const resolved = resolvePaymentMethod(ss, requested, inv.customer_id);
    if (!resolved.ok) return resolved;
    requested = resolved.pm.stripe_id;
  }
  const id = requested ?? invoicePaymentMethodId(ss, inv);
  if (inv.status !== "draft" && id && asksOnPage(ss, id)) {
    const record = defaultInvoicePayment(ss, inv.stripe_id);
    const pi = record ? ss.paymentIntents.findOneBy("stripe_id", record.payment_intent_id) : undefined;
    if (pi) ss.paymentIntents.update(pi.id, { authenticated: true });
  }
  return payInvoice(ctx, ev, inv, { paymentMethod: requested, offSession: false });
}

export function hostedInvoiceRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const ss = getStripeStore(store);

  const notFound = (c: Context) =>
    c.html(
      renderCardPage(
        "Invoice Not Found",
        "This invoice does not exist.",
        '<p class="empty">The invoice ID is invalid, or the invoice is still a draft.</p>',
        SERVICE_LABEL,
      ),
      404,
    );

  /** A finalized invoice. Drafts have no hosted page. */
  const findInvoice = (c: Context) => {
    const inv = ss.invoices.findOneBy("stripe_id", c.req.param("id")!);
    return inv && inv.status !== "draft" ? inv : undefined;
  };

  const renderInvoice = (inv: StripeInvoice, options: { errorMessage?: string; paymentMethod?: string } = {}) => {
    const wire = formatInvoice(ss, inv, baseUrl);
    const lines = invoiceLines(ss, inv.stripe_id)
      .map(
        (line) => `<div class="checkout-line-item">
  <div class="checkout-item-details">
    <div class="checkout-item-name">${escapeHtml(line.description ?? "")}</div>
    <div class="checkout-item-qty">Qty ${escapeHtml(String(line.quantity ?? 1))}</div>
  </div>
  <div class="checkout-item-price">${escapeHtml(money(line.amount, line.currency))}</div>
</div>`,
      )
      .join("");
    const totals = `<div class="checkout-totals">
  <div class="checkout-totals-row"><span>Total</span><span>${escapeHtml(money(wire.total, wire.currency))}</span></div>
  <div class="checkout-totals-row"><span>Amount paid</span><span>${escapeHtml(money(wire.amount_paid, wire.currency))}</span></div>
  <div class="checkout-totals-row total"><span>Amount due</span><span>${escapeHtml(money(wire.amount_remaining, wire.currency))}</span></div>
</div>`;

    let action: string;
    if (inv.status === "paid") {
      action = `<p class="empty check">Paid${inv.paid_at ? ` on ${escapeHtml(day(inv.paid_at))}` : ""}</p>`;
    } else if (inv.status === "void") {
      action = '<p class="empty">This invoice is void and can no longer be paid.</p>';
    } else {
      action = `<form method="post" action="/invoice/${escapeAttr(inv.stripe_id)}/pay">
  ${errorBlock(options.errorMessage)}
  <div class="checkout-form-section">
    <label class="checkout-form-label">Card information</label>
    ${cardSelect(options.paymentMethod)}
  </div>
  <button type="submit" class="checkout-pay-btn">Pay ${escapeHtml(money(wire.amount_remaining, wire.currency))}</button>
</form>`;
    }

    const due = wire.due_date ? ` Due ${escapeHtml(day(wire.due_date))}.` : "";
    const billedTo = wire.customer_email ? ` Billed to ${escapeHtml(wire.customer_email)}.` : "";
    return renderCardPage(
      `Invoice ${wire.number ?? inv.stripe_id}`,
      `${escapeHtml(inv.stripe_id)}, status ${escapeHtml(inv.status)}.${due}${billedTo}`,
      `${lines}${totals}${action}`,
      SERVICE_LABEL,
    );
  };

  app.get("/invoice/:id", (c) => {
    const inv = findInvoice(c);
    if (!inv) return notFound(c);
    return c.html(renderInvoice(inv));
  });

  app.post("/invoice/:id/pay", async (c) => {
    const inv = findInvoice(c);
    if (!inv) return notFound(c);
    const form = await parseStripeBody(c);
    const paymentMethod =
      typeof form.payment_method === "string" && form.payment_method !== "" ? form.payment_method : undefined;

    // Paid on the hosted page, not through the API, so the events carry no request.
    const ev = eventBatch(ctx);
    const result = payInvoiceOnPage(ctx, ev, inv, paymentMethod ?? DEFAULT_CHECKOUT_CARD);
    await ev.commit();
    if (!result.ok) {
      const current = ss.invoices.get(inv.id) ?? inv;
      const status = result.error.status === 402 ? 402 : 400;
      return c.html(renderInvoice(current, { errorMessage: result.error.message, paymentMethod }), status);
    }
    return c.redirect(hostedInvoiceUrl(baseUrl, inv.stripe_id), 303);
  });
}
