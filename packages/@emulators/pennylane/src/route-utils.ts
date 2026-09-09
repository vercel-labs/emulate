import type { AppEnv, Context, Hono } from "@emulators/core";
import type {
  PlAppendix,
  PlCategoryWeight,
  PlCustomer,
  PlCustomerInvoice,
  PlInvoiceLine,
  PlSupplier,
  PlSupplierInvoice,
  PlTransaction,
} from "./entities.js";
import type { Fmt } from "./formatters.js";
import { badRequest, notFound, num, obj, requireInt, str, strOrNull, unprocessable, type Body } from "./helpers.js";
import { appendixContentTypes, logEvent, nextId, type PlStore } from "./store.js";

export interface PlRouteContext {
  app: Hono<AppEnv>;
  ps: PlStore;
  fmt: Fmt;
  baseUrl: string;
}

export function findCustomer(ps: PlStore, id: string | number): PlCustomer {
  const customer = ps.customers.findOneBy("pl_id", typeof id === "number" ? id : requireInt(id, "Customer"));
  if (!customer) throw notFound("Customer not found");
  return customer;
}

export function findSupplier(ps: PlStore, id: string | number): PlSupplier {
  const supplier = ps.suppliers.findOneBy("pl_id", typeof id === "number" ? id : requireInt(id, "Supplier"));
  if (!supplier) throw notFound("Supplier not found");
  return supplier;
}

export function findCustomerInvoice(ps: PlStore, id: string | number): PlCustomerInvoice {
  const invoice = ps.customerInvoices.findOneBy(
    "pl_id",
    typeof id === "number" ? id : requireInt(id, "Customer invoice"),
  );
  if (!invoice) throw notFound("Customer invoice not found");
  return invoice;
}

export function findSupplierInvoice(ps: PlStore, id: string | number): PlSupplierInvoice {
  const invoice = ps.supplierInvoices.findOneBy(
    "pl_id",
    typeof id === "number" ? id : requireInt(id, "Supplier invoice"),
  );
  if (!invoice) throw notFound("Supplier invoice not found");
  return invoice;
}

export function findTransaction(ps: PlStore, id: string | number): PlTransaction {
  const transaction = ps.transactions.findOneBy("pl_id", typeof id === "number" ? id : requireInt(id, "Transaction"));
  if (!transaction) throw notFound("Transaction not found");
  return transaction;
}

export const VAT_RATES = [
  "FR_200",
  "FR_100",
  "FR_85",
  "FR_55",
  "FR_21",
  "FR_0",
  "exempt",
  "EU_reverse_charge",
  "non_EU",
];

export function parseVatRate(value: unknown, fallback = "FR_200"): string {
  const text = str(value);
  if (text === undefined || text === "") return fallback;
  if (VAT_RATES.includes(text)) return text;
  const numeric = num(text);
  if (numeric !== undefined) {
    const code = `FR_${String(Math.round(numeric * 10)).replace(/\.0$/, "")}`;
    if (VAT_RATES.includes(code)) return code;
  }
  throw unprocessable("Validation failed", [{ field: "vat_rate", message: `must be one of ${VAT_RATES.join(", ")}` }]);
}

export function parseDiscount(value: unknown): PlCustomerInvoice["discount"] | undefined {
  if (value === undefined) return undefined;
  const record = obj(value);
  if (!record) return null;
  const type = str(record.type) === "absolute" ? "absolute" : "relative";
  const amount = num(record.value);
  if (amount === undefined || amount < 0)
    throw unprocessable("Validation failed", [{ field: "discount", message: "value must be a non-negative number" }]);
  return { type, value: amount };
}

export function parseInvoiceLines(ps: PlStore, value: unknown, field = "invoice_lines"): PlInvoiceLine[] {
  if (!Array.isArray(value) || value.length === 0)
    throw unprocessable("Validation failed", [{ field, message: "must contain at least one line" }]);
  return value.map((entry, index) => {
    const record = obj(entry) ?? {};
    const productId = num(record.product_id);
    const product = productId !== undefined ? ps.products.findOneBy("pl_id", productId) : undefined;
    if (productId !== undefined && !product)
      throw unprocessable("Validation failed", [
        { field: `${field}[${index}].product_id`, message: "product not found" },
      ]);
    const label = str(record.label)?.trim() || product?.label;
    if (!label)
      throw unprocessable("Validation failed", [{ field: `${field}[${index}].label`, message: "can't be blank" }]);
    const quantity = num(record.quantity) ?? 1;
    const unitPrice =
      num(record.raw_currency_unit_price) ??
      num(record.currency_unit_price) ??
      num(record.unit_price) ??
      product?.price_before_tax;
    if (unitPrice === undefined)
      throw unprocessable("Validation failed", [
        { field: `${field}[${index}].raw_currency_unit_price`, message: "can't be blank" },
      ]);
    return {
      id: nextId(ps),
      label,
      description: strOrNull(record.description) ?? product?.description ?? null,
      quantity,
      unit: str(record.unit) ?? product?.unit ?? "piece",
      raw_currency_unit_price: unitPrice,
      vat_rate: parseVatRate(record.vat_rate, product?.vat_rate ?? "FR_200"),
      discount: parseDiscount(record.discount) ?? null,
      product_id: product?.pl_id ?? null,
      ledger_account_id: num(record.ledger_account_id) ?? product?.ledger_account_id ?? null,
    };
  });
}

