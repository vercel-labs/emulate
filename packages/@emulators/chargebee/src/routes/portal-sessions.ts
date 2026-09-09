import { escapeHtml, renderCardPage, renderSettingsPage } from "@emulators/core";
import { formatPortalSession, formatSubscription } from "../formatters.js";
import { blankParamError, invalidStateError, paramError, parseChargebeeBody, str, strOrNull } from "../helpers.js";
import { chargebeeId } from "../ids.js";
import { formatDate, formatMoney } from "../pdf.js";
import { nowSeconds, resourceVersion } from "../store.js";
import { api, findCustomer, findPortalSession, nested, type ChargebeeRouteContext } from "../route-utils.js";

const SERVICE_LABEL = "Chargebee";
const PORTAL_SESSION_TTL_SECONDS = 3600;

export function portalSessionRoutes(rc: ChargebeeRouteContext): void {
  const { app, cs, baseUrl } = rc;

  app.post(
    "/api/v2/portal_sessions",
    api(cs, async (c) => {
      const body = await parseChargebeeBody(c);
      const customerId = str(nested(body, "customer").id) ?? str(body.customer_id);
      if (!customerId) throw blankParamError("customer[id]");
      const customer = findCustomer(cs, customerId);
      const session = cs.portalSessions.insert({
        cb_id: chargebeeId(),
        token: chargebeeId(40),
        customer_id: customer.cb_id,
        status: "created",
        redirect_url: strOrNull(body.redirect_url),
        forward_url: strOrNull(body.forward_url),
        expires_at: nowSeconds(cs) + PORTAL_SESSION_TTL_SECONDS,
        login_at: null,
        logout_at: null,
        resource_version: resourceVersion(cs),
      });
      return c.json({ portal_session: formatPortalSession(cs, session, baseUrl) });
    }),
  );

  app.get(
    "/api/v2/portal_sessions/:id",
    api(cs, (c) =>
      c.json({ portal_session: formatPortalSession(cs, findPortalSession(cs, c.req.param("id")), baseUrl) }),
    ),
  );

  app.post(
    "/api/v2/portal_sessions/:id/logout",
    api(cs, (c) => {
      const session = findPortalSession(cs, c.req.param("id"));
      const updated = cs.portalSessions.update(session.id, {
        status: "logged_out",
        logout_at: nowSeconds(cs),
        resource_version: resourceVersion(cs),
      })!;
      return c.json({ portal_session: formatPortalSession(cs, updated, baseUrl) });
    }),
  );

  app.post(
    "/api/v2/portal_sessions/:id/activate",
    api(cs, async (c) => {
      const session = findPortalSession(cs, c.req.param("id"));
      const body = await parseChargebeeBody(c);
      const token = str(body.token);
      if (!token) throw blankParamError("token");
      if (token !== session.token) throw paramError("token", "is not valid for this portal session");
      if (session.status === "logged_out") throw invalidStateError("Portal session is logged out");
      const updated = cs.portalSessions.update(session.id, {
        status: "activated",
        login_at: session.login_at ?? nowSeconds(cs),
        resource_version: resourceVersion(cs),
      })!;
      return c.json({ portal_session: formatPortalSession(cs, updated, baseUrl) });
    }),
  );

  app.get("/portal/v2/authenticate", (c) => {
    const token = c.req.query("token") ?? "";
    const session = cs.portalSessions.findOneBy("token", token);
    if (!session || session.status === "logged_out" || session.expires_at < nowSeconds(cs)) {
      return c.html(
        renderCardPage(
          "Portal Session Invalid",
          "This portal session is missing, expired, or logged out.",
          "",
          SERVICE_LABEL,
        ),
        404,
      );
    }
    const updated = cs.portalSessions.update(session.id, {
      status: session.status === "activated" ? "activated" : "logged_in",
      login_at: session.login_at ?? nowSeconds(cs),
      resource_version: resourceVersion(cs),
    })!;
    const customer = cs.customers.findOneBy("cb_id", updated.customer_id);
    if (!customer)
      return c.html(renderCardPage("Customer Not Found", "The customer no longer exists.", "", SERVICE_LABEL), 404);

    const subscriptions = cs.subscriptions.findBy("customer_id", customer.cb_id);
    const invoices = cs.invoices.findBy("customer_id", customer.cb_id).sort((a, b) => b.id - a.id);
    const name =
      [customer.first_name, customer.last_name].filter(Boolean).join(" ") || customer.company || customer.cb_id;
    const sidebar = `<div class="s-card">
  <div class="card-title">${escapeHtml(name)}</div>
  <div class="card-subtitle">${escapeHtml(customer.email ?? "")}</div>
  <p><a href="/portal/v2/logout?token=${encodeURIComponent(updated.token)}">Log out</a></p>
</div>`;
    const subscriptionRows = subscriptions
      .map((sub) => {
        const formatted = formatSubscription(cs, sub);
        return `<tr><td>${escapeHtml(sub.cb_id)}</td><td><span class="badge">${escapeHtml(sub.status)}</span></td><td>${escapeHtml(
          sub.subscription_items.map((item) => `${item.item_price_id} x${item.quantity}`).join(", "),
        )}</td><td>${escapeHtml(formatDate(sub.next_billing_at))}</td><td>${escapeHtml(formatMoney(Number(formatted.mrr ?? 0), sub.currency_code))}</td></tr>`;
      })
      .join("\n");
    const invoiceRows = invoices
      .map(
        (invoice) =>
          `<tr><td>${escapeHtml(invoice.cb_id)}</td><td><span class="badge">${escapeHtml(invoice.status)}</span></td><td>${escapeHtml(
            formatDate(invoice.date),
          )}</td><td>${escapeHtml(formatMoney(invoice.total, invoice.currency_code))}</td><td>${escapeHtml(
            formatMoney(invoice.amount_due, invoice.currency_code),
          )}</td><td><a href="/_chargebee/invoices/${encodeURIComponent(invoice.cb_id)}/pdf">PDF</a></td></tr>`,
      )
      .join("\n");
    const body = `<section class="inspector-section">
  <h2>Subscriptions</h2>
  ${
    subscriptionRows
      ? `<table class="inspector-table"><thead><tr><th>ID</th><th>Status</th><th>Items</th><th>Next billing</th><th>MRR</th></tr></thead><tbody>${subscriptionRows}</tbody></table>`
      : '<p class="inspector-empty">No subscriptions.</p>'
  }
</section>
<section class="inspector-section">
  <h2>Invoices</h2>
  ${
    invoiceRows
      ? `<table class="inspector-table"><thead><tr><th>Number</th><th>Status</th><th>Date</th><th>Total</th><th>Due</th><th></th></tr></thead><tbody>${invoiceRows}</tbody></table>`
      : '<p class="inspector-empty">No invoices.</p>'
  }
</section>`;
    return c.html(renderSettingsPage("Customer Portal", sidebar, body, SERVICE_LABEL));
  });

  app.get("/portal/v2/logout", (c) => {
    const token = c.req.query("token") ?? "";
    const session = cs.portalSessions.findOneBy("token", token);
    if (session) {
      cs.portalSessions.update(session.id, {
        status: "logged_out",
        logout_at: nowSeconds(cs),
        resource_version: resourceVersion(cs),
      });
      if (session.redirect_url) return c.redirect(session.redirect_url);
    }
    return c.html(renderCardPage("Logged Out", "The portal session has ended.", "", SERVICE_LABEL));
  });
}
