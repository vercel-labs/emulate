import type { ChargebeeCustomer, EventSource } from "../entities.js";
import type { ChargebeeCtx } from "../events.js";
import { collectInvoice } from "../billing.js";
import { addCardPaymentSource, type CardInput } from "../cards.js";
import { customerRow, formatCard, formatPaymentSource, formatTransaction } from "../formatters.js";
import {
  bool,
  chargebeeList,
  duplicateError,
  invalidStateError,
  jsonValue,
  parseChargebeeBody,
  num,
  paramError,
  paymentError,
  pickAddress,
  pickCustomFields,
  str,
  strOrNull,
  type Body,
} from "../helpers.js";
import { chargebeeId, prefixedId } from "../ids.js";
import { nowSeconds, resourceVersion } from "../store.js";
import { api, findCustomer, findPaymentSource, nested, type ChargebeeRouteContext } from "../route-utils.js";

export function cardInputFrom(value: unknown): CardInput | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const card = value as Body;
  return {
    number: str(card.number),
    expiry_month: num(card.expiry_month),
    expiry_year: num(card.expiry_year),
    first_name: strOrNull(card.first_name),
    last_name: strOrNull(card.last_name),
  };
}

export function parseCustomerFields(body: Body): Partial<ChargebeeCustomer> {
  const fields: Partial<ChargebeeCustomer> = {};
  const assign = <K extends keyof ChargebeeCustomer>(key: K, value: ChargebeeCustomer[K] | undefined) => {
    if (value !== undefined) fields[key] = value;
  };
  if (body.first_name !== undefined) assign("first_name", strOrNull(body.first_name));
  if (body.last_name !== undefined) assign("last_name", strOrNull(body.last_name));
  if (body.email !== undefined) {
    const email = strOrNull(body.email);
    if (email && !email.includes("@")) throw paramError("email", "is not a valid email address");
    assign("email", email);
  }
  if (body.company !== undefined) assign("company", strOrNull(body.company));
  if (body.phone !== undefined) assign("phone", strOrNull(body.phone));
  if (body.locale !== undefined) assign("locale", strOrNull(body.locale));
  if (body.vat_number !== undefined) assign("vat_number", strOrNull(body.vat_number));
  if (body.preferred_currency_code !== undefined)
    assign("preferred_currency_code", strOrNull(body.preferred_currency_code));
  if (body.auto_collection !== undefined) {
    const value = str(body.auto_collection);
    if (value !== "on" && value !== "off") throw paramError("auto_collection", "must be on or off");
    assign("auto_collection", value);
  }
  if (body.net_term_days !== undefined) assign("net_term_days", num(body.net_term_days) ?? 0);
  if (body.allow_direct_debit !== undefined) assign("allow_direct_debit", bool(body.allow_direct_debit) ?? false);
  if (body.taxability !== undefined) {
    const value = str(body.taxability);
    if (value !== "taxable" && value !== "exempt") throw paramError("taxability", "must be taxable or exempt");
    assign("taxability", value);
  }
  if (body.billing_address !== undefined) assign("billing_address", pickAddress(body.billing_address));
  if (body.meta_data !== undefined) assign("meta_data", jsonValue(body.meta_data));
  const customFields = pickCustomFields(body);
  if (Object.keys(customFields).length > 0) assign("custom_fields", customFields);
  return fields;
}

export async function createCustomerFromBody(ctx: ChargebeeCtx, body: Body, source: EventSource = "api") {
  const { cs } = ctx;
  const id = str(body.id) ?? chargebeeId();
  if (cs.customers.findOneBy("cb_id", id)) throw duplicateError("id", id);
  const fields = parseCustomerFields(body);
  const customer = cs.customers.insert({
    cb_id: id,
    first_name: null,
    last_name: null,
    email: null,
    company: null,
    phone: null,
    locale: null,
    auto_collection: "on",
    net_term_days: 0,
    allow_direct_debit: false,
    taxability: "taxable",
    preferred_currency_code: null,
    billing_address: null,
    vat_number: null,
    meta_data: null,
    custom_fields: {},
    primary_payment_source_id: null,
    backup_payment_source_id: null,
    promotional_credits: 0,
    refundable_credits: 0,
    excess_payments: 0,
    unbilled_charges: 0,
    parent_id: null,
    payment_owner_id: null,
    invoice_owner_id: null,
    channel: "web",
    resource_version: resourceVersion(cs),
    deleted: false,
    ...fields,
  });
  const card = cardInputFrom(body.card);
  const paymentMethod = nested(body, "payment_method");
  if (card) {
    await addCardPaymentSource(ctx, customer, card, { source });
  } else if (str(paymentMethod.type) === "card" || body.token_id !== undefined) {
    await addCardPaymentSource(
      ctx,
      customer,
      {},
      { source, referenceId: str(paymentMethod.tmp_token) ?? str(body.token_id) },
    );
  }
  const created = cs.customers.get(customer.id)!;
  await ctx.emit("customer_created", customerRow(cs, created), source);
  return created;
}

