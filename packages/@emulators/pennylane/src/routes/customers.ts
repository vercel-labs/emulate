import type { CustomerType, PlCustomer, PlSupplier } from "../entities.js";
import { formatCustomer, formatSupplier } from "../formatters.js";
import {
  address,
  api,
  bool,
  emailValid,
  listResponse,
  num,
  parseJsonBody,
  route,
  str,
  strOrNull,
  stringArray,
  unprocessable,
  type Body,
} from "../helpers.js";
import { logEvent, nextId } from "../store.js";
import { findCustomer, findSupplier, type PlRouteContext } from "../route-utils.js";

const CUSTOMER_FILTERS = {
  id: true,
  name: true,
  customer_type: true,
  external_reference: { operators: ["eq", "in"] },
  reg_no: true,
  vat_number: true,
  archived: true,
  created_at: true,
  updated_at: true,
} as const;
const CUSTOMER_SORT = ["id", "name", "created_at", "updated_at"];

function customerName(type: CustomerType, body: Body, current?: PlCustomer): string {
  if (type === "company") {
    const name = str(body.name)?.trim() ?? current?.name;
    if (!name) throw unprocessable("Validation failed", [{ field: "name", message: "can't be blank" }]);
    return name;
  }
  const first = str(body.first_name)?.trim() ?? current?.first_name ?? "";
  const last = str(body.last_name)?.trim() ?? current?.last_name ?? "";
  if (!first && !last) throw unprocessable("Validation failed", [{ field: "last_name", message: "can't be blank" }]);
  return `${first} ${last}`.trim();
}

function parseEmails(value: unknown, current: string[] = []): string[] {
  const emails = stringArray(value);
  if (emails === undefined) return current;
  for (const email of emails)
    if (!emailValid(email))
      throw unprocessable("Validation failed", [{ field: "emails", message: `${email} is not a valid email` }]);
  return emails;
}

