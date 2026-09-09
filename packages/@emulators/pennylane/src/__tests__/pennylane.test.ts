import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BANK_ACCOUNT_ID,
  DEFAULT_CHARGEBEE_INVOICE_ID,
  DEFAULT_CHARGEBEE_INVOICE_NUMBER,
  DEFAULT_CUSTOMER_ID,
  DEFAULT_DRAFT_INVOICE_ID,
  DEFAULT_MSP_CUSTOMER_ID,
  DEFAULT_OPEN_INVOICE_ID,
  DEFAULT_OPEN_INVOICE_NUMBER,
  DEFAULT_PAID_INVOICE_ID,
  DEFAULT_PAID_INVOICE_NUMBER,
  DEFAULT_SUPPLIER_ID,
  DEFAULT_SUPPLIER_INVOICE_ID,
  getPlStore,
} from "../index.js";
import { api, createPennylaneTestApp, filterQuery, pennylaneTestBaseUrl, type PennylaneTestApp } from "./helpers.js";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function fileForm(name: string, type: string, content = "%PDF-1.4 detail"): FormData {
  const form = new FormData();
  form.append("file", new Blob([content], { type }), name);
  return form;
}

describe("Pennylane plugin", () => {
  let ctx: PennylaneTestApp;

  beforeEach(() => {
    ctx = createPennylaneTestApp();
  });

  describe("authentication and paths", () => {
    it("requires a bearer API token", async () => {
      const missing = await api(ctx.app, "GET", "/customer_invoices", undefined, null);
      expect(missing.status).toBe(401);
      expect(missing.body.message).toContain("Unauthorized");
      expect((await api(ctx.app, "GET", "/customer_invoices", undefined, "wrong")).status).toBe(401);
    });

    it("serves the same routes with and without the /api/external/v2 prefix", async () => {
      const prefixed = await api(ctx.app, "GET", "/me");
      expect(prefixed.status).toBe(200);
      expect(prefixed.body.company.name).toBe("Emulate SAS");
      const short = await ctx.app.request(`${pennylaneTestBaseUrl}/v2/me`, {
        headers: { Authorization: "Bearer test_emulate_pennylane_api_key" },
      });
      expect(short.status).toBe(200);
      const bare = await ctx.app.request(`${pennylaneTestBaseUrl}/me`, {
        headers: { Authorization: "Bearer test_emulate_pennylane_api_key" },
      });
      expect(bare.status).toBe(200);
    });
  });

  describe("customer invoices (CyberHub flow)", () => {
    it("filters invoices by invoice_number with the JSON filter parameter", async () => {
      const found = await api(
        ctx.app,
        "GET",
        `/customer_invoices?${filterQuery([{ field: "invoice_number", operator: "eq", value: DEFAULT_CHARGEBEE_INVOICE_NUMBER }])}`,
      );
      expect(found.status).toBe(200);
      expect(found.body).toMatchObject({ has_more: false, next_cursor: null });
      expect(found.body.items).toHaveLength(1);
      expect(found.body.items[0]).toMatchObject({
        id: DEFAULT_CHARGEBEE_INVOICE_ID,
        invoice_number: DEFAULT_CHARGEBEE_INVOICE_NUMBER,
        external_reference: DEFAULT_CHARGEBEE_INVOICE_NUMBER,
        imported: true,
        amount: "1200.00",
        status: "upcoming",
      });
      const byReference = await api(
        ctx.app,
        "GET",
        `/customer_invoices?${filterQuery([{ field: "external_reference", operator: "eq", value: "cb_inv_0001" }])}`,
      );
      expect(byReference.body.items.map((invoice: any) => invoice.invoice_number)).toEqual([
        DEFAULT_PAID_INVOICE_NUMBER,
      ]);
      const none = await api(
        ctx.app,
        "GET",
        `/customer_invoices?${filterQuery([{ field: "invoice_number", operator: "eq", value: "INV-999" }])}`,
      );
      expect(none.body.items).toEqual([]);
      const badOperator = await api(
        ctx.app,
        "GET",
        `/customer_invoices?${filterQuery([{ field: "external_reference", operator: "contains", value: "cb" }])}`,
      );
      expect(badOperator.status).toBe(400);
      const badField = await api(
        ctx.app,
        "GET",
        `/customer_invoices?${filterQuery([{ field: "nope", operator: "eq", value: "x" }])}`,
      );
      expect(badField.status).toBe(400);
    });

    it("lists appendices and accepts allowed file types", async () => {
      const existing = await api(ctx.app, "GET", `/customer_invoices/${DEFAULT_PAID_INVOICE_ID}/appendices`);
      expect(existing.status).toBe(200);
      expect(existing.body.items).toHaveLength(1);
      expect(existing.body.items[0]).toMatchObject({
        filename: "detail-F-2026-0001.pdf",
        url: expect.stringContaining("/_pennylane/appendices/"),
      });
      const uploaded = await api(
        ctx.app,
        "POST",
        `/customer_invoices/${DEFAULT_OPEN_INVOICE_ID}/appendices`,
        fileForm("detail-F-2026-0002.pdf", "application/pdf"),
      );
      expect(uploaded.status).toBe(201);
      expect(uploaded.body).toMatchObject({ filename: "detail-F-2026-0002.pdf", content_type: "application/pdf" });
      expect(typeof uploaded.body.id).toBe("number");
      const listed = await api(ctx.app, "GET", `/customer_invoices/${DEFAULT_OPEN_INVOICE_ID}/appendices`);
      expect(listed.body.items.map((appendix: any) => appendix.filename)).toEqual(["detail-F-2026-0002.pdf"]);
      const download = await ctx.app.request(uploaded.body.url);
      expect(download.status).toBe(200);
      expect(download.headers.get("content-type")).toBe("application/pdf");
      expect(await download.text()).toBe("%PDF-1.4 detail");
      expect(
        (await api(ctx.app, "DELETE", `/customer_invoices/${DEFAULT_OPEN_INVOICE_ID}/appendices/${uploaded.body.id}`))
          .status,
      ).toBe(204);
      expect(
        (await api(ctx.app, "GET", `/customer_invoices/${DEFAULT_OPEN_INVOICE_ID}/appendices`)).body.items,
      ).toEqual([]);
      expect((await api(ctx.app, "GET", "/customer_invoices/999999/appendices")).status).toBe(404);
    });

    it("accepts XLSX and PDF appendices and rejects other types unless the seed allows them", async () => {
      const xlsx = await api(
        ctx.app,
        "POST",
        `/customer_invoices/${DEFAULT_OPEN_INVOICE_ID}/appendices`,
        fileForm("detail.xlsx", XLSX, "PK..."),
      );
      expect(xlsx.status).toBe(201);
      expect(xlsx.body.content_type).toBe(XLSX);
      const rejected = await api(
        ctx.app,
        "POST",
        `/customer_invoices/${DEFAULT_OPEN_INVOICE_ID}/appendices`,
        fileForm("archive.zip", "application/zip", "PK..."),
      );
      expect(rejected.status).toBe(422);
      expect(rejected.body.errors[0]).toMatchObject({ field: "file" });
      expect(rejected.body.errors[0].message).toContain("not allowed");
      const permissive = createPennylaneTestApp({ appendix_content_types: ["application/zip"] });
      const accepted = await api(
        permissive.app,
        "POST",
        `/customer_invoices/${DEFAULT_OPEN_INVOICE_ID}/appendices`,
        fileForm("archive.zip", "application/zip", "PK..."),
      );
      expect(accepted.status).toBe(201);
      const json = await api(ctx.app, "POST", `/customer_invoices/${DEFAULT_OPEN_INVOICE_ID}/appendices`, {
        filename: "note.png",
        content_type: "image/png",
        file: Buffer.from("png").toString("base64"),
      });
      expect(json.status).toBe(201);
      expect((await api(ctx.app, "POST", `/customer_invoices/${DEFAULT_OPEN_INVOICE_ID}/appendices`, {})).status).toBe(
        422,
      );
    });

    it("simulates the Chargebee integration syncing an invoice", async () => {
      const synced = await ctx.app.request(`${pennylaneTestBaseUrl}/_pennylane/simulate/chargebee-invoice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invoice_number: "INV-000456",
          customer_name: "Acme SAS",
          amount: 600,
          date: "2026-09-01",
        }),
      });
      expect(synced.status).toBe(201);
      const body = (await synced.json()) as any;
      expect(body).toMatchObject({
        invoice_number: "INV-000456",
        external_reference: "INV-000456",
        imported: true,
        amount: "600.00",
        customer: { id: DEFAULT_CUSTOMER_ID },
      });
      const found = await api(
        ctx.app,
        "GET",
        `/customer_invoices?${filterQuery([{ field: "invoice_number", operator: "eq", value: "INV-000456" }])}`,
      );
      expect(found.body.items[0].id).toBe(body.id);
      const duplicate = await ctx.app.request(`${pennylaneTestBaseUrl}/_pennylane/simulate/chargebee-invoice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoice_number: "INV-000456" }),
      });
      expect(duplicate.status).toBe(409);
      const newCustomer = await ctx.app.request(`${pennylaneTestBaseUrl}/_pennylane/simulate/chargebee-invoice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invoice_number: "INV-000789",
          chargebee_customer_id: "cb_new",
          customer_name: "New Co",
          amount_cents: 12000,
          amount: 12000,
        }),
      });
      expect(newCustomer.status).toBe(201);
      expect(((await newCustomer.json()) as any).amount).toBe("120.00");
      expect(
        (
          await api(
            ctx.app,
            "GET",
            `/customers?${filterQuery([{ field: "external_reference", operator: "eq", value: "cb_new" }])}`,
          )
        ).body.items[0].name,
      ).toBe("New Co");
    });

    it("pages with cursors and sorts", async () => {
      const first = await api(ctx.app, "GET", "/customer_invoices?limit=2&sort=date");
      expect(first.body.items).toHaveLength(2);
      expect(first.body.has_more).toBe(true);
      expect(first.body.next_cursor).toBeTruthy();
      const second = await api(ctx.app, "GET", `/customer_invoices?limit=2&sort=date&cursor=${first.body.next_cursor}`);
      expect(second.body.items).toHaveLength(2);
      expect(second.body.has_more).toBe(false);
      const ids = [...first.body.items, ...second.body.items].map((invoice: any) => invoice.id);
      expect(new Set(ids).size).toBe(4);
      expect(first.body.items[0].id).toBe(DEFAULT_PAID_INVOICE_ID);
      const desc = await api(ctx.app, "GET", "/customer_invoices?sort=-amount&limit=1");
      expect(desc.body.items[0].id).toBe(DEFAULT_CHARGEBEE_INVOICE_ID);
      expect((await api(ctx.app, "GET", "/customer_invoices?cursor=nope")).status).toBe(400);
      expect((await api(ctx.app, "GET", "/customer_invoices?sort=nope")).status).toBe(400);
    });

    it("reads invoice details, lines, categories, and files", async () => {
      const invoice = await api(ctx.app, "GET", `/customer_invoices/${DEFAULT_PAID_INVOICE_ID}`);
      expect(invoice.body).toMatchObject({
        invoice_number: DEFAULT_PAID_INVOICE_NUMBER,
        status: "paid",
        paid: true,
        amount: "540.00",
        amount_before_tax: "450.00",
        tax: "90.00",
        remaining_amount: "0.00",
        currency: "EUR",
      });
      expect(invoice.body.customer).toMatchObject({ id: DEFAULT_CUSTOMER_ID, name: "Acme SAS" });
      const lines = await api(ctx.app, "GET", `/customer_invoices/${DEFAULT_PAID_INVOICE_ID}/invoice_lines`);
      expect(lines.body.items.map((line: any) => [line.label, line.quantity, line.currency_amount])).toEqual([
        ["Managed EDR - per endpoint", 25, "240.00"],
        ["SOC monitoring - monthly", 1, "300.00"],
      ]);
      const categories = await api(ctx.app, "GET", `/customer_invoices/${DEFAULT_PAID_INVOICE_ID}/categories`);
      expect(categories.body.items[0]).toMatchObject({ label: "Managed services", weight: 1 });
      const matched = await api(ctx.app, "GET", `/customer_invoices/${DEFAULT_PAID_INVOICE_ID}/matched_transactions`);
      expect(matched.body.items).toHaveLength(1);
      expect(matched.body.items[0].amount).toBe("540.00");
      const file = await ctx.app.request(invoice.body.public_file_url);
      expect(file.status).toBe(200);
      expect(file.headers.get("content-type")).toBe("application/pdf");
      expect((await api(ctx.app, "GET", "/customer_invoices/1")).status).toBe(404);
      expect((await api(ctx.app, "GET", "/customer_invoices/abc")).status).toBe(404);
    });

    it("creates drafts, finalizes them with sequential numbers, marks paid, and cancels with a credit note", async () => {
      const draft = await api(ctx.app, "POST", "/customer_invoices", {
        customer_id: DEFAULT_MSP_CUSTOMER_ID,
        date: "2026-09-05",
        invoice_lines: [
          { label: "Managed EDR - per endpoint", quantity: 10, raw_currency_unit_price: 8, vat_rate: "FR_200" },
          { product_id: (await api(ctx.app, "GET", "/products")).body.items[1].id, quantity: 1 },
        ],
        pdf_invoice_subject: "September services",
      });
      expect(draft.status).toBe(201);
      expect(draft.body).toMatchObject({
        draft: true,
        status: "draft",
        invoice_number: null,
        deadline: "2026-10-20",
        amount: "396.00",
      });
      const updated = await api(ctx.app, "PUT", `/customer_invoices/${draft.body.id}`, {
        invoice_lines: [{ label: "Managed EDR - per endpoint", quantity: 20, raw_currency_unit_price: 8 }],
      });
      expect(updated.body.amount).toBe("192.00");
      const finalized = await api(ctx.app, "POST", `/customer_invoices/${draft.body.id}/finalize`, {
        date: "2026-09-06",
      });
      expect(finalized.status).toBe(200);
      expect(finalized.body).toMatchObject({
        draft: false,
        invoice_number: "F-2026-0003",
        status: "upcoming",
        filename: "F-2026-0003.pdf",
      });
      expect((await api(ctx.app, "POST", `/customer_invoices/${draft.body.id}/finalize`)).status).toBe(422);
      expect((await api(ctx.app, "PUT", `/customer_invoices/${draft.body.id}`, { invoice_lines: [] })).status).toBe(
        422,
      );
      const referenced = await api(ctx.app, "PUT", `/customer_invoices/${draft.body.id}`, {
        external_reference: "cb_inv_0099",
      });
      expect(referenced.body.external_reference).toBe("cb_inv_0099");
      const partial = await api(ctx.app, "POST", `/customer_invoices/${draft.body.id}/mark_as_paid`, { amount: 100 });
      expect(partial.body).toMatchObject({ paid: false, remaining_amount: "92.00" });
      const paid = await api(ctx.app, "POST", `/customer_invoices/${draft.body.id}/mark_as_paid`);
      expect(paid.body).toMatchObject({ paid: true, status: "paid", remaining_amount: "0.00" });
      const sent = await api(ctx.app, "POST", `/customer_invoices/${draft.body.id}/send_by_email`, {});
      expect(sent.body.recipients).toEqual(["finance@nimbus.example"]);
      const cancelled = await api(ctx.app, "POST", `/customer_invoices/${draft.body.id}/cancel`, {});
      expect(cancelled.body.invoice.status).toBe("partially_cancelled");
      expect(cancelled.body.credit_note).toMatchObject({
        invoice_number: expect.stringMatching(/^AV-2026-/),
        amount: "-192.00",
        credit_note_of: { id: draft.body.id },
      });
      expect((await api(ctx.app, "DELETE", `/customer_invoices/${draft.body.id}`)).status).toBe(422);
      expect((await api(ctx.app, "DELETE", `/customer_invoices/${DEFAULT_DRAFT_INVOICE_ID}`)).status).toBe(204);
    });

    it("imports finalized invoices and validates inputs", async () => {
      const imported = await api(ctx.app, "POST", "/customer_invoices/import", {
        customer_id: DEFAULT_CUSTOMER_ID,
        invoice_number: "EXT-2026-77",
        external_reference: "cb_inv_0077",
        date: "2026-08-01",
        deadline: "2026-08-31",
        currency_amount: 240,
        file: `data:application/pdf;base64,${Buffer.from("%PDF-1.4 imported").toString("base64")}`,
        filename: "EXT-2026-77.pdf",
      });
      expect(imported.status).toBe(201);
      expect(imported.body).toMatchObject({
        invoice_number: "EXT-2026-77",
        imported: true,
        amount: "240.00",
        status: "late",
      });
      const file = await api(ctx.app, "GET", `/customer_invoices/${imported.body.id}/file`);
      expect(file.body).toBe("%PDF-1.4 imported");
      const duplicate = await api(ctx.app, "POST", "/customer_invoices/import", {
        customer_id: DEFAULT_CUSTOMER_ID,
        invoice_number: "EXT-2026-77",
        date: "2026-08-01",
        currency_amount: 1,
        file: "x",
      });
      expect(duplicate.status).toBe(422);
      expect(duplicate.body.errors[0]).toEqual({ field: "invoice_number", message: "has already been taken" });
      expect(
        (
          await api(ctx.app, "POST", "/customer_invoices/import", {
            customer_id: 1,
            invoice_number: "X",
            date: "2026-08-01",
            file: "x",
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await api(ctx.app, "POST", "/customer_invoices", {
            draft: false,
            date: "2026-08-01",
            invoice_lines: [{ label: "x", raw_currency_unit_price: 1 }],
          })
        ).status,
      ).toBe(422);
      expect(
        (
          await api(ctx.app, "POST", "/customer_invoices", {
            customer_id: DEFAULT_CUSTOMER_ID,
            date: "not-a-date",
            invoice_lines: [{ label: "x", raw_currency_unit_price: 1 }],
          })
        ).status,
      ).toBe(422);
    });

    it("matches transactions and updates categories", async () => {
      const transaction = await api(ctx.app, "POST", "/transactions", {
        bank_account_id: DEFAULT_BANK_ACCOUNT_ID,
        label: "VIR NIMBUS",
        amount: 648,
        date: "2026-09-08",
      });
      expect(transaction.status).toBe(201);
      const matched = await api(ctx.app, "PUT", `/customer_invoices/${DEFAULT_OPEN_INVOICE_ID}/matched_transactions`, {
        transaction_ids: [transaction.body.id],
      });
      expect(matched.body.items).toHaveLength(1);
      const invoice = await api(ctx.app, "GET", `/customer_invoices/${DEFAULT_OPEN_INVOICE_ID}`);
      expect(invoice.body).toMatchObject({ paid: true, status: "paid" });
      const training = (
        await api(ctx.app, "GET", `/categories?${filterQuery([{ field: "label", operator: "eq", value: "Training" }])}`)
      ).body.items[0];
      const managed = (
        await api(
          ctx.app,
          "GET",
          `/categories?${filterQuery([{ field: "label", operator: "eq", value: "Managed services" }])}`,
        )
      ).body.items[0];
      const categorized = await api(ctx.app, "PUT", `/customer_invoices/${DEFAULT_OPEN_INVOICE_ID}/categories`, {
        categories: [
          { id: training.id, weight: 0.5 },
          { id: managed.id, weight: 0.5 },
        ],
      });
      expect(categorized.body.items).toHaveLength(2);
      expect(
        (
          await api(ctx.app, "PUT", `/customer_invoices/${DEFAULT_OPEN_INVOICE_ID}/categories`, {
            categories: [{ id: training.id, weight: 0.4 }],
          })
        ).status,
      ).toBe(422);
      const matchedInvoices = await api(ctx.app, "GET", `/transactions/${transaction.body.id}/matched_invoices`);
      expect(matchedInvoices.body.items[0]).toMatchObject({
        type: "customer_invoice",
        invoice_number: DEFAULT_OPEN_INVOICE_NUMBER,
      });
    });
  });

  describe("customers, suppliers, and catalog", () => {
    it("manages company and individual customers", async () => {
      const list = await api(ctx.app, "GET", "/customers");
      expect(list.body.items).toHaveLength(3);
      expect(
        (await api(ctx.app, "GET", "/individual_customers")).body.items.map((customer: any) => customer.name),
      ).toEqual(["Jeanne Martin"]);
      const created = await api(ctx.app, "POST", "/company_customers", {
        name: "Globex",
        reg_no: "111222333",
        emails: ["ap@globex.example"],
        billing_address: { address: "1 Main St", postal_code: "75001", city: "Paris", country_alpha2: "fr" },
        external_reference: "cb_globex",
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        customer_type: "company",
        name: "Globex",
        billing_address: { country_alpha2: "FR" },
        payment_conditions: "30_days",
      });
      expect(
        (await api(ctx.app, "POST", "/company_customers", { name: "Dup", external_reference: "cb_globex" })).status,
      ).toBe(422);
      expect((await api(ctx.app, "POST", "/company_customers", { emails: ["x"] })).status).toBe(422);
      const individual = await api(ctx.app, "POST", "/individual_customers", {
        first_name: "Paul",
        last_name: "Durand",
        emails: ["paul@example.com"],
      });
      expect(individual.body.name).toBe("Paul Durand");
      const updated = await api(ctx.app, "PUT", `/company_customers/${created.body.id}`, {
        name: "Globex Corp",
        payment_conditions: "45_days",
      });
      expect(updated.body).toMatchObject({ name: "Globex Corp", payment_conditions: "45_days" });
      expect((await api(ctx.app, "PUT", `/individual_customers/${created.body.id}`, { first_name: "x" })).status).toBe(
        422,
      );
      expect((await api(ctx.app, "GET", `/customers/${created.body.id}`)).body.name).toBe("Globex Corp");
      expect((await api(ctx.app, "DELETE", `/customers/${created.body.id}`)).status).toBe(204);
      const archived = await api(ctx.app, "DELETE", `/customers/${DEFAULT_CUSTOMER_ID}`);
      expect(archived.status).toBe(200);
      expect(archived.body.archived).toBe(true);
    });

    it("manages suppliers", async () => {
      const list = await api(ctx.app, "GET", "/suppliers");
      expect(list.body.items[0]).toMatchObject({
        id: DEFAULT_SUPPLIER_ID,
        name: "Cloud Hosting Ltd",
        ledger_account: { id: expect.any(Number) },
      });
      const created = await api(ctx.app, "POST", "/suppliers", {
        name: "Paper Co",
        iban: "FR7630006000011234567890189",
        emails: ["billing@paper.example"],
      });
      expect(created.status).toBe(201);
      const updated = await api(ctx.app, "PUT", `/suppliers/${created.body.id}`, { name: "Paper Company" });
      expect(updated.body.name).toBe("Paper Company");
      expect((await api(ctx.app, "POST", "/suppliers", { name: "Bad", ledger_account_id: 1 })).status).toBe(422);
      expect((await api(ctx.app, "DELETE", `/suppliers/${created.body.id}`)).status).toBe(204);
      expect((await api(ctx.app, "GET", `/suppliers/${created.body.id}`)).status).toBe(404);
    });

    it("manages products, categories, and category groups", async () => {
      const products = await api(ctx.app, "GET", "/products");
      expect(products.body.items[0]).toMatchObject({
        label: "Managed EDR - per endpoint",
        price_before_tax: "8.00",
        price: "9.60",
        vat_rate: "FR_200",
      });
      const created = await api(ctx.app, "POST", "/products", {
        label: "Pen test day",
        price_before_tax: 1200,
        vat_rate: "20",
        unit: "day",
      });
      expect(created.status).toBe(201);
      expect(created.body.vat_rate).toBe("FR_200");
      expect((await api(ctx.app, "POST", "/products", { label: "No price" })).status).toBe(422);
      expect(
        (await api(ctx.app, "POST", "/products", { label: "Bad VAT", price_before_tax: 1, vat_rate: "99" })).status,
      ).toBe(422);
      expect(
        (await api(ctx.app, "PUT", `/products/${created.body.id}`, { price_before_tax: 1300 })).body.price_before_tax,
      ).toBe("1300.00");
      expect((await api(ctx.app, "DELETE", `/products/${created.body.id}`)).status).toBe(204);
      const groups = await api(ctx.app, "GET", "/category_groups");
      expect(groups.body.items.map((group: any) => group.label)).toEqual(["Revenue lines", "Operating expenses"]);
      const category = await api(ctx.app, "POST", "/categories", {
        label: "Consulting",
        category_group_id: groups.body.items[0].id,
        color: "#000000",
      });
      expect(category.status).toBe(201);
      expect(category.body).toMatchObject({ direction: "revenue", category_group: { label: "Revenue lines" } });
      expect((await api(ctx.app, "POST", "/categories", { label: "Bad", direction: "sideways" })).status).toBe(422);
      expect(
        (
          await api(
            ctx.app,
            "GET",
            `/categories?${filterQuery([{ field: "direction", operator: "eq", value: "expense" }])}`,
          )
        ).body.items.map((item: any) => item.label),
      ).toEqual(["Hosting"]);
      expect((await api(ctx.app, "DELETE", `/categories/${category.body.id}`)).status).toBe(204);
    });
  });

  describe("supplier invoices, banking, and accounting", () => {
    it("imports and pays supplier invoices with appendices", async () => {
      const list = await api(ctx.app, "GET", "/supplier_invoices");
      expect(list.body.items[0]).toMatchObject({
        id: DEFAULT_SUPPLIER_INVOICE_ID,
        invoice_number: "CH-88231",
        amount: "540.00",
        amount_before_tax: "450.00",
        supplier: { name: "Cloud Hosting Ltd" },
      });
      const imported = await api(ctx.app, "POST", "/supplier_invoices/import", {
        supplier_id: DEFAULT_SUPPLIER_ID,
        invoice_number: "CH-88300",
        date: "2026-09-01",
        currency_amount: 120,
        currency_amount_before_tax: 100,
        file: Buffer.from("%PDF").toString("base64"),
        filename: "CH-88300.pdf",
      });
      expect(imported.status).toBe(201);
      expect(imported.body).toMatchObject({ status: "upcoming", remaining_amount: "120.00" });
      expect(
        (
          await api(ctx.app, "POST", "/supplier_invoices/import", {
            supplier_id: DEFAULT_SUPPLIER_ID,
            date: "2026-09-01",
            file: "x",
          })
        ).status,
      ).toBe(422);
      const paid = await api(ctx.app, "POST", `/supplier_invoices/${imported.body.id}/mark_as_paid`);
      expect(paid.body).toMatchObject({ paid: true, status: "paid" });
      const appendix = await api(
        ctx.app,
        "POST",
        `/supplier_invoices/${imported.body.id}/appendices`,
        fileForm("receipt.jpg", "image/jpeg", "jpeg"),
      );
      expect(appendix.status).toBe(201);
      expect((await api(ctx.app, "GET", `/supplier_invoices/${imported.body.id}/appendices`)).body.items).toHaveLength(
        1,
      );
      const debit = await api(ctx.app, "POST", "/transactions", {
        label: "PRLV CH-88300",
        amount: -120,
        date: "2026-09-02",
      });
      const matched = await api(
        ctx.app,
        "PUT",
        `/supplier_invoices/${DEFAULT_SUPPLIER_INVOICE_ID}/matched_transactions`,
        { transaction_ids: [debit.body.id] },
      );
      expect(matched.body.items).toHaveLength(1);
      expect((await api(ctx.app, "DELETE", `/supplier_invoices/${imported.body.id}`)).status).toBe(204);
      expect((await api(ctx.app, "GET", "/supplier_invoices")).body.items.map((invoice: any) => invoice.id)).toEqual([
        DEFAULT_SUPPLIER_INVOICE_ID,
      ]);
    });

    it("exposes bank accounts and transactions with filters", async () => {
      const accounts = await api(ctx.app, "GET", "/bank_accounts");
      expect(accounts.body.items[0]).toMatchObject({
        id: DEFAULT_BANK_ACCOUNT_ID,
        label: "Compte courant",
        balance: "12500.00",
      });
      const transactions = await api(ctx.app, "GET", "/transactions");
      expect(transactions.body.items).toHaveLength(2);
      const credits = await api(
        ctx.app,
        "GET",
        `/transactions?${filterQuery([{ field: "amount", operator: "gt", value: 0 }])}`,
      );
      expect(credits.body.items.map((transaction: any) => transaction.label)).toEqual(["VIR ACME SAS F-2026-0001"]);
      const hosting = await api(
        ctx.app,
        "GET",
        `/transactions?${filterQuery([{ field: "label", operator: "contains", value: "cloud" }])}`,
      );
      expect(hosting.body.items).toHaveLength(1);
      expect(
        (await api(ctx.app, "GET", `/transactions/${hosting.body.items[0].id}/categories`)).body.items[0].label,
      ).toBe("Hosting");
      expect((await api(ctx.app, "POST", "/transactions", { label: "x" })).status).toBe(422);
    });

    it("manages journals, ledger accounts, fiscal years, and balanced ledger entries", async () => {
      expect((await api(ctx.app, "GET", "/journals")).body.items.map((journal: any) => journal.code)).toEqual([
        "VT",
        "AC",
        "BQ",
        "OD",
      ]);
      expect((await api(ctx.app, "GET", "/journals/VT")).body.label).toBe("Ventes");
      expect((await api(ctx.app, "POST", "/journals", { code: "vt", label: "dup" })).status).toBe(422);
      const accounts = await api(
        ctx.app,
        "GET",
        `/ledger_accounts?${filterQuery([{ field: "number", operator: "starts_with", value: "445" }])}`,
      );
      expect(accounts.body.items.map((account: any) => account.number)).toEqual(["445660", "445710"]);
      const created = await api(ctx.app, "POST", "/ledger_accounts", {
        number: "707000",
        label: "Ventes de marchandises",
      });
      expect(created.status).toBe(201);
      expect((await api(ctx.app, "POST", "/ledger_accounts", { number: "707000", label: "dup" })).status).toBe(422);
      const years = await api(ctx.app, "GET", "/fiscal_years");
      expect(years.body.items).toHaveLength(2);
      expect(years.body.items[0].closed).toBe(true);
      const clients = (
        await api(
          ctx.app,
          "GET",
          `/ledger_accounts?${filterQuery([{ field: "number", operator: "eq", value: "411000" }])}`,
        )
      ).body.items[0];
      const sales = (
        await api(
          ctx.app,
          "GET",
          `/ledger_accounts?${filterQuery([{ field: "number", operator: "eq", value: "706000" }])}`,
        )
      ).body.items[0];
      const entry = await api(ctx.app, "POST", "/ledger_entries", {
        date: "2026-09-01",
        journal_code: "OD",
        label: "Manual entry",
        lines: [
          { ledger_account_id: clients.id, debit: 120 },
          { ledger_account_id: sales.id, credit: 120 },
        ],
      });
      expect(entry.status).toBe(201);
      expect(entry.body.lines).toHaveLength(2);
      expect(entry.body.journal.code).toBe("OD");
      expect(
        (
          await api(ctx.app, "POST", "/ledger_entries", {
            date: "2026-09-01",
            journal_code: "OD",
            lines: [
              { ledger_account_id: clients.id, debit: 120 },
              { ledger_account_id: sales.id, credit: 100 },
            ],
          })
        ).status,
      ).toBe(422);
      expect((await api(ctx.app, "GET", `/ledger_entries/${entry.body.id}/lines`)).body.items).toHaveLength(2);
      expect(
        (
          await api(
            ctx.app,
            "GET",
            `/ledger_entry_lines?${filterQuery([{ field: "ledger_account_id", operator: "eq", value: clients.id }])}`,
          )
        ).body.items,
      ).toHaveLength(1);
    });
  });

  describe("misc", () => {
    it("exposes events, the inspector, and seeds without defaults", async () => {
      await api(
        ctx.app,
        "POST",
        `/customer_invoices/${DEFAULT_OPEN_INVOICE_ID}/appendices`,
        fileForm("a.pdf", "application/pdf"),
      );
      const events = (await (
        await ctx.app.request(`${pennylaneTestBaseUrl}/_pennylane/events?type=appendix.created`)
      ).json()) as any;
      expect(events.events[0]).toMatchObject({ type: "appendix.created", detail: { filename: "a.pdf" } });
      expect((await ctx.app.request(`${pennylaneTestBaseUrl}/_pennylane/events`, { method: "DELETE" })).status).toBe(
        200,
      );
      for (const tab of [
        "invoices",
        "appendices",
        "customers",
        "suppliers",
        "catalog",
        "banking",
        "accounting",
        "events",
        "auth",
      ]) {
        const page = await ctx.app.request(`${pennylaneTestBaseUrl}/?tab=${tab}`);
        expect(page.status).toBe(200);
        expect(await page.text()).toContain("Pennylane");
      }
      const bare = createPennylaneTestApp(
        {
          api_keys: [{ key: "k" }],
          customers: [{ name: "Solo", external_reference: "cb_solo" }],
          customer_invoices: [
            { customer: "Solo", invoice_number: "INV-1", external_reference: "INV-1", imported: true, amount: 12 },
          ],
        },
        false,
      );
      expect(getPlStore(bare.store).customerInvoices.count()).toBe(1);
      const found = await api(
        bare.app,
        "GET",
        `/customer_invoices?${filterQuery([{ field: "invoice_number", operator: "eq", value: "INV-1" }])}`,
        undefined,
        "k",
      );
      expect(found.body.items[0]).toMatchObject({ invoice_number: "INV-1", amount: "12.00" });
    });
  });
});
