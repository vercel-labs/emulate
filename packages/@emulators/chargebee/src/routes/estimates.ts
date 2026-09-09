import type {
  ChargebeeCustomer,
  ChargebeeSubscription,
  InvoiceDiscount,
  InvoiceLineItem,
  SubscriptionItem,
} from "../entities.js";
import {
  adhocLines,
  applicableCoupons,
  computeProration,
  linesForItems,
  planItemPrice,
  previewInvoice,
  prorationRatio,
  resolveCoupons,
  resolveItems,
} from "../billing.js";
import { formatDiscount, formatLineItem } from "../formatters.js";
import {
  addPeriod,
  blankParamError,
  bool,
  num,
  parseChargebeeBody,
  roundMoney,
  str,
  stringList,
  type Body,
} from "../helpers.js";
import { nowSeconds } from "../store.js";
import {
  api,
  findCustomer,
  findSubscription,
  nested,
  parseCharges,
  parseItemRequests,
  type ChargebeeRouteContext,
} from "../route-utils.js";

type Json = Record<string, unknown>;

function invoiceEstimate(
  currency: string,
  lines: InvoiceLineItem[],
  discounts: InvoiceDiscount[],
  subTotal: number,
  total: number,
  recurring: boolean,
  customerId?: string,
): Json {
  return {
    recurring,
    price_type: "tax_exclusive",
    currency_code: currency,
    sub_total: subTotal,
    total,
    credits_applied: 0,
    amount_paid: 0,
    amount_due: total,
    object: "invoice_estimate",
    ...(customerId ? { customer_id: customerId } : {}),
    line_items: lines.map(formatLineItem),
    discounts: discounts.map(formatDiscount),
    taxes: [],
    line_item_taxes: [],
    line_item_discounts: [],
    round_off_amount: 0,
  };
}