export function parseCategoryWeights(ps: PlStore, body: Body): PlCategoryWeight[] {
  const raw = body.categories;
  if (!Array.isArray(raw))
    throw unprocessable("Validation failed", [{ field: "categories", message: "must be an array of {id, weight}" }]);
  const weights = raw.map((entry, index) => {
    const record = obj(entry) ?? {};
    const id = num(record.id) ?? num(record.category_id);
    if (id === undefined || !ps.categories.findOneBy("pl_id", id))
      throw unprocessable("Validation failed", [{ field: `categories[${index}].id`, message: "category not found" }]);
    const weight = num(record.weight) ?? 1;
    if (weight <= 0 || weight > 1)
      throw unprocessable("Validation failed", [
        { field: `categories[${index}].weight`, message: "must be between 0 and 1" },
      ]);
    return { category_id: id, weight };
  });
  const total = weights.reduce((sum, entry) => sum + entry.weight, 0);
  if (weights.length > 0 && Math.abs(total - 1) > 0.001)
    throw unprocessable("Validation failed", [{ field: "categories", message: "weights must add up to 1" }]);
  return weights;
}

export function decodeFile(body: Body): {
  filename: string | null;
  content: string | null;
  content_type: string | null;
} {
  const raw = str(body.file);
  if (!raw) return { filename: strOrNull(body.filename), content: null, content_type: null };
  const dataUrl = raw.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (dataUrl)
    return {
      filename: strOrNull(body.filename) ?? "invoice.pdf",
      content: dataUrl[2] ? dataUrl[3] : Buffer.from(decodeURIComponent(dataUrl[3])).toString("base64"),
      content_type: dataUrl[1] ?? "application/pdf",
    };
  return {
    filename: strOrNull(body.filename) ?? "invoice.pdf",
    content: raw,
    content_type: str(body.content_type) ?? "application/pdf",
  };
}

export async function storeAppendix(
  c: Context,
  ps: PlStore,
  targetType: PlAppendix["target_type"],
  targetId: number,
): Promise<PlAppendix> {
  const contentType = c.req.header("content-type") ?? "";
  let filename = "";
  let type = "";
  let buffer: Buffer | null = null;
  if (contentType.includes("multipart/form-data")) {
    const form = await c.req.raw.formData();
    const file = form.get("file") ?? form.get("appendix") ?? form.get("attachment");
    if (!file || typeof file === "string")
      throw unprocessable("Validation failed", [{ field: "file", message: "must be a multipart file" }]);
    filename = file.name || "appendix";
    type = (file.type || "application/octet-stream").split(";")[0].trim().toLowerCase();
    buffer = Buffer.from(await file.arrayBuffer());
  } else {
    const body = await (async () => {
      try {
        return JSON.parse((await c.req.text()) || "{}") as Body;
      } catch {
        throw badRequest("Request body is not valid JSON");
      }
    })();
    const decoded = decodeFile(body);
    if (!decoded.content) throw unprocessable("Validation failed", [{ field: "file", message: "can't be blank" }]);
    filename = decoded.filename ?? "appendix";
    type = (decoded.content_type ?? "application/octet-stream").toLowerCase();
    buffer = Buffer.from(decoded.content, "base64");
  }
  const allowed = appendixContentTypes(ps);
  if (!allowed.includes(type))
    throw unprocessable("Validation failed", [
      { field: "file", message: `content type ${type} is not allowed (allowed: ${allowed.join(", ")})` },
    ]);
  if (buffer.byteLength === 0) throw unprocessable("Validation failed", [{ field: "file", message: "can't be empty" }]);
  const appendix = ps.appendices.insert({
    pl_id: nextId(ps),
    target_type: targetType,
    target_id: targetId,
    filename,
    content_type: type,
    size: buffer.byteLength,
    content: buffer.toString("base64"),
  });
  logEvent(ps, "appendix.created", String(appendix.pl_id), {
    target_type: targetType,
    target_id: targetId,
    filename,
    content_type: type,
    size: appendix.size,
  });
  return appendix;
}
