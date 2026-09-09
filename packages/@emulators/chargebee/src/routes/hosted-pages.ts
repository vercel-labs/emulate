import { renderCardPage, renderCheckoutPage, escapeHtml, escapeAttr, type CheckoutLineItem } from "@emulators/core";
import type { ChargebeeCustomer, ChargebeeHostedPage, HostedPageContent, HostedPageType } from "../entities.js";
import {
  changeSubscription,
  collectInvoice,
  createOneOffInvoice,
  createSubscription,
  linesForItems,
  previewInvoice,
  resolveItems,
} from "../billing.js";
import { addCardPaymentSource } from "../cards.js";
import { primaryPaymentSource } from "../formatters.js";
import { formatHostedPage } from "../formatters.js";
import {
  ChargebeeApiError,
  blankParamError,
  bool,
  chargebeeList,
  invalidStateError,
  jsonValue,
  num,
  paramError,
  parseChargebeeBody,
  pickAddress,
  pickCustomFields,
  str,
  strOrNull,
  stringList,
  type Body,
} from "../helpers.js";
import { chargebeeId } from "../ids.js";
import { nowSeconds, resourceVersion } from "../store.js";
import {
  api,
  findCustomer,
  findHostedPage,
  findSubscription,
  nested,
  parseCharges,
  parseItemRequests,
  type ChargebeeRouteContext,
} from "../route-utils.js";
import { cardInputFrom, createCustomerFromBody } from "./customers.js";

const SERVICE_LABEL = "Chargebee";
const HOSTED_PAGE_TTL_SECONDS = 3600;

function appendQuery(url: string, params: Record<string, string>): string {
  const target = new URL(url, "http://localhost");
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  return url.startsWith("http") ? target.toString() : `${target.pathname}${target.search}`;
}

