import { formatCompany, formatCustomerInvoice, invoiceTotals } from "../formatters.js";
import { api, num, parseJsonBody, route, str, type Body } from "../helpers.js";
import { appendixContentTypes, logEvent, nextId, setAppendixContentTypes } from "../store.js";
import { type PlRouteContext } from "../route-utils.js";
import { createCustomerInvoice } from "./customer-invoices.js";

export function miscRoutes(rc: PlRouteContext): void {
  const { app, ps, fmt } = rc;

  route(
    app,
    "get",
    "/me",
    api(ps, (c, key) =>
      c.json({
        user: { id: 1, email: "api@emulate.local", first_name: "API", last_name: key.description },
        company: formatCompany(fmt),
        token: {
          description: key.description,
          created_at: key.created_at,
          scopes: [
            "customers",
            "suppliers",
            "products",
            "customer_invoices",
            "supplier_invoices",
            "transactions",
            "accounting",
          ],
        },
      }),
    ),
  );

  route(
    app,
    "get",
    "/company",
    api(ps, (c) => c.json(formatCompany(fmt))),
  );

  app.post("/_pennylane/simulate/chargebee-invoice", async (c) => {
    const body = await parseJsonBody(c);
    const invoiceNumber = str(body.invoice_number) ?? str(body.chargebee_invoice_id) ?? str(body.id);
    if (!invoiceNumber) return c.json({ message: "invoice_number is required" }, 400);
    if (ps.customerInvoices.findOneBy("invoice_number", invoiceNumber))
      return c.json({ message: `An invoice numbered ${invoiceNumber} already exists` }, 409);
    const customer = resolveCustomer(body);
    const amount = num(body.amount) ?? num(body.total) ?? 120;
    const cents = bodyLooksLikeCents(body) ? amount / 100 : amount;
    const vatRate = str(body.vat_rate) ?? "FR_200";
    const rate = vatRate === "FR_200" ? 0.2 : vatRate === "FR_100" ? 0.1 : vatRate === "FR_55" ? 0.055 : 0;
    const lines = Array.isArray(body.invoice_lines)
      ? body.invoice_lines
      : [
          {
            label: str(body.label) ?? `Chargebee invoice ${invoiceNumber}`,
            quantity: 1,
            raw_currency_unit_price: cents / (1 + rate),
            vat_rate: vatRate,
          },
        ];
    try {
      const invoice = createCustomerInvoice(ps, {
        body: {
          invoice_number: invoiceNumber,
          external_reference: str(body.external_reference) ?? invoiceNumber,
          customer_id: customer.pl_id,
          date: str(body.date) ?? new Date().toISOString().slice(0, 10),
          deadline: str(body.deadline),
          currency: str(body.currency) ?? "EUR",
          label: str(body.label) ?? `${customer.name} - ${invoiceNumber}`,
          paid: body.paid,
          invoice_lines: lines,
          file: str(body.file),
          filename: str(body.filename) ?? `${invoiceNumber}.pdf`,
        },
        imported: true,
        draft: false,
      });
      logEvent(ps, "chargebee.synced", String(invoice.pl_id), {
        invoice_number: invoiceNumber,
        customer: customer.name,
        amount: invoiceTotals(invoice).total,
      });
      return c.json(formatCustomerInvoice(fmt, invoice), 201);
    } catch (error) {
      const status =
        error instanceof Error && "status" in error ? ((error as { status: number }).status as 400 | 404 | 422) : 400;
      return c.json(
        {
          message: error instanceof Error ? error.message : "Unable to create invoice",
          ...(error instanceof Error && "errors" in error ? { errors: (error as { errors: unknown }).errors } : {}),
        },
        status,
      );
    }
  });

  app.post("/_pennylane/simulate/appendix-content-types", async (c) => {
    const body = await parseJsonBody(c);
    const types = Array.isArray(body.content_types)
      ? body.content_types.map(String).map((type) => type.toLowerCase())
      : null;
    if (!types || types.length === 0) return c.json({ message: "content_types must be a non-empty array" }, 400);
    setAppendixContentTypes(ps, types);
    return c.json({ content_types: types });
  });

  app.get("/_pennylane/simulate/appendix-content-types", (c) => c.json({ content_types: appendixContentTypes(ps) }));

  app.get("/_pennylane/events", (c) => {
    const type = c.req.query("type");
    const limit = Math.min(Number(c.req.query("limit") ?? 100), 1000);
    const events = [...ps.events.all()]
      .filter((event) => !type || event.type === type)
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
    return c.json({
      events: events.map((event) => ({
        id: event.id,
        type: event.type,
        subject: event.subject,
        detail: event.detail,
        created_at: event.created_at,
      })),
    });
  });

  app.delete("/_pennylane/events", (c) => {
    ps.events.clear();
    return c.json({ ok: true });
  });

  function resolveCustomer(body: Body) {
    const id = num(body.customer_id);
    const byId = id !== undefined ? ps.customers.findOneBy("pl_id", id) : undefined;
    if (byId) return byId;
    const reference = str(body.customer_external_reference) ?? str(body.chargebee_customer_id);
    const byReference = reference ? ps.customers.findOneBy("external_reference", reference) : undefined;
    if (byReference) return byReference;
    const name = str(body.customer_name) ?? str(body.customer) ?? reference ?? "Chargebee customer";
    const byName = ps.customers.all().find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    if (byName) return byName;
    const created = ps.customers.insert({
      pl_id: nextId(ps),
      customer_type: "company",
      name,
      first_name: null,
      last_name: null,
      gender: null,
      reg_no: null,
      vat_number: null,
      emails: str(body.customer_email) ? [String(body.customer_email)] : [],
      phone: null,
      billing_iban: null,
      billing_address: null,
      delivery_address: null,
      recipient: null,
      reference: null,
      notes: "Created by the Chargebee sync simulator",
      payment_conditions: "30_days",
      billing_language: "fr_FR",
      external_reference: reference ?? null,
      archived: false,
    });
    logEvent(ps, "customer.created", String(created.pl_id), { name, source: "chargebee-sync" });
    return created;
  }

  function bodyLooksLikeCents(body: Body): boolean {
    return body.amount_cents !== undefined || body.total_cents !== undefined || str(body.unit) === "cents";
  }
}
