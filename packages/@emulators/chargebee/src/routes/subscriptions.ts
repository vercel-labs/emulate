import type { ChargebeeSubscription, SubscriptionStatus } from "../entities.js";
import {
  cancelSubscription,
  changeSubscription,
  changeTermEnd,
  createSubscription,
  generateTermInvoice,
  pauseSubscription,
  planItemPrice,
  reactivateSubscription,
  removeScheduledCancellation,
  resolveCoupons,
  resolveItems,
  resumeSubscription,
  subscriptionContent,
  type SubscriptionResult,
} from "../billing.js";
import { addCardPaymentSource } from "../cards.js";
import { formatCreditNote, formatInvoice, formatSubscription, subscriptionRow } from "../formatters.js";
import {
  addPeriod,
  blankParamError,
  bool,
  chargebeeList,
  duplicateError,
  invalidStateError,
  jsonValue,
  num,
  operationNotAllowedError,
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
  findSubscription,
  nested,
  parseCharges,
  parseItemRequests,
  type ChargebeeRouteContext,
} from "../route-utils.js";
import { cardInputFrom, createCustomerFromBody } from "./customers.js";

const STATUSES = new Set<string>(["future", "in_trial", "active", "non_renewing", "paused", "cancelled"]);

function subscriptionVirtual(cs: ChargebeeRouteContext["cs"]) {
  return (sub: ChargebeeSubscription) => ({
    item_price_id: sub.subscription_items.map((item) => item.item_price_id),
    item_id: sub.subscription_items.map((item) => cs.itemPrices.findOneBy("cb_id", item.item_price_id)?.item_id ?? ""),
    plan_id: sub.subscription_items
      .filter((item) => item.item_type === "plan")
      .map((item) => cs.itemPrices.findOneBy("cb_id", item.item_price_id)?.item_id ?? ""),
    plan_item_price_id: sub.subscription_items
      .filter((item) => item.item_type === "plan")
      .map((item) => item.item_price_id),
  });
}

function subscriptionResponse(rc: ChargebeeRouteContext, result: SubscriptionResult) {
  const { cs } = rc;
  return {
    ...subscriptionRow(cs, result.subscription),
    ...(result.invoice ? { invoice: formatInvoice(cs, result.invoice) } : {}),
    ...(result.creditNotes && result.creditNotes.length > 0
      ? { credit_notes: result.creditNotes.map((note) => formatCreditNote(note)) }
      : {}),
  };
}

function optionalTimestamp(body: Body, key: string): number | undefined {
  if (body[key] === undefined) return undefined;
  const value = num(body[key]);
  if (value === undefined) throw paramError(key, "must be a unix timestamp");
  return value;
}

function parseSubscriptionUpdates(body: Body, existing?: ChargebeeSubscription) {
  const updates: NonNullable<Parameters<typeof changeSubscription>[2]["updates"]> = {};
  if (body.auto_collection !== undefined) {
    const value = str(body.auto_collection);
    if (value !== "on" && value !== "off") throw paramError("auto_collection", "must be on or off");
    updates.auto_collection = value;
  }
  if (body.po_number !== undefined) updates.po_number = strOrNull(body.po_number);
  if (body.invoice_notes !== undefined) updates.invoice_notes = strOrNull(body.invoice_notes);
  if (body.shipping_address !== undefined) updates.shipping_address = pickAddress(body.shipping_address);
  if (body.meta_data !== undefined) updates.meta_data = jsonValue(body.meta_data);
  const customFields = pickCustomFields(body);
  if (Object.keys(customFields).length > 0)
    updates.custom_fields = { ...(existing?.custom_fields ?? {}), ...customFields };
  return updates;
}