export function hostedPageRoutes(rc: ChargebeeRouteContext): void {
  const { app, cs, ctx, baseUrl } = rc;

  function insertPage(type: HostedPageType, body: Body): ChargebeeHostedPage {
    return cs.hostedPages.insert({
      cb_id: chargebeeId(48),
      type,
      state: "created",
      failure_reason: null,
      pass_thru_content: strOrNull(body.pass_thru_content),
      embed: bool(body.embed) ?? false,
      expires_at: nowSeconds(cs) + HOSTED_PAGE_TTL_SECONDS,
      redirect_url: strOrNull(body.redirect_url),
      cancel_url: strOrNull(body.cancel_url),
      request: body,
      content: null,
      resource_version: resourceVersion(cs),
    });
  }

  app.post(
    "/api/v2/hosted_pages/checkout_new_for_items",
    api(cs, async (c) => {
      const body = await parseChargebeeBody(c);
      resolveItems(cs, parseItemRequests(body));
      const customerId = str(nested(body, "customer").id);
      if (customerId) findCustomer(cs, customerId);
      return c.json({ hosted_page: formatHostedPage(cs, insertPage("checkout_new", body), baseUrl) });
    }),
  );

  app.post(
    "/api/v2/hosted_pages/checkout_existing_for_items",
    api(cs, async (c) => {
      const body = await parseChargebeeBody(c);
      const subscriptionId = str(nested(body, "subscription").id);
      if (!subscriptionId) throw blankParamError("subscription[id]");
      findSubscription(cs, subscriptionId);
      return c.json({ hosted_page: formatHostedPage(cs, insertPage("checkout_existing", body), baseUrl) });
    }),
  );

  app.post(
    "/api/v2/hosted_pages/checkout_one_time_for_items",
    api(cs, async (c) => {
      const body = await parseChargebeeBody(c);
      const customerId = str(nested(body, "customer").id);
      if (customerId) findCustomer(cs, customerId);
      if (parseItemRequests(body, "item_prices").length === 0 && parseCharges(body).length === 0) {
        throw blankParamError("item_prices[item_price_id][0]");
      }
      return c.json({ hosted_page: formatHostedPage(cs, insertPage("checkout_one_time", body), baseUrl) });
    }),
  );

  const customerPage = (type: HostedPageType) =>
    api(cs, async (c) => {
      const body = await parseChargebeeBody(c);
      const customerId = str(nested(body, "customer").id);
      if (!customerId) throw blankParamError("customer[id]");
      findCustomer(cs, customerId);
      return c.json({ hosted_page: formatHostedPage(cs, insertPage(type, body), baseUrl) });
    });

  app.post("/api/v2/hosted_pages/manage_payment_sources", customerPage("manage_payment_sources"));
  app.post("/api/v2/hosted_pages/update_payment_method", customerPage("update_payment_method"));
  app.post("/api/v2/hosted_pages/collect_now", customerPage("collect_now"));

  app.get(
    "/api/v2/hosted_pages",
    api(cs, (c) =>
      chargebeeList(c, cs.hostedPages.all(), "hosted_page", (page) => ({
        hosted_page: formatHostedPage(cs, page, baseUrl),
      })),
    ),
  );

  app.get(
    "/api/v2/hosted_pages/:id",
    api(cs, (c) => c.json({ hosted_page: formatHostedPage(cs, findHostedPage(cs, c.req.param("id")), baseUrl) })),
  );

  app.post(
    "/api/v2/hosted_pages/:id/acknowledge",
    api(cs, (c) => {
      const page = findHostedPage(cs, c.req.param("id"));
      if (page.state !== "succeeded") throw invalidStateError("Only succeeded hosted pages can be acknowledged");
      const updated = cs.hostedPages.update(page.id, { state: "acknowledged", resource_version: resourceVersion(cs) })!;
      return c.json({ hosted_page: formatHostedPage(cs, updated, baseUrl) });
    }),
  );

  function pageLines(page: ChargebeeHostedPage): { lineItems: CheckoutLineItem[]; total: number; currency: string } {
    const body = page.request;
    if (page.type === "checkout_new" || page.type === "checkout_existing") {
      const items = resolveItems(cs, parseItemRequests(body));
      const lines = linesForItems(cs, items, "", null, 0, 0, true);
      const preview = previewInvoice(cs, null, lines, stringList(body.coupon_ids));
      const currency = cs.itemPrices.findOneBy("cb_id", items[0].item_price_id)?.currency_code ?? "USD";
      return {
        lineItems: lines.map((line) => ({
          name: line.description,
          quantity: line.quantity,
          unitPrice: line.unit_amount,
          totalPrice: line.amount - line.discount_amount,
          currency,
        })),
        total: preview.total,
        currency,
      };
    }
    if (page.type === "checkout_one_time") {
      const items = parseItemRequests(body, "item_prices");
      const lineItems: CheckoutLineItem[] = [];
      let currency = str(body.currency_code) ?? "USD";
      for (const item of items) {
        const ip = cs.itemPrices.findOneBy("cb_id", item.item_price_id);
        if (!ip) continue;
        currency = ip.currency_code;
        const quantity = item.quantity ?? 1;
        const unit = item.unit_price ?? ip.price ?? 0;
        lineItems.push({
          name: ip.external_name ?? ip.name,
          quantity,
          unitPrice: unit,
          totalPrice: unit * quantity,
          currency,
        });
      }
      for (const charge of parseCharges(body)) {
        lineItems.push({
          name: charge.description,
          quantity: 1,
          unitPrice: charge.amount,
          totalPrice: charge.amount,
          currency,
        });
      }
      return { lineItems, total: lineItems.reduce((sum, line) => sum + line.totalPrice, 0), currency };
    }
    if (page.type === "collect_now") {
      const customerId = str(nested(body, "customer").id) ?? "";
      const due = cs.invoices
        .findBy("customer_id", customerId)
        .filter((invoice) => invoice.status !== "voided" && invoice.amount_due > 0);
      const currency = due[0]?.currency_code ?? "USD";
      return {
        lineItems: due.map((invoice) => ({
          name: `Invoice #${invoice.cb_id}`,
          quantity: 1,
          unitPrice: invoice.amount_due,
          totalPrice: invoice.amount_due,
          currency,
        })),
        total: due.reduce((sum, invoice) => sum + invoice.amount_due, 0),
        currency,
      };
    }
    return { lineItems: [], total: 0, currency: "USD" };
  }

  function renderPage(page: ChargebeeHostedPage): string {
    const action = `/pages/v3/${page.cb_id}/complete`;
    if (page.type === "manage_payment_sources" || page.type === "update_payment_method") {
      return renderCardPage(
        "Payment Method",
        "Add a simulated test card to this customer.",
        `<form method="post" action="${escapeAttr(action)}">
  <div class="checkout-form-section">
    <label class="checkout-form-label">Card number</label>
    <input type="text" name="card_number" class="checkout-input" value="4111 1111 1111 1111"/>
    <div class="checkout-sim-note">Use 4000 0000 0000 0002 to add a card that declines.</div>
  </div>
  <button type="submit" class="checkout-pay-btn">Save card</button>
</form>
${page.cancel_url ? `<div class="checkout-cancel"><a href="${escapeAttr(page.cancel_url)}">Cancel</a></div>` : ""}`,
        SERVICE_LABEL,
      );
    }
    const { lineItems, total, currency } = pageLines(page);
    return renderCheckoutPage(
      {
        merchantName: "Chargebee Checkout",
        lineItems,
        subtotal: lineItems.reduce((sum, line) => sum + line.totalPrice, 0),
        total,
        currency,
        sessionId: page.cb_id,
        cancelUrl: page.cancel_url,
        completeAction: action,
      },
      SERVICE_LABEL,
    );
  }

  async function ensurePaymentSource(customer: ChargebeeCustomer, cardNumber?: string): Promise<ChargebeeCustomer> {
    if (cardNumber) {
      await addCardPaymentSource(ctx, customer, { number: cardNumber }, { source: "hosted_page" });
      return cs.customers.get(customer.id)!;
    }
    if (primaryPaymentSource(cs, customer)) return customer;
    await addCardPaymentSource(ctx, customer, {}, { source: "hosted_page" });
    return cs.customers.get(customer.id)!;
  }

  async function completePage(page: ChargebeeHostedPage, form: Body): Promise<HostedPageContent> {
    const body = page.request;
    const cardNumber = str(form.card_number)?.replace(/\s/g, "");
    if (page.type === "checkout_new") {
      const customerBody = nested(body, "customer");
      const customerId = str(customerBody.id);
      let customer = customerId ? cs.customers.findOneBy("cb_id", customerId) : undefined;
      if (!customer) {
        customer = await createCustomerFromBody(
          ctx,
          {
            ...customerBody,
            email: str(form.email) || customerBody.email,
            billing_address: body.billing_address ?? customerBody.billing_address,
            card: body.card,
          },
          "hosted_page",
        );
      } else if (cardInputFrom(body.card)) {
        await addCardPaymentSource(ctx, customer, cardInputFrom(body.card)!, { source: "hosted_page" });
        customer = cs.customers.get(customer.id)!;
      }
      customer = await ensurePaymentSource(customer, cardNumber);
      const subscriptionBody = nested(body, "subscription");
      const result = await createSubscription(ctx, {
        customer,
        id: str(subscriptionBody.id),
        items: parseItemRequests(body),
        couponIds: stringList(body.coupon_ids),
        trialEnd: num(subscriptionBody.trial_end),
        startDate: num(subscriptionBody.start_date),
        poNumber: strOrNull(subscriptionBody.po_number),
        invoiceNotes: strOrNull(subscriptionBody.invoice_notes),
        metaData: jsonValue(subscriptionBody.meta_data),
        customFields: pickCustomFields(subscriptionBody),
        shippingAddress: pickAddress(body.shipping_address),
        source: "hosted_page",
      });
      return {
        customer_id: customer.cb_id,
        subscription_id: result.subscription.cb_id,
        invoice_id: result.invoice?.cb_id,
      };
    }
    if (page.type === "checkout_existing") {
      const sub = findSubscription(cs, str(nested(body, "subscription").id) ?? "");
      let customer = findCustomer(cs, sub.customer_id);
      customer = await ensurePaymentSource(customer, cardNumber);
      const items = parseItemRequests(body);
      const result = await changeSubscription(ctx, sub, {
        items: items.length > 0 ? items : undefined,
        replaceItemsList: bool(body.replace_items_list) ?? false,
        couponIds: body.coupon_ids !== undefined ? stringList(body.coupon_ids) : undefined,
        source: "hosted_page",
      });
      return {
        customer_id: customer.cb_id,
        subscription_id: result.subscription.cb_id,
        invoice_id: result.invoice?.cb_id,
      };
    }
    if (page.type === "checkout_one_time") {
      const customerBody = nested(body, "customer");
      const customerId = str(customerBody.id);
      let customer = customerId ? cs.customers.findOneBy("cb_id", customerId) : undefined;
      if (!customer) {
        customer = await createCustomerFromBody(
          ctx,
          { ...customerBody, email: str(form.email) || customerBody.email },
          "hosted_page",
        );
      }
      customer = await ensurePaymentSource(customer, cardNumber);
      const result = await createOneOffInvoice(ctx, {
        customer,
        itemPrices: parseItemRequests(body, "item_prices"),
        charges: parseCharges(body),
        couponIds: stringList(body.coupon_ids),
        currencyCode: str(body.currency_code)?.toUpperCase(),
        notes: strOrNull(body.invoice_note),
        source: "hosted_page",
      });
      return { customer_id: customer.cb_id, invoice_id: result.invoice.cb_id };
    }
    if (page.type === "collect_now") {
      let customer = findCustomer(cs, str(nested(body, "customer").id) ?? "");
      customer = await ensurePaymentSource(customer, cardNumber);
      const due = cs.invoices
        .findBy("customer_id", customer.cb_id)
        .filter((invoice) => invoice.status !== "voided" && invoice.amount_due > 0)
        .sort((a, b) => a.date - b.date);
      let lastInvoice: string | undefined;
      for (const invoice of due) {
        const outcome = await collectInvoice(ctx, invoice, { source: "hosted_page", emitUpdated: true });
        if (!outcome.ok)
          throw paramError("card_number", "the payment was declined by the test gateway", "payment_processing_failed");
        lastInvoice = invoice.cb_id;
      }
      return { customer_id: customer.cb_id, invoice_id: lastInvoice };
    }
    const customer = findCustomer(cs, str(nested(body, "customer").id) ?? "");
    const source = await addCardPaymentSource(ctx, customer, { number: cardNumber }, { source: "hosted_page" });
    return { customer_id: customer.cb_id, payment_source_id: source.cb_id };
  }

  const showPage = (c: Parameters<Parameters<typeof app.get>[1]>[0]) => {
    const page = cs.hostedPages.findOneBy("cb_id", c.req.param("id"));
    if (!page) {
      return c.html(
        renderCardPage(
          "Page Not Found",
          "This hosted page does not exist.",
          '<p class="empty">The hosted page id is invalid.</p>',
          SERVICE_LABEL,
        ),
        404,
      );
    }
    if (page.state !== "created" && page.state !== "requested") {
      return c.html(
        renderCardPage(
          "Checkout Complete",
          "This hosted page has already been used.",
          `<p class="empty">State: ${escapeHtml(page.state)}</p>`,
          SERVICE_LABEL,
        ),
      );
    }
    if (page.expires_at < nowSeconds(cs)) {
      return c.html(
        renderCardPage(
          "Page Expired",
          "This hosted page has expired.",
          '<p class="empty">Create a new hosted page.</p>',
          SERVICE_LABEL,
        ),
      );
    }
    try {
      return c.html(renderPage(page));
    } catch (error) {
      if (error instanceof ChargebeeApiError) {
        return c.html(
          renderCardPage(
            "Checkout Error",
            error.message,
            '<p class="empty">Fix the request and create a new page.</p>',
            SERVICE_LABEL,
          ),
          400,
        );
      }
      throw error;
    }
  };

  app.get("/pages/v3/:id", showPage);
  app.get("/pages/v3/:id/", showPage);

  app.post("/pages/v3/:id/complete", async (c) => {
    const page = cs.hostedPages.findOneBy("cb_id", c.req.param("id"));
    if (!page || (page.state !== "created" && page.state !== "requested")) {
      return c.redirect(`/pages/v3/${c.req.param("id")}/`);
    }
    const form = await parseChargebeeBody(c);
    try {
      const content = await completePage(page, form);
      const updated = cs.hostedPages.update(page.id, {
        state: "succeeded",
        content,
        resource_version: resourceVersion(cs),
      })!;
      if (updated.redirect_url) {
        return c.redirect(appendQuery(updated.redirect_url, { id: updated.cb_id, state: "succeeded" }));
      }
      return c.html(
        renderCardPage(
          "Checkout Complete",
          "The hosted page completed successfully.",
          '<p class="empty check">Done</p>',
          SERVICE_LABEL,
        ),
      );
    } catch (error) {
      if (!(error instanceof ChargebeeApiError)) throw error;
      cs.hostedPages.update(page.id, {
        state: "failed",
        failure_reason: error.message,
        resource_version: resourceVersion(cs),
      });
      return c.html(
        renderCardPage(
          "Checkout Failed",
          error.message,
          `<p class="empty">${escapeHtml(error.body.api_error_code)}</p>`,
          SERVICE_LABEL,
        ),
        400,
      );
    }
  });
}