export function estimateRoutes(rc: ChargebeeRouteContext): void {
  const { app, cs } = rc;

  function subscriptionEstimate(body: Body, customer: ChargebeeCustomer | null): Json {
    const now = nowSeconds(cs);
    const items = resolveItems(cs, parseItemRequests(body));
    const plan = planItemPrice(cs, items);
    const subscriptionBody = nested(body, "subscription");
    const startDate = num(subscriptionBody.start_date) ?? num(body.start_date);
    const start = startDate !== undefined && startDate > now ? startDate : now;
    const trialParam = num(subscriptionBody.trial_end) ?? num(body.trial_end);
    const trialEnd =
      trialParam !== undefined
        ? trialParam > start
          ? trialParam
          : null
        : plan.trial_period && plan.trial_period_unit
          ? addPeriod(start, plan.trial_period, plan.trial_period_unit)
          : null;
    const status = start > now ? "future" : trialEnd && trialEnd > now ? "in_trial" : "active";
    const termStart = status === "active" ? start : (trialEnd ?? start);
    const termEnd = addPeriod(termStart, plan.period ?? 1, plan.period_unit ?? "month");
    const couponIds = stringList(body.coupon_ids);
    resolveCoupons(cs, couponIds, start);
    const customerId = customer?.cb_id ?? str(nested(body, "customer").id) ?? "";
    const subscriptionId = str(subscriptionBody.id);

    const estimate: Json = {
      created_at: now,
      object: "estimate",
      subscription_estimate: {
        ...(subscriptionId ? { id: subscriptionId } : {}),
        currency_code: plan.currency_code,
        status,
        next_billing_at: status === "active" ? termEnd : status === "in_trial" ? trialEnd : start,
        object: "subscription_estimate",
      },
      credit_note_estimates: [],
      unbilled_charge_estimates: [],
    };

    const immediateLines = linesForItems(cs, items, customerId, subscriptionId ?? null, termStart, termEnd, true);
    const immediate = previewInvoice(cs, customer, immediateLines, couponIds);
    const renewalLines = linesForItems(
      cs,
      items,
      customerId,
      subscriptionId ?? null,
      termEnd,
      addPeriod(termEnd, plan.period ?? 1, plan.period_unit ?? "month"),
      false,
    );
    const recurringCoupons = couponIds.filter((id) => cs.coupons.findOneBy("cb_id", id)?.duration_type !== "one_time");
    const renewal = previewInvoice(cs, null, renewalLines, recurringCoupons);
    if (status === "active") {
      estimate.invoice_estimate = invoiceEstimate(
        plan.currency_code,
        immediate.lines,
        immediate.discounts,
        immediate.sub_total,
        immediate.total,
        true,
        customerId || undefined,
      );
    } else {
      estimate.next_invoice_estimate = invoiceEstimate(
        plan.currency_code,
        immediate.lines,
        immediate.discounts,
        immediate.sub_total,
        immediate.total,
        true,
        customerId || undefined,
      );
    }
    if (status === "active") {
      estimate.next_invoice_estimate = invoiceEstimate(
        plan.currency_code,
        renewal.lines,
        renewal.discounts,
        renewal.sub_total,
        renewal.total,
        true,
        customerId || undefined,
      );
    }
    return estimate;
  }

  app.post(
    "/api/v2/estimates/create_subscription_for_items",
    api(cs, async (c) => {
      const body = await parseChargebeeBody(c);
      const customerId = str(nested(body, "customer").id);
      const customer = customerId ? (cs.customers.findOneBy("cb_id", customerId) ?? null) : null;
      return c.json({ estimate: subscriptionEstimate(body, customer) });
    }),
  );

  app.post(
    "/api/v2/customers/:id/create_subscription_for_items_estimate",
    api(cs, async (c) => {
      const customer = findCustomer(cs, c.req.param("id"));
      const body = await parseChargebeeBody(c);
      return c.json({ estimate: subscriptionEstimate(body, customer) });
    }),
  );

  function renewalEstimate(sub: ChargebeeSubscription): Json {
    const now = nowSeconds(cs);
    const items = sub.scheduled_changes?.subscription_items ?? sub.subscription_items;
    const from = sub.current_term_end ?? sub.trial_end ?? sub.start_date ?? now;
    const to = addPeriod(from, sub.billing_period, sub.billing_period_unit);
    const lines = linesForItems(cs, items, sub.customer_id, sub.cb_id, from, to, false);
    const coupons = applicableCoupons(sub, cs, from).map((coupon) => coupon.coupon_id);
    const preview = previewInvoice(cs, null, lines, coupons);
    return {
      created_at: now,
      object: "estimate",
      subscription_estimate: {
        id: sub.cb_id,
        currency_code: sub.currency_code,
        status: sub.status,
        next_billing_at: sub.next_billing_at ?? undefined,
        object: "subscription_estimate",
      },
      invoice_estimate: invoiceEstimate(
        sub.currency_code,
        preview.lines,
        preview.discounts,
        preview.sub_total,
        preview.total,
        true,
        sub.customer_id,
      ),
      credit_note_estimates: [],
      unbilled_charge_estimates: [],
    };
  }

  app.get(
    "/api/v2/subscriptions/:id/renewal_estimate",
    api(cs, (c) => c.json({ estimate: renewalEstimate(findSubscription(cs, c.req.param("id"))) })),
  );

  app.post(
    "/api/v2/estimates/update_subscription_for_items",
    api(cs, async (c) => {
      const body = await parseChargebeeBody(c);
      const subscriptionBody = nested(body, "subscription");
      const subscriptionId = str(subscriptionBody.id);
      if (!subscriptionId) throw blankParamError("subscription[id]");
      const sub = findSubscription(cs, subscriptionId);
      const now = nowSeconds(cs);
      const requested = parseItemRequests(body);
      let newItems: SubscriptionItem[] = sub.subscription_items;
      if (requested.length > 0) {
        if (bool(body.replace_items_list)) {
          newItems = resolveItems(cs, requested);
        } else {
          const merged = new Map(
            sub.subscription_items.map((item) => [
              item.item_price_id,
              { item_price_id: item.item_price_id, quantity: item.quantity, unit_price: item.unit_price },
            ]),
          );
          for (const row of requested) {
            const incomingPlan = cs.itemPrices.findOneBy("cb_id", row.item_price_id)?.item_type === "plan";
            if (incomingPlan) {
              for (const key of [...merged.keys()]) {
                if (cs.itemPrices.findOneBy("cb_id", key)?.item_type === "plan" && key !== row.item_price_id)
                  merged.delete(key);
              }
            }
            const existing = merged.get(row.item_price_id);
            merged.set(row.item_price_id, {
              item_price_id: row.item_price_id,
              quantity: row.quantity ?? existing?.quantity ?? 1,
              unit_price: row.unit_price ?? existing?.unit_price ?? 0,
            });
          }
          newItems = resolveItems(cs, [...merged.values()]);
        }
      }
      const itemsChanged = JSON.stringify(newItems) !== JSON.stringify(sub.subscription_items);
      const newCharges = newItems.filter(
        (item) =>
          item.item_type === "charge" &&
          !sub.subscription_items.some((old) => old.item_price_id === item.item_price_id),
      );
      const proration = computeProration(cs, sub, newItems, now, {
        prorate: bool(body.prorate) !== false && itemsChanged && !bool(body.end_of_term),
        newCharges,
        charges: parseCharges(body),
      });
      const chargeTotal = proration.lines.reduce((sum, line) => sum + line.amount, 0);
      const estimate: Json = {
        created_at: now,
        object: "estimate",
        subscription_estimate: {
          id: sub.cb_id,
          currency_code: sub.currency_code,
          status: sub.status,
          next_billing_at: sub.next_billing_at ?? undefined,
          object: "subscription_estimate",
        },
        credit_note_estimates: [],
        unbilled_charge_estimates: [],
      };
      if (chargeTotal > 0 && chargeTotal > proration.credits) {
        const discounts: InvoiceDiscount[] =
          proration.credits > 0
            ? [
                {
                  amount: proration.credits,
                  description: "Prorated Credits",
                  entity_type: "prorated_credits",
                  entity_id: null,
                },
              ]
            : [];
        estimate.invoice_estimate = invoiceEstimate(
          sub.currency_code,
          proration.lines,
          discounts,
          chargeTotal,
          chargeTotal - proration.credits,
          true,
          sub.customer_id,
        );
      } else if (proration.credits > chargeTotal) {
        estimate.credit_note_estimates = [
          {
            reference_invoice_id: cs.invoices.findBy("subscription_id", sub.cb_id).sort((a, b) => b.id - a.id)[0]
              ?.cb_id,
            type: "refundable",
            price_type: "tax_exclusive",
            currency_code: sub.currency_code,
            sub_total: proration.credits - chargeTotal,
            total: proration.credits - chargeTotal,
            amount_allocated: 0,
            amount_available: proration.credits - chargeTotal,
            object: "credit_note_estimate",
            line_items: adhocLines(
              [{ amount: proration.credits - chargeTotal, description: "Prorated Credits" }],
              sub.customer_id,
              sub.cb_id,
              now,
            ).map(formatLineItem),
            discounts: [],
            taxes: [],
            line_item_taxes: [],
          },
        ];
      }
      const renewal = renewalEstimate({ ...sub, subscription_items: newItems });
      estimate.next_invoice_estimate = renewal.invoice_estimate;
      return c.json({ estimate });
    }),
  );

  app.post(
    "/api/v2/subscriptions/:id/cancel_subscription_for_items_estimate",
    api(cs, async (c) => {
      const sub = findSubscription(cs, c.req.param("id"));
      const body = await parseChargebeeBody(c);
      const now = nowSeconds(cs);
      const endOfTerm = bool(body.end_of_term) ?? false;
      const creditOption = str(body.credit_option_for_current_term_charges) ?? "none";
      const estimate: Json = {
        created_at: now,
        object: "estimate",
        subscription_estimate: {
          id: sub.cb_id,
          currency_code: sub.currency_code,
          status: endOfTerm ? "non_renewing" : "cancelled",
          next_billing_at: endOfTerm ? (sub.current_term_end ?? undefined) : undefined,
          object: "subscription_estimate",
        },
        credit_note_estimates: [],
        unbilled_charge_estimates: [],
      };
      if (!endOfTerm && creditOption !== "none" && sub.status === "active") {
        const invoice = cs.invoices
          .findBy("subscription_id", sub.cb_id)
          .filter((candidate) => candidate.recurring && candidate.status === "paid")
          .sort((a, b) => b.id - a.id)[0];
        if (invoice) {
          const recurringTotal = invoice.line_items
            .filter((line) => line.entity_type !== "charge_item_price" && line.entity_type !== "adhoc")
            .reduce((sum, line) => sum + line.amount - line.discount_amount, 0);
          const amount =
            creditOption === "full" ? recurringTotal : roundMoney(recurringTotal * prorationRatio(sub, now));
          if (amount > 0) {
            estimate.credit_note_estimates = [
              {
                reference_invoice_id: invoice.cb_id,
                type: "refundable",
                price_type: "tax_exclusive",
                currency_code: sub.currency_code,
                sub_total: amount,
                total: amount,
                amount_allocated: 0,
                amount_available: amount,
                object: "credit_note_estimate",
                line_items: adhocLines(
                  [{ amount, description: "Prorated Credits" }],
                  sub.customer_id,
                  sub.cb_id,
                  now,
                ).map(formatLineItem),
                discounts: [],
                taxes: [],
                line_item_taxes: [],
              },
            ];
          }
        }
      }
      return c.json({ estimate });
    }),
  );

  app.post(
    "/api/v2/estimates/create_invoice_for_items",
    api(cs, async (c) => {
      const body = await parseChargebeeBody(c);
      const now = nowSeconds(cs);
      const customerId = str(body.customer_id);
      const customer = customerId ? findCustomer(cs, customerId) : null;
      const items = parseItemRequests(body, "item_prices").map((row) => {
        const ip = cs.itemPrices.findOneBy("cb_id", row.item_price_id);
        if (!ip) throw blankParamError("item_prices[item_price_id][0]");
        const quantity = ip.pricing_model === "flat_fee" ? 1 : (row.quantity ?? 1);
        const unit = row.unit_price ?? ip.price ?? 0;
        return {
          item_price_id: ip.cb_id,
          item_type: ip.item_type,
          quantity,
          unit_price: unit,
          amount: ip.pricing_model === "flat_fee" ? unit : unit * quantity,
          free_quantity: ip.free_quantity,
        } satisfies SubscriptionItem;
      });
      const lines = [
        ...linesForItems(cs, items, customer?.cb_id ?? "", null, now, now, true),
        ...adhocLines(parseCharges(body), customer?.cb_id ?? "", null, now),
      ];
      const preview = previewInvoice(cs, customer, lines, stringList(body.coupon_ids));
      const currency =
        str(body.currency_code)?.toUpperCase() ??
        (items[0]
          ? cs.itemPrices.findOneBy("cb_id", items[0].item_price_id)!.currency_code
          : customer?.preferred_currency_code) ??
        "USD";
      return c.json({
        estimate: {
          created_at: now,
          object: "estimate",
          invoice_estimate: invoiceEstimate(
            currency,
            preview.lines,
            preview.discounts,
            preview.sub_total,
            preview.total,
            false,
            customer?.cb_id,
          ),
          credit_note_estimates: [],
          unbilled_charge_estimates: [],
        },
      });
    }),
  );
}