export function subscriptionRoutes(rc: ChargebeeRouteContext): void {
  const { app, cs, ctx } = rc;

  const createForCustomer = api(cs, async (c) => {
    const customer = findCustomer(cs, c.req.param("id"));
    const body = await parseChargebeeBody(c);
    const card = cardInputFrom(body.card);
    if (card) await addCardPaymentSource(ctx, customer, card);
    const refreshed = cs.customers.get(customer.id)!;
    const result = await createSubscription(ctx, {
      customer: refreshed,
      id: str(body.id),
      items: parseItemRequests(body),
      couponIds: stringList(body.coupon_ids),
      trialEnd: optionalTimestamp(body, "trial_end"),
      startDate: optionalTimestamp(body, "start_date"),
      autoCollection: parseSubscriptionUpdates(body).auto_collection ?? null,
      poNumber: strOrNull(body.po_number),
      invoiceNotes: strOrNull(body.invoice_notes),
      metaData: jsonValue(body.meta_data),
      customFields: pickCustomFields(body),
      shippingAddress: pickAddress(body.shipping_address),
      invoiceImmediately: bool(body.invoice_immediately),
    });
    return c.json(subscriptionResponse(rc, result));
  });

  app.post("/api/v2/customers/:id/subscription_for_items", createForCustomer);

  app.post(
    "/api/v2/subscriptions/create_with_items",
    api(cs, async (c) => {
      const body = await parseChargebeeBody(c);
      const customerBody = nested(body, "customer");
      const customerId = str(customerBody.id);
      let customer = customerId ? cs.customers.findOneBy("cb_id", customerId) : undefined;
      if (!customer) {
        customer = await createCustomerFromBody(ctx, {
          ...customerBody,
          billing_address: body.billing_address ?? customerBody.billing_address,
          card: body.card,
          payment_method: body.payment_method,
          token_id: body.token_id,
        });
      } else if (body.card !== undefined) {
        await addCardPaymentSource(ctx, customer, cardInputFrom(body.card) ?? {});
        customer = cs.customers.get(customer.id)!;
      }
      const subscriptionBody = nested(body, "subscription");
      const result = await createSubscription(ctx, {
        customer,
        id: str(subscriptionBody.id) ?? str(body.id),
        items: parseItemRequests(body),
        couponIds: stringList(body.coupon_ids),
        trialEnd: optionalTimestamp(subscriptionBody, "trial_end") ?? optionalTimestamp(body, "trial_end"),
        startDate: optionalTimestamp(subscriptionBody, "start_date") ?? optionalTimestamp(body, "start_date"),
        autoCollection: parseSubscriptionUpdates(subscriptionBody).auto_collection ?? null,
        poNumber: strOrNull(subscriptionBody.po_number),
        invoiceNotes: strOrNull(subscriptionBody.invoice_notes),
        metaData: jsonValue(subscriptionBody.meta_data ?? body.meta_data),
        customFields: { ...pickCustomFields(body), ...pickCustomFields(subscriptionBody) },
        shippingAddress: pickAddress(body.shipping_address),
        invoiceImmediately: bool(body.invoice_immediately),
      });
      return c.json(subscriptionResponse(rc, result));
    }),
  );

  app.post(
    "/api/v2/customers/:id/import_for_items",
    api(cs, async (c) => {
      const customer = findCustomer(cs, c.req.param("id"));
      const body = await parseChargebeeBody(c);
      const id = str(body.id) ?? chargebeeId();
      if (cs.subscriptions.findOneBy("cb_id", id)) throw duplicateError("id", id);
      const items = resolveItems(cs, parseItemRequests(body));
      const plan = planItemPrice(cs, items);
      const now = nowSeconds(cs);
      const status = (str(body.status) ?? "active") as SubscriptionStatus;
      if (!STATUSES.has(status)) throw paramError("status", "is not a valid subscription status");
      const period = plan.period ?? 1;
      const periodUnit = plan.period_unit ?? "month";
      const termStart = optionalTimestamp(body, "current_term_start") ?? now;
      const termEnd = optionalTimestamp(body, "current_term_end") ?? addPeriod(termStart, period, periodUnit);
      const trialEnd = optionalTimestamp(body, "trial_end") ?? null;
      const startDate = optionalTimestamp(body, "start_date") ?? null;
      const inTerm = status === "active" || status === "non_renewing" || status === "paused";
      const coupons = resolveCoupons(cs, stringList(body.coupon_ids), termStart);
      const subscription = cs.subscriptions.insert({
        cb_id: id,
        customer_id: customer.cb_id,
        status,
        currency_code: plan.currency_code,
        subscription_items: items,
        coupons,
        billing_period: period,
        billing_period_unit: periodUnit,
        start_date: status === "future" ? (startDate ?? termStart) : null,
        trial_start: status === "in_trial" ? (optionalTimestamp(body, "trial_start") ?? now) : null,
        trial_end: status === "in_trial" ? (trialEnd ?? addPeriod(now, 14, "day")) : trialEnd,
        current_term_start: inTerm ? termStart : null,
        current_term_end: inTerm ? termEnd : null,
        next_billing_at:
          status === "active"
            ? termEnd
            : status === "non_renewing"
              ? (optionalTimestamp(body, "cancelled_at") ?? termEnd)
              : status === "in_trial"
                ? (trialEnd ?? addPeriod(now, 14, "day"))
                : status === "future"
                  ? (startDate ?? termStart)
                  : null,
        started_at: optionalTimestamp(body, "started_at") ?? (status === "future" ? null : termStart),
        activated_at: optionalTimestamp(body, "activated_at") ?? (inTerm ? termStart : null),
        cancelled_at:
          optionalTimestamp(body, "cancelled_at") ??
          (status === "cancelled" ? now : status === "non_renewing" ? termEnd : null),
        cancel_reason: null,
        cancel_reason_code: strOrNull(body.cancel_reason_code),
        cancel_schedule_created_at: status === "non_renewing" ? now : null,
        pause_date: optionalTimestamp(body, "pause_date") ?? (status === "paused" ? now : null),
        resume_date: optionalTimestamp(body, "resume_date") ?? null,
        auto_collection: parseSubscriptionUpdates(body).auto_collection ?? null,
        po_number: strOrNull(body.po_number),
        invoice_notes: strOrNull(body.invoice_notes),
        shipping_address: pickAddress(body.shipping_address),
        meta_data: jsonValue(body.meta_data),
        custom_fields: pickCustomFields(body),
        scheduled_changes: null,
        changes_scheduled_at: null,
        channel: "web",
        resource_version: resourceVersion(cs),
        deleted: false,
      });
      let result: SubscriptionResult = { subscription };
      if (bool(body.create_current_term_invoice) && inTerm) {
        const generated = await generateTermInvoice(ctx, subscription, termStart, termEnd, { includeCharges: false });
        result = { subscription: generated.subscription, invoice: generated.invoice };
      }
      return c.json(subscriptionResponse(rc, result));
    }),
  );

  app.get(
    "/api/v2/subscriptions",
    api(cs, (c) =>
      chargebeeList(
        c,
        cs.subscriptions.all().filter((sub) => !sub.deleted),
        "subscription",
        (sub) => subscriptionRow(cs, sub),
        { virtual: subscriptionVirtual(cs) },
      ),
    ),
  );

  app.get(
    "/api/v2/customers/:id/subscriptions",
    api(cs, (c) => {
      const customer = findCustomer(cs, c.req.param("id"));
      return chargebeeList(
        c,
        cs.subscriptions.findBy("customer_id", customer.cb_id).filter((sub) => !sub.deleted),
        "subscription",
        (sub) => subscriptionRow(cs, sub),
        { virtual: subscriptionVirtual(cs) },
      );
    }),
  );

  app.get(
    "/api/v2/subscriptions/:id",
    api(cs, (c) => c.json(subscriptionRow(cs, findSubscription(cs, c.req.param("id"))))),
  );

  app.get(
    "/api/v2/subscriptions/:id/retrieve_with_scheduled_changes",
    api(cs, (c) => {
      const sub = findSubscription(cs, c.req.param("id"));
      const withChanges = sub.scheduled_changes
        ? { ...sub, subscription_items: sub.scheduled_changes.subscription_items }
        : sub;
      return c.json(subscriptionRow(cs, withChanges));
    }),
  );

  app.post(
    "/api/v2/subscriptions/:id/remove_scheduled_changes",
    api(cs, async (c) => {
      const sub = findSubscription(cs, c.req.param("id"));
      if (!sub.scheduled_changes) throw invalidStateError("Subscription has no scheduled changes");
      const updated = cs.subscriptions.update(sub.id, {
        scheduled_changes: null,
        changes_scheduled_at: null,
        resource_version: resourceVersion(cs),
      })!;
      await ctx.emit("subscription_scheduled_changes_removed", subscriptionContent(cs, updated));
      return c.json(subscriptionRow(cs, updated));
    }),
  );

  app.post(
    "/api/v2/subscriptions/:id/remove_scheduled_cancellation",
    api(cs, async (c) => {
      const sub = findSubscription(cs, c.req.param("id"));
      const restored = await removeScheduledCancellation(ctx, sub);
      return c.json(subscriptionRow(cs, restored));
    }),
  );

  app.post(
    "/api/v2/subscriptions/:id/remove_coupons",
    api(cs, async (c) => {
      const sub = findSubscription(cs, c.req.param("id"));
      const body = await parseChargebeeBody(c);
      const remove = new Set(stringList(body.coupon_ids));
      const updated = cs.subscriptions.update(sub.id, {
        coupons: remove.size > 0 ? sub.coupons.filter((coupon) => !remove.has(coupon.coupon_id)) : [],
        resource_version: resourceVersion(cs),
      })!;
      await ctx.emit("subscription_changed", subscriptionContent(cs, updated));
      return c.json(subscriptionRow(cs, updated));
    }),
  );

  const update = api(cs, async (c) => {
    const sub = findSubscription(cs, c.req.param("id"));
    const body = await parseChargebeeBody(c);
    if (body.plan_id !== undefined || body.addons !== undefined) {
      throw operationNotAllowedError(
        "This operation is not applicable to Product Catalog 2.0 sites. Use update_for_items.",
      );
    }
    const result = await changeSubscription(ctx, sub, {
      items: parseItemRequests(body),
      charges: parseCharges(body),
      replaceItemsList: bool(body.replace_items_list) ?? false,
      prorate: bool(body.prorate),
      invoiceImmediately: bool(body.invoice_immediately),
      endOfTerm: bool(body.end_of_term) ?? false,
      couponIds: body.coupon_ids !== undefined ? stringList(body.coupon_ids) : undefined,
      replaceCouponList: bool(body.replace_coupon_list) ?? false,
      updates: parseSubscriptionUpdates(body, sub),
    });
    return c.json(subscriptionResponse(rc, result));
  });

  app.post("/api/v2/subscriptions/:id/update_for_items", update);
  app.post("/api/v2/subscriptions/:id", update);

  app.post(
    "/api/v2/subscriptions/:id/change_term_end",
    api(cs, async (c) => {
      const sub = findSubscription(cs, c.req.param("id"));
      const body = await parseChargebeeBody(c);
      const termEndsAt = num(body.term_ends_at);
      if (termEndsAt === undefined) throw blankParamError("term_ends_at");
      const changed = await changeTermEnd(ctx, sub, termEndsAt);
      return c.json(subscriptionRow(cs, changed));
    }),
  );

  app.post(
    "/api/v2/subscriptions/:id/reactivate",
    api(cs, async (c) => {
      const sub = findSubscription(cs, c.req.param("id"));
      const body = await parseChargebeeBody(c);
      const result = await reactivateSubscription(ctx, sub, {
        trialEnd: optionalTimestamp(body, "trial_end"),
        invoiceImmediately: bool(body.invoice_immediately),
      });
      return c.json(subscriptionResponse(rc, result));
    }),
  );

  const cancel = api(cs, async (c) => {
    const sub = findSubscription(cs, c.req.param("id"));
    const body = await parseChargebeeBody(c);
    const creditOption = str(body.credit_option_for_current_term_charges);
    if (
      creditOption !== undefined &&
      creditOption !== "none" &&
      creditOption !== "prorate" &&
      creditOption !== "full"
    ) {
      throw paramError("credit_option_for_current_term_charges", "must be none, prorate or full");
    }
    const result = await cancelSubscription(ctx, sub, {
      endOfTerm: bool(body.end_of_term) ?? false,
      cancelAt: optionalTimestamp(body, "cancel_at"),
      creditOption,
      reasonCode: strOrNull(body.cancel_reason_code),
    });
    return c.json(subscriptionResponse(rc, result));
  });

  app.post("/api/v2/subscriptions/:id/cancel_for_items", cancel);
  app.post("/api/v2/subscriptions/:id/cancel", cancel);

  app.post(
    "/api/v2/subscriptions/:id/pause",
    api(cs, async (c) => {
      const sub = findSubscription(cs, c.req.param("id"));
      const body = await parseChargebeeBody(c);
      const option = str(body.pause_option) ?? "immediately";
      if (option !== "immediately" && option !== "end_of_term" && option !== "specific_date") {
        throw paramError("pause_option", "must be immediately, end_of_term or specific_date");
      }
      const paused = await pauseSubscription(ctx, sub, {
        option,
        pauseDate: optionalTimestamp(body, "pause_date"),
        resumeDate: optionalTimestamp(body, "resume_date"),
      });
      return c.json(subscriptionRow(cs, paused));
    }),
  );

  app.post(
    "/api/v2/subscriptions/:id/resume",
    api(cs, async (c) => {
      const sub = findSubscription(cs, c.req.param("id"));
      const body = await parseChargebeeBody(c);
      const option = str(body.resume_option) ?? "immediately";
      if (option !== "immediately" && option !== "specific_date") {
        throw paramError("resume_option", "must be immediately or specific_date");
      }
      const result = await resumeSubscription(ctx, sub, { option, resumeDate: optionalTimestamp(body, "resume_date") });
      return c.json(subscriptionResponse(rc, result));
    }),
  );

  app.post(
    "/api/v2/subscriptions/:id/remove_scheduled_pause",
    api(cs, async (c) => {
      const sub = findSubscription(cs, c.req.param("id"));
      if (sub.status !== "active" || sub.pause_date === null)
        throw invalidStateError("Subscription has no scheduled pause");
      const updated = cs.subscriptions.update(sub.id, {
        pause_date: null,
        resume_date: null,
        resource_version: resourceVersion(cs),
      })!;
      await ctx.emit("subscription_scheduled_pause_removed", subscriptionContent(cs, updated));
      return c.json(subscriptionRow(cs, updated));
    }),
  );

  app.post(
    "/api/v2/subscriptions/:id/remove_scheduled_resumption",
    api(cs, async (c) => {
      const sub = findSubscription(cs, c.req.param("id"));
      if (sub.status !== "paused" || sub.resume_date === null)
        throw invalidStateError("Subscription has no scheduled resumption");
      const updated = cs.subscriptions.update(sub.id, { resume_date: null, resource_version: resourceVersion(cs) })!;
      await ctx.emit("subscription_scheduled_resumption_removed", subscriptionContent(cs, updated));
      return c.json(subscriptionRow(cs, updated));
    }),
  );

  app.post(
    "/api/v2/subscriptions/:id/delete",
    api(cs, async (c) => {
      const sub = findSubscription(cs, c.req.param("id"));
      const snapshot = subscriptionRow(cs, { ...sub, deleted: true });
      for (const invoice of cs.invoices.findBy("subscription_id", sub.cb_id)) cs.invoices.delete(invoice.id);
      for (const txn of cs.transactions.findBy("subscription_id", sub.cb_id)) cs.transactions.delete(txn.id);
      for (const cn of cs.creditNotes.all().filter((note) => note.subscription_id === sub.cb_id))
        cs.creditNotes.delete(cn.id);
      cs.subscriptions.delete(sub.id);
      await ctx.emit("subscription_deleted", snapshot);
      return c.json(snapshot);
    }),
  );

  app.get(
    "/api/v2/subscriptions/:id/discounts",
    api(cs, (c) => {
      const sub = findSubscription(cs, c.req.param("id"));
      const discounts = sub.coupons.map((coupon) => {
        const entity = cs.coupons.findOneBy("cb_id", coupon.coupon_id);
        return {
          discount: {
            id: `dc_${coupon.coupon_id}`,
            invoice_name: entity?.invoice_name ?? entity?.name ?? coupon.coupon_id,
            type: entity?.discount_type ?? "percentage",
            percentage: entity?.discount_percentage ?? undefined,
            amount: entity?.discount_amount ?? undefined,
            currency_code: entity?.currency_code ?? sub.currency_code,
            duration_type: entity?.duration_type ?? "forever",
            apply_on: entity?.apply_on ?? "invoice_amount",
            coupon_id: coupon.coupon_id,
            applied_count: coupon.applied_count,
            apply_till: coupon.apply_till ?? undefined,
            object: "discount",
          },
        };
      });
      return c.json({ list: discounts });
    }),
  );

  app.get(
    "/api/v2/subscriptions/:id/contract_terms",
    api(cs, (c) => {
      findSubscription(cs, c.req.param("id"));
      return c.json({ list: [] });
    }),
  );

  app.post(
    "/api/v2/subscriptions/:id/add_charge_at_term_end",
    api(cs, async (c) => {
      const sub = findSubscription(cs, c.req.param("id"));
      const body = await parseChargebeeBody(c);
      const amount = num(body.amount);
      if (amount === undefined) throw blankParamError("amount");
      const customer = findCustomer(cs, sub.customer_id);
      cs.customers.update(customer.id, {
        unbilled_charges: customer.unbilled_charges + amount,
        resource_version: resourceVersion(cs),
      });
      return c.json({
        ...subscriptionRow(cs, sub),
        estimate: {
          created_at: nowSeconds(cs),
          object: "estimate",
          unbilled_charge_estimates: [
            {
              subscription_id: sub.cb_id,
              customer_id: sub.customer_id,
              amount,
              description: str(body.description) ?? "Charge",
              entity_type: "adhoc",
              currency_code: sub.currency_code,
              object: "unbilled_charge_estimate",
            },
          ],
        },
      });
    }),
  );

  app.get(
    "/api/v2/subscriptions/:id/retrieve_advance_invoice_schedule",
    api(cs, (c) => {
      findSubscription(cs, c.req.param("id"));
      return c.json({ list: [] });
    }),
  );

  app.get(
    "/api/v2/subscriptions/:id/usages",
    api(cs, (c) => {
      findSubscription(cs, c.req.param("id"));
      return c.json({ list: [] });
    }),
  );

  app.post(
    "/api/v2/subscriptions/:id/override_billing_profile",
    api(cs, async (c) => {
      const sub = findSubscription(cs, c.req.param("id"));
      const body = await parseChargebeeBody(c);
      const updates = parseSubscriptionUpdates(body, sub);
      const updated = cs.subscriptions.update(sub.id, { ...updates, resource_version: resourceVersion(cs) })!;
      await ctx.emit("subscription_changed", subscriptionContent(cs, updated));
      return c.json(subscriptionRow(cs, updated));
    }),
  );

  app.get(
    "/api/v2/subscriptions/:id/summary",
    api(cs, (c) => c.json({ subscription: formatSubscription(cs, findSubscription(cs, c.req.param("id"))) })),
  );
}