function hierarchyEntries(rc: ChargebeeRouteContext, rootId: string) {
  const { cs } = rc;
  const entries: Array<Record<string, unknown>> = [];
  const queue = [rootId];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    if (seen.has(currentId)) continue;
    seen.add(currentId);
    const customer = cs.customers.findOneBy("cb_id", currentId);
    if (!customer) continue;
    const children = cs.customers.findBy("parent_id", customer.cb_id).map((child) => child.cb_id);
    entries.push({
      customer_id: customer.cb_id,
      parent_id: customer.parent_id ?? undefined,
      payment_owner_id: customer.payment_owner_id ?? customer.cb_id,
      invoice_owner_id: customer.invoice_owner_id ?? customer.cb_id,
      children_ids: children,
      object: "hierarchy",
    });
    queue.push(...children);
  }
  return entries;
}

export function customerRoutes(rc: ChargebeeRouteContext): void {
  const { app, cs, ctx } = rc;

  app.post(
    "/api/v2/customers",
    api(cs, async (c) => {
      const body = await parseChargebeeBody(c);
      const customer = await createCustomerFromBody(ctx, body);
      return c.json(customerRow(cs, customer));
    }),
  );

  app.get(
    "/api/v2/customers",
    api(cs, (c) =>
      chargebeeList(
        c,
        cs.customers.all().filter((customer) => !customer.deleted),
        "customer",
        (customer) => customerRow(cs, customer),
      ),
    ),
  );

  app.get(
    "/api/v2/customers/:id",
    api(cs, (c) => c.json(customerRow(cs, findCustomer(cs, c.req.param("id"))))),
  );

  app.post(
    "/api/v2/customers/:id",
    api(cs, async (c) => {
      const customer = findCustomer(cs, c.req.param("id"));
      const body = await parseChargebeeBody(c);
      const fields = parseCustomerFields(body);
      const updated = cs.customers.update(customer.id, {
        ...fields,
        custom_fields: { ...customer.custom_fields, ...(fields.custom_fields ?? {}) },
        resource_version: resourceVersion(cs),
      })!;
      await ctx.emit("customer_changed", customerRow(cs, updated));
      return c.json(customerRow(cs, updated));
    }),
  );

  app.post(
    "/api/v2/customers/:id/update_billing_info",
    api(cs, async (c) => {
      const customer = findCustomer(cs, c.req.param("id"));
      const body = await parseChargebeeBody(c);
      const updated = cs.customers.update(customer.id, {
        billing_address:
          body.billing_address !== undefined ? pickAddress(body.billing_address) : customer.billing_address,
        vat_number: body.vat_number !== undefined ? strOrNull(body.vat_number) : customer.vat_number,
        resource_version: resourceVersion(cs),
      })!;
      await ctx.emit("customer_changed", customerRow(cs, updated));
      return c.json(customerRow(cs, updated));
    }),
  );

  app.post(
    "/api/v2/customers/:id/update_payment_method",
    api(cs, async (c) => {
      const customer = findCustomer(cs, c.req.param("id"));
      const body = await parseChargebeeBody(c);
      const paymentMethod = nested(body, "payment_method");
      const source = await addCardPaymentSource(ctx, customer, cardInputFrom(body.card) ?? {}, {
        referenceId: str(paymentMethod.tmp_token) ?? str(paymentMethod.reference_id),
      });
      const refreshed = cs.customers.get(customer.id)!;
      return c.json({
        ...customerRow(cs, refreshed),
        card: formatCard(source),
        payment_source: formatPaymentSource(source),
      });
    }),
  );

  app.post(
    "/api/v2/customers/:id/assign_payment_role",
    api(cs, async (c) => {
      const customer = findCustomer(cs, c.req.param("id"));
      const body = await parseChargebeeBody(c);
      const sourceId = str(body.payment_source_id);
      if (!sourceId) throw paramError("payment_source_id", "cannot be blank");
      const source = findPaymentSource(cs, sourceId);
      if (source.customer_id !== customer.cb_id)
        throw paramError("payment_source_id", "does not belong to the customer");
      const role = str(body.role);
      if (role !== "primary" && role !== "backup" && role !== "none")
        throw paramError("role", "must be primary, backup or none");
      const updates: Partial<ChargebeeCustomer> = { resource_version: resourceVersion(cs) };
      if (role === "primary") {
        updates.primary_payment_source_id = source.cb_id;
        if (customer.backup_payment_source_id === source.cb_id) updates.backup_payment_source_id = null;
      } else if (role === "backup") {
        updates.backup_payment_source_id = source.cb_id;
        if (customer.primary_payment_source_id === source.cb_id) updates.primary_payment_source_id = null;
      } else {
        if (customer.primary_payment_source_id === source.cb_id) updates.primary_payment_source_id = null;
        if (customer.backup_payment_source_id === source.cb_id) updates.backup_payment_source_id = null;
      }
      const updated = cs.customers.update(customer.id, updates)!;
      await ctx.emit("customer_changed", customerRow(cs, updated));
      return c.json({ ...customerRow(cs, updated), payment_source: formatPaymentSource(source) });
    }),
  );

  const promotionalCredits = (type: "increment" | "decrement" | "set", eventType: string) =>
    api(cs, async (c) => {
      const customer = findCustomer(cs, c.req.param("id"));
      const body = await parseChargebeeBody(c);
      const amount = num(body.amount);
      if (amount === undefined || amount < 0) throw paramError("amount", "must be a non-negative number");
      const balance =
        type === "increment"
          ? customer.promotional_credits + amount
          : type === "decrement"
            ? Math.max(0, customer.promotional_credits - amount)
            : amount;
      const updated = cs.customers.update(customer.id, {
        promotional_credits: balance,
        preferred_currency_code: customer.preferred_currency_code ?? str(body.currency_code) ?? null,
        resource_version: resourceVersion(cs),
      })!;
      await ctx.emit(eventType, {
        ...customerRow(cs, updated),
        promotional_credit: {
          id: prefixedId("pc"),
          customer_id: updated.cb_id,
          type,
          amount,
          currency_code: str(body.currency_code) ?? updated.preferred_currency_code ?? "USD",
          description: str(body.description) ?? "",
          credit_type: "general",
          closing_balance: balance,
          created_at: nowSeconds(cs),
          object: "promotional_credit",
        },
      });
      return c.json(customerRow(cs, updated));
    });

  app.post(
    "/api/v2/customers/:id/add_promotional_credits",
    promotionalCredits("increment", "promotional_credits_added"),
  );
  app.post(
    "/api/v2/customers/:id/deduct_promotional_credits",
    promotionalCredits("decrement", "promotional_credits_deducted"),
  );
  app.post("/api/v2/customers/:id/set_promotional_credits", promotionalCredits("set", "promotional_credits_added"));

  app.post(
    "/api/v2/customers/:id/collect_payment",
    api(cs, async (c) => {
      const customer = findCustomer(cs, c.req.param("id"));
      const body = await parseChargebeeBody(c);
      const sourceId = str(body.payment_source_id);
      const paymentSource = sourceId ? findPaymentSource(cs, sourceId) : undefined;
      const due = cs.invoices
        .findBy("customer_id", customer.cb_id)
        .filter((invoice) => invoice.status !== "voided" && invoice.amount_due > 0)
        .sort((a, b) => a.date - b.date);
      if (due.length === 0) throw invalidStateError("Customer has no invoices with an amount due");
      let remaining = num(body.amount) ?? due.reduce((sum, invoice) => sum + invoice.amount_due, 0);
      let lastTransaction = null;
      for (const invoice of due) {
        if (remaining <= 0) break;
        const outcome = await collectInvoice(ctx, invoice, {
          paymentSource,
          amount: Math.min(remaining, invoice.amount_due),
          emitUpdated: true,
        });
        if (!outcome.ok && outcome.reason === "no_payment_source") {
          throw paymentError("Customer does not have a valid payment method", "payment_method_not_present");
        }
        if (!outcome.ok)
          throw paymentError("The payment was declined by the test gateway", "payment_processing_failed");
        remaining -= outcome.transaction?.amount ?? 0;
        lastTransaction = outcome.transaction;
      }
      const refreshed = cs.customers.get(customer.id)!;
      return c.json({
        ...customerRow(cs, refreshed),
        ...(lastTransaction ? { transaction: formatTransaction(lastTransaction) } : {}),
      });
    }),
  );

  app.post(
    "/api/v2/customers/:id/delete",
    api(cs, async (c) => {
      const customer = findCustomer(cs, c.req.param("id"));
      const snapshot = customerRow(cs, { ...customer, deleted: true });
      for (const sub of cs.subscriptions.findBy("customer_id", customer.cb_id)) cs.subscriptions.delete(sub.id);
      for (const invoice of cs.invoices.findBy("customer_id", customer.cb_id)) cs.invoices.delete(invoice.id);
      for (const txn of cs.transactions.findBy("customer_id", customer.cb_id)) cs.transactions.delete(txn.id);
      for (const cn of cs.creditNotes.findBy("customer_id", customer.cb_id)) cs.creditNotes.delete(cn.id);
      for (const ps of cs.paymentSources.findBy("customer_id", customer.cb_id)) cs.paymentSources.delete(ps.id);
      for (const child of cs.customers.findBy("parent_id", customer.cb_id)) {
        cs.customers.update(child.id, { parent_id: null, resource_version: resourceVersion(cs) });
      }
      cs.customers.delete(customer.id);
      await ctx.emit("customer_deleted", snapshot);
      return c.json(snapshot);
    }),
  );

  app.post(
    "/api/v2/customers/:id/clear_personal_data",
    api(cs, async (c) => {
      const customer = findCustomer(cs, c.req.param("id"));
      const updated = cs.customers.update(customer.id, {
        first_name: null,
        last_name: null,
        email: null,
        company: null,
        phone: null,
        billing_address: null,
        resource_version: resourceVersion(cs),
      })!;
      await ctx.emit("customer_changed", customerRow(cs, updated));
      return c.json(customerRow(cs, updated));
    }),
  );

  app.post(
    "/api/v2/customers/:id/relationships",
    api(cs, async (c) => {
      const customer = findCustomer(cs, c.req.param("id"));
      const body = await parseChargebeeBody(c);
      const parentId = body.parent_id !== undefined ? strOrNull(body.parent_id) : customer.parent_id;
      const paymentOwnerId =
        body.payment_owner_id !== undefined ? strOrNull(body.payment_owner_id) : customer.payment_owner_id;
      const invoiceOwnerId =
        body.invoice_owner_id !== undefined ? strOrNull(body.invoice_owner_id) : customer.invoice_owner_id;
      for (const [param, value] of [
        ["parent_id", parentId],
        ["payment_owner_id", paymentOwnerId],
        ["invoice_owner_id", invoiceOwnerId],
      ] as const) {
        if (value === null || value === customer.cb_id) continue;
        if (!cs.customers.findOneBy("cb_id", value))
          throw paramError(param, `${value} is not a valid customer id`, "resource_not_found");
      }
      if (parentId === customer.cb_id) throw paramError("parent_id", "cannot be the customer itself");
      let ancestor = parentId ? cs.customers.findOneBy("cb_id", parentId) : undefined;
      while (ancestor) {
        if (ancestor.cb_id === customer.cb_id) throw paramError("parent_id", "would create a cycle in the hierarchy");
        ancestor = ancestor.parent_id ? cs.customers.findOneBy("cb_id", ancestor.parent_id) : undefined;
      }
      const updated = cs.customers.update(customer.id, {
        parent_id: parentId,
        payment_owner_id: paymentOwnerId === customer.cb_id ? null : paymentOwnerId,
        invoice_owner_id: invoiceOwnerId === customer.cb_id ? null : invoiceOwnerId,
        resource_version: resourceVersion(cs),
      })!;
      await ctx.emit("customer_changed", customerRow(cs, updated));
      return c.json(customerRow(cs, updated));
    }),
  );

  app.post(
    "/api/v2/customers/:id/delete_relationship",
    api(cs, async (c) => {
      const customer = findCustomer(cs, c.req.param("id"));
      const updated = cs.customers.update(customer.id, {
        parent_id: null,
        payment_owner_id: null,
        invoice_owner_id: null,
        resource_version: resourceVersion(cs),
      })!;
      await ctx.emit("customer_changed", customerRow(cs, updated));
      return c.json(customerRow(cs, updated));
    }),
  );

  app.get(
    "/api/v2/customers/:id/hierarchy",
    api(cs, (c) => {
      const customer = findCustomer(cs, c.req.param("id"));
      let root = customer;
      const seen = new Set<string>();
      while (root.parent_id && !seen.has(root.cb_id)) {
        seen.add(root.cb_id);
        const parent = cs.customers.findOneBy("cb_id", root.parent_id);
        if (!parent) break;
        root = parent;
      }
      return c.json({ hierarchies: hierarchyEntries(rc, root.cb_id) });
    }),
  );

  app.post(
    "/api/v2/customers/:id/update_hierarchy_settings",
    api(cs, (c) => c.json(customerRow(cs, findCustomer(cs, c.req.param("id"))))),
  );
}