export function customerRoutes(rc: PlRouteContext): void {
  const { app, ps, fmt } = rc;

  route(
    app,
    "get",
    "/customers",
    api(ps, (c) =>
      listResponse(
        c,
        [...ps.customers.all()].sort((a, b) => a.id - b.id).map((customer) => formatCustomer(fmt, customer)),
        { filters: CUSTOMER_FILTERS, sortable: CUSTOMER_SORT },
      ),
    ),
  );
  route(
    app,
    "get",
    "/company_customers",
    api(ps, (c) =>
      listResponse(
        c,
        ps.customers
          .all()
          .filter((customer) => customer.customer_type === "company")
          .map((customer) => formatCustomer(fmt, customer)),
        { filters: CUSTOMER_FILTERS, sortable: CUSTOMER_SORT },
      ),
    ),
  );
  route(
    app,
    "get",
    "/individual_customers",
    api(ps, (c) =>
      listResponse(
        c,
        ps.customers
          .all()
          .filter((customer) => customer.customer_type === "individual")
          .map((customer) => formatCustomer(fmt, customer)),
        { filters: CUSTOMER_FILTERS, sortable: CUSTOMER_SORT },
      ),
    ),
  );

  const createCustomer = (type: CustomerType) =>
    api(ps, async (c) => {
      const body = await parseJsonBody(c);
      const externalReference = strOrNull(body.external_reference);
      if (externalReference && ps.customers.findOneBy("external_reference", externalReference))
        throw unprocessable("Validation failed", [{ field: "external_reference", message: "has already been taken" }]);
      const customer = ps.customers.insert({
        pl_id: nextId(ps),
        customer_type: type,
        name: customerName(type, body),
        first_name: type === "individual" ? (str(body.first_name) ?? null) : null,
        last_name: type === "individual" ? (str(body.last_name) ?? null) : null,
        gender: type === "individual" ? strOrNull(body.gender) : null,
        reg_no: strOrNull(body.reg_no),
        vat_number: strOrNull(body.vat_number),
        emails: parseEmails(body.emails),
        phone: strOrNull(body.phone),
        billing_iban: strOrNull(body.billing_iban),
        billing_address: address(body.billing_address) ?? null,
        delivery_address: address(body.delivery_address) ?? null,
        recipient: strOrNull(body.recipient),
        reference: strOrNull(body.reference),
        notes: strOrNull(body.notes),
        payment_conditions: str(body.payment_conditions) ?? "30_days",
        billing_language: str(body.billing_language) ?? "fr_FR",
        external_reference: externalReference,
        archived: false,
      });
      logEvent(ps, "customer.created", String(customer.pl_id), { name: customer.name, customer_type: type });
      return c.json(formatCustomer(fmt, customer), 201);
    });
  route(app, "post", "/company_customers", createCustomer("company"));
  route(app, "post", "/individual_customers", createCustomer("individual"));
  route(app, "post", "/customers", createCustomer("company"));

  route(
    app,
    "get",
    "/customers/:id",
    api(ps, (c) => c.json(formatCustomer(fmt, findCustomer(ps, c.req.param("id"))))),
  );

  const updateCustomer = (expectedType?: CustomerType) =>
    api(ps, async (c) => {
      const customer = findCustomer(ps, c.req.param("id"));
      if (expectedType && customer.customer_type !== expectedType)
        throw unprocessable("Validation failed", [
          { field: "customer_type", message: `customer is not a ${expectedType} customer` },
        ]);
      const body = await parseJsonBody(c);
      const externalReference =
        body.external_reference !== undefined ? strOrNull(body.external_reference) : customer.external_reference;
      if (
        externalReference &&
        externalReference !== customer.external_reference &&
        ps.customers.findOneBy("external_reference", externalReference)
      )
        throw unprocessable("Validation failed", [{ field: "external_reference", message: "has already been taken" }]);
      const updates: Partial<PlCustomer> = {
        name: customerName(customer.customer_type, body, customer),
        first_name: body.first_name !== undefined ? strOrNull(body.first_name) : customer.first_name,
        last_name: body.last_name !== undefined ? strOrNull(body.last_name) : customer.last_name,
        gender: body.gender !== undefined ? strOrNull(body.gender) : customer.gender,
        reg_no: body.reg_no !== undefined ? strOrNull(body.reg_no) : customer.reg_no,
        vat_number: body.vat_number !== undefined ? strOrNull(body.vat_number) : customer.vat_number,
        emails: parseEmails(body.emails, customer.emails),
        phone: body.phone !== undefined ? strOrNull(body.phone) : customer.phone,
        billing_iban: body.billing_iban !== undefined ? strOrNull(body.billing_iban) : customer.billing_iban,
        billing_address: address(body.billing_address) ?? customer.billing_address,
        delivery_address: address(body.delivery_address) ?? customer.delivery_address,
        recipient: body.recipient !== undefined ? strOrNull(body.recipient) : customer.recipient,
        reference: body.reference !== undefined ? strOrNull(body.reference) : customer.reference,
        notes: body.notes !== undefined ? strOrNull(body.notes) : customer.notes,
        payment_conditions: str(body.payment_conditions) ?? customer.payment_conditions,
        billing_language: str(body.billing_language) ?? customer.billing_language,
        external_reference: externalReference,
        archived: bool(body.archived) ?? customer.archived,
      };
      const updated = ps.customers.update(customer.id, updates)!;
      logEvent(ps, "customer.updated", String(updated.pl_id), { name: updated.name });
      return c.json(formatCustomer(fmt, updated));
    });
  route(app, "put", "/company_customers/:id", updateCustomer("company"));
  route(app, "put", "/individual_customers/:id", updateCustomer("individual"));
  route(app, "put", "/customers/:id", updateCustomer());
  route(app, "patch", "/customers/:id", updateCustomer());

  route(
    app,
    "delete",
    "/customers/:id",
    api(ps, (c) => {
      const customer = findCustomer(ps, c.req.param("id"));
      if (ps.customerInvoices.findBy("customer_id", customer.pl_id).length > 0) {
        ps.customers.update(customer.id, { archived: true });
        return c.json(formatCustomer(fmt, ps.customers.get(customer.id)!));
      }
      ps.customers.delete(customer.id);
      logEvent(ps, "customer.deleted", String(customer.pl_id), { name: customer.name });
      return c.body(null, 204);
    }),
  );

  const SUPPLIER_FILTERS = {
    id: true,
    name: true,
    external_reference: { operators: ["eq", "in"] },
    reg_no: true,
    vat_number: true,
    archived: true,
    created_at: true,
    updated_at: true,
  } as const;

  route(
    app,
    "get",
    "/suppliers",
    api(ps, (c) =>
      listResponse(
        c,
        [...ps.suppliers.all()].sort((a, b) => a.id - b.id).map((supplier) => formatSupplier(fmt, supplier)),
        { filters: SUPPLIER_FILTERS, sortable: CUSTOMER_SORT },
      ),
    ),
  );

  route(
    app,
    "post",
    "/suppliers",
    api(ps, async (c) => {
      const body = await parseJsonBody(c);
      const name = str(body.name)?.trim();
      if (!name) throw unprocessable("Validation failed", [{ field: "name", message: "can't be blank" }]);
      const ledgerAccountId = num(body.ledger_account_id) ?? num((body.ledger_account as Body | undefined)?.id);
      if (ledgerAccountId !== undefined && !ps.ledgerAccounts.findOneBy("pl_id", ledgerAccountId))
        throw unprocessable("Validation failed", [{ field: "ledger_account_id", message: "ledger account not found" }]);
      const supplier = ps.suppliers.insert({
        pl_id: nextId(ps),
        name,
        reg_no: strOrNull(body.reg_no),
        vat_number: strOrNull(body.vat_number),
        iban: strOrNull(body.iban),
        emails: parseEmails(body.emails),
        billing_address: address(body.billing_address) ?? null,
        payment_conditions: str(body.payment_conditions) ?? "30_days",
        external_reference: strOrNull(body.external_reference),
        recipient: strOrNull(body.recipient),
        notes: strOrNull(body.notes),
        ledger_account_id: ledgerAccountId ?? null,
        archived: false,
      });
      logEvent(ps, "supplier.created", String(supplier.pl_id), { name });
      return c.json(formatSupplier(fmt, supplier), 201);
    }),
  );

  route(
    app,
    "get",
    "/suppliers/:id",
    api(ps, (c) => c.json(formatSupplier(fmt, findSupplier(ps, c.req.param("id"))))),
  );

  route(
    app,
    "put",
    "/suppliers/:id",
    api(ps, async (c) => {
      const supplier = findSupplier(ps, c.req.param("id"));
      const body = await parseJsonBody(c);
      const name = body.name !== undefined ? (str(body.name)?.trim() ?? "") : supplier.name;
      if (!name) throw unprocessable("Validation failed", [{ field: "name", message: "can't be blank" }]);
      const updates: Partial<PlSupplier> = {
        name,
        reg_no: body.reg_no !== undefined ? strOrNull(body.reg_no) : supplier.reg_no,
        vat_number: body.vat_number !== undefined ? strOrNull(body.vat_number) : supplier.vat_number,
        iban: body.iban !== undefined ? strOrNull(body.iban) : supplier.iban,
        emails: parseEmails(body.emails, supplier.emails),
        billing_address: address(body.billing_address) ?? supplier.billing_address,
        payment_conditions: str(body.payment_conditions) ?? supplier.payment_conditions,
        external_reference:
          body.external_reference !== undefined ? strOrNull(body.external_reference) : supplier.external_reference,
        recipient: body.recipient !== undefined ? strOrNull(body.recipient) : supplier.recipient,
        notes: body.notes !== undefined ? strOrNull(body.notes) : supplier.notes,
        ledger_account_id: num(body.ledger_account_id) ?? supplier.ledger_account_id,
        archived: bool(body.archived) ?? supplier.archived,
      };
      return c.json(formatSupplier(fmt, ps.suppliers.update(supplier.id, updates)!));
    }),
  );

  route(
    app,
    "delete",
    "/suppliers/:id",
    api(ps, (c) => {
      const supplier = findSupplier(ps, c.req.param("id"));
      ps.suppliers.delete(supplier.id);
      logEvent(ps, "supplier.deleted", String(supplier.pl_id), { name: supplier.name });
      return c.body(null, 204);
    }),
  );
}
