import type { InspectorTab } from "@emulators/core";
import { escapeHtml, renderInspectorPage } from "@emulators/core";
import { WEBHOOK_OWNER } from "../events.js";
import { maskSecret } from "../helpers.js";
import { formatDate, formatMoney } from "../pdf.js";
import { genesisTime, nowSeconds, siteName } from "../store.js";
import type { ChargebeeRouteContext } from "../route-utils.js";

const SERVICE_LABEL = "Chargebee";
const TABS: InspectorTab[] = [
  { id: "customers", label: "Customers", href: "/?tab=customers" },
  { id: "subscriptions", label: "Subscriptions", href: "/?tab=subscriptions" },
  { id: "invoices", label: "Invoices", href: "/?tab=invoices" },
  { id: "catalog", label: "Catalog", href: "/?tab=catalog" },
  { id: "payments", label: "Payments", href: "/?tab=payments" },
  { id: "hosted", label: "Hosted Pages", href: "/?tab=hosted" },
  { id: "events", label: "Events", href: "/?tab=events" },
  { id: "auth", label: "Auth", href: "/?tab=auth" },
  { id: "webhooks", label: "Webhooks", href: "/?tab=webhooks" },
];

type TabId = (typeof TABS)[number]["id"];

export function inspectorRoutes(rc: ChargebeeRouteContext): void {
  const { app, cs, webhooks, baseUrl } = rc;

  app.get("/", (c) => {
    const requested = c.req.query("tab") ?? "customers";
    const active = TABS.some((tab) => tab.id === requested) ? (requested as TabId) : "customers";
    const views: Record<TabId, () => string> = {
      customers: customersView,
      subscriptions: subscriptionsView,
      invoices: invoicesView,
      catalog: catalogView,
      payments: paymentsView,
      hosted: hostedView,
      events: eventsView,
      auth: authView,
      webhooks: webhooksView,
    };
    return c.html(renderInspectorPage("Chargebee Inspector", TABS, active, views[active](), SERVICE_LABEL));
  });

  function customersView(): string {
    const rows = cs.customers
      .all()
      .sort((a, b) => b.id - a.id)
      .map((customer) => [
        escapeHtml(customer.cb_id),
        escapeHtml([customer.first_name, customer.last_name].filter(Boolean).join(" ")),
        escapeHtml(customer.email ?? ""),
        escapeHtml(customer.company ?? ""),
        escapeHtml(customer.auto_collection),
        escapeHtml(customer.primary_payment_source_id ?? ""),
        escapeHtml(customer.parent_id ?? ""),
        escapeHtml(String(cs.subscriptions.count((sub) => sub.customer_id === customer.cb_id))),
      ]);
    return section(
      "Customers",
      table(
        ["ID", "Name", "Email", "Company", "Auto collection", "Primary payment source", "Parent", "Subscriptions"],
        rows,
        "No customers.",
      ),
    );
  }

  function subscriptionsView(): string {
    const rows = cs.subscriptions
      .all()
      .sort((a, b) => b.id - a.id)
      .map((sub) => [
        escapeHtml(sub.cb_id),
        escapeHtml(sub.customer_id),
        badge(sub.status),
        escapeHtml(sub.subscription_items.map((item) => `${item.item_price_id} x${item.quantity}`).join(", ")),
        escapeHtml(`${sub.billing_period} ${sub.billing_period_unit}`),
        escapeHtml(formatDate(sub.current_term_start)),
        escapeHtml(formatDate(sub.current_term_end)),
        escapeHtml(formatDate(sub.next_billing_at)),
        escapeHtml(sub.scheduled_changes ? "yes" : ""),
      ]);
    return section(
      "Subscriptions",
      table(
        ["ID", "Customer", "Status", "Items", "Period", "Term start", "Term end", "Next billing", "Scheduled changes"],
        rows,
        "No subscriptions.",
      ),
    );
  }

  function invoicesView(): string {
    const invoiceRows = cs.invoices
      .all()
      .sort((a, b) => b.id - a.id)
      .map((invoice) => [
        `<a href="/_chargebee/invoices/${encodeURIComponent(invoice.cb_id)}/pdf">${escapeHtml(invoice.cb_id)}</a>`,
        escapeHtml(invoice.customer_id),
        escapeHtml(invoice.subscription_id ?? ""),
        badge(invoice.status),
        escapeHtml(formatDate(invoice.date)),
        escapeHtml(formatMoney(invoice.total, invoice.currency_code)),
        escapeHtml(formatMoney(invoice.amount_paid, invoice.currency_code)),
        escapeHtml(formatMoney(invoice.amount_due, invoice.currency_code)),
        escapeHtml(invoice.recurring ? "recurring" : "one-off"),
      ]);
    const creditNoteRows = cs.creditNotes
      .all()
      .sort((a, b) => b.id - a.id)
      .map((note) => [
        escapeHtml(note.cb_id),
        escapeHtml(note.customer_id),
        escapeHtml(note.reference_invoice_id ?? ""),
        escapeHtml(note.type),
        badge(note.status),
        escapeHtml(formatMoney(note.total, note.currency_code)),
        escapeHtml(formatMoney(note.amount_available, note.currency_code)),
        escapeHtml(note.reason_code ?? ""),
      ]);
    return (
      section(
        "Invoices",
        table(
          ["Number", "Customer", "Subscription", "Status", "Date", "Total", "Paid", "Due", "Type"],
          invoiceRows,
          "No invoices.",
        ),
      ) +
      section(
        "Credit Notes",
        table(
          ["ID", "Customer", "Invoice", "Type", "Status", "Total", "Available", "Reason"],
          creditNoteRows,
          "No credit notes.",
        ),
      )
    );
  }

  function catalogView(): string {
    const familyRows = cs.itemFamilies
      .all()
      .map((family) => [escapeHtml(family.cb_id), escapeHtml(family.name), badge(family.status)]);
    const itemRows = cs.items
      .all()
      .map((item) => [
        escapeHtml(item.cb_id),
        escapeHtml(item.name),
        escapeHtml(item.type),
        escapeHtml(item.item_family_id),
        badge(item.status),
      ]);
    const priceRows = cs.itemPrices
      .all()
      .map((price) => [
        escapeHtml(price.cb_id),
        escapeHtml(price.item_id),
        escapeHtml(price.pricing_model),
        escapeHtml(
          price.price !== null ? formatMoney(price.price, price.currency_code) : `${price.tiers.length} tiers`,
        ),
        escapeHtml(price.period ? `${price.period} ${price.period_unit}` : "one-time"),
        escapeHtml(price.trial_period ? `${price.trial_period} ${price.trial_period_unit}` : ""),
        badge(price.status),
      ]);
    const couponRows = cs.coupons
      .all()
      .map((coupon) => [
        escapeHtml(coupon.cb_id),
        escapeHtml(coupon.name),
        escapeHtml(
          coupon.discount_type === "percentage"
            ? `${coupon.discount_percentage}%`
            : formatMoney(coupon.discount_amount ?? 0, coupon.currency_code ?? "USD"),
        ),
        escapeHtml(coupon.duration_type),
        escapeHtml(coupon.apply_on),
        escapeHtml(String(coupon.redemptions)),
        badge(coupon.status),
      ]);
    return (
      section("Item Families", table(["ID", "Name", "Status"], familyRows, "No item families.")) +
      section("Items", table(["ID", "Name", "Type", "Family", "Status"], itemRows, "No items.")) +
      section(
        "Item Prices",
        table(["ID", "Item", "Pricing", "Price", "Period", "Trial", "Status"], priceRows, "No item prices."),
      ) +
      section(
        "Coupons",
        table(["ID", "Name", "Discount", "Duration", "Apply on", "Redemptions", "Status"], couponRows, "No coupons."),
      )
    );
  }

  function paymentsView(): string {
    const transactionRows = cs.transactions
      .all()
      .sort((a, b) => b.id - a.id)
      .map((txn) => [
        escapeHtml(txn.cb_id),
        escapeHtml(txn.customer_id),
        escapeHtml(txn.type),
        badge(txn.status),
        escapeHtml(txn.payment_method),
        escapeHtml(formatMoney(txn.amount, txn.currency_code)),
        escapeHtml(txn.linked_invoices.map((link) => link.invoice_id).join(", ")),
        escapeHtml(formatDate(txn.date)),
      ]);
    const sourceRows = cs.paymentSources
      .all()
      .map((source) => [
        escapeHtml(source.cb_id),
        escapeHtml(source.customer_id),
        escapeHtml(source.type),
        escapeHtml(source.card?.masked_number ?? ""),
        escapeHtml(source.card ? `${source.card.expiry_month}/${source.card.expiry_year}` : ""),
        badge(source.deleted ? "deleted" : source.status),
      ]);
    return (
      section(
        "Transactions",
        table(
          ["ID", "Customer", "Type", "Status", "Method", "Amount", "Invoices", "Date"],
          transactionRows,
          "No transactions.",
        ),
      ) +
      section(
        "Payment Sources",
        table(["ID", "Customer", "Type", "Card", "Expiry", "Status"], sourceRows, "No payment sources."),
      )
    );
  }

  function hostedView(): string {
    const pageRows = cs.hostedPages
      .all()
      .sort((a, b) => b.id - a.id)
      .map((page) => [
        `<a href="/pages/v3/${escapeHtml(page.cb_id)}/">${escapeHtml(page.cb_id.slice(0, 12))}...</a>`,
        escapeHtml(page.type),
        badge(page.state),
        escapeHtml(page.redirect_url ?? ""),
        escapeHtml(page.content?.subscription_id ?? page.content?.invoice_id ?? page.content?.payment_source_id ?? ""),
        escapeHtml(page.failure_reason ?? ""),
      ]);
    const portalRows = cs.portalSessions
      .all()
      .sort((a, b) => b.id - a.id)
      .map((session) => [
        escapeHtml(session.cb_id),
        escapeHtml(session.customer_id),
        badge(session.status),
        `<a href="/portal/v2/authenticate?token=${encodeURIComponent(session.token)}">open</a>`,
      ]);
    return (
      section(
        "Hosted Pages",
        table(["ID", "Type", "State", "Redirect URL", "Result", "Failure"], pageRows, "No hosted pages."),
      ) + section("Portal Sessions", table(["ID", "Customer", "Status", "Portal"], portalRows, "No portal sessions."))
    );
  }

  function eventsView(): string {
    const rows = cs.events
      .all()
      .sort((a, b) => b.id - a.id)
      .slice(0, 200)
      .map((event) => [
        escapeHtml(event.cb_id),
        escapeHtml(event.event_type),
        escapeHtml(event.source),
        badge(event.webhook_status),
        escapeHtml(new Date(event.occurred_at * 1000).toISOString()),
      ]);
    return section("Events", table(["ID", "Type", "Source", "Webhook status", "Occurred at"], rows, "No events."));
  }

  function authView(): string {
    const keyRows = cs.apiKeys.all().map((key) => [escapeHtml(key.name), escapeHtml(maskSecret(key.key))]);
    const clock = [
      ["Site", escapeHtml(siteName(cs))],
      ["API base URL", escapeHtml(`${baseUrl}/api/v2`)],
      ["Current time", escapeHtml(new Date(nowSeconds(cs) * 1000).toISOString())],
      ["Genesis time", escapeHtml(new Date(genesisTime(cs) * 1000).toISOString())],
    ];
    return (
      section("Site", table(["Setting", "Value"], clock, "No site.")) +
      section(
        "API Keys",
        table(["Name", "Key"], keyRows, "No API keys. Configure chargebee.api_keys in the seed config."),
      )
    );
  }

  function webhooksView(): string {
    const subscriptionRows = webhooks
      .getSubscriptions(WEBHOOK_OWNER)
      .map((sub) => [
        escapeHtml(String(sub.id)),
        escapeHtml(sub.url),
        escapeHtml(sub.events.join(", ")),
        escapeHtml(sub.secret ? "basic auth" : "none"),
        badge(sub.active ? "active" : "inactive"),
      ]);
    const deliveryRows = webhooks
      .getDeliveries()
      .slice(-100)
      .reverse()
      .map((delivery) => [
        escapeHtml(String(delivery.id)),
        escapeHtml(delivery.event),
        escapeHtml(String(delivery.hook_id)),
        escapeHtml(String(delivery.status_code ?? "")),
        badge(delivery.success ? "ok" : "failed"),
        escapeHtml(delivery.delivered_at),
      ]);
    return (
      section(
        "Webhook Endpoints",
        table(["ID", "URL", "Events", "Auth", "Status"], subscriptionRows, "No webhook endpoints configured."),
      ) +
      section(
        "Deliveries",
        table(
          ["ID", "Event", "Endpoint", "HTTP status", "Result", "Delivered at"],
          deliveryRows,
          "No webhook deliveries.",
        ),
      )
    );
  }
}

function badge(value: string): string {
  return `<span class="badge">${escapeHtml(value)}</span>`;
}

function section(title: string, body: string): string {
  return `<section class="inspector-section">
  <h2>${escapeHtml(title)}</h2>
  ${body}
</section>`;
}

function table(headers: string[], rows: string[][], empty: string): string {
  if (rows.length === 0) return `<p class="inspector-empty">${escapeHtml(empty)}</p>`;
  const headerHtml = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("");
  const rowHtml = rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("\n");
  return `<table class="inspector-table">
  <thead><tr>${headerHtml}</tr></thead>
  <tbody>
${rowHtml}
  </tbody>
</table>`;
}
