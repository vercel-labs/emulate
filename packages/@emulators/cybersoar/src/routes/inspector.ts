import type { AppEnv, Hono, InspectorTab } from "@emulators/core";
import { escapeHtml, renderInspectorPage } from "@emulators/core";
import { MAIL_SENT_TAG, type CsAlert } from "../entities.js";
import type { CsStore } from "../store.js";
import { namespacesFor } from "./alerts.js";

const SERVICE_LABEL = "CyberSOAR";
const TABS: InspectorTab[] = [
  { id: "alerts", label: "Alerts", href: "/?tab=alerts" },
  { id: "cases", label: "Cases", href: "/?tab=cases" },
  { id: "customers", label: "Customers", href: "/?tab=customers" },
  { id: "events", label: "Events", href: "/?tab=events" },
  { id: "auth", label: "Auth", href: "/?tab=auth" },
];

type TabId = (typeof TABS)[number]["id"];

export function inspectorRoutes(app: Hono<AppEnv>, cs: CsStore, baseUrl: string): void {
  const render = (requested: string | undefined) => {
    const active = TABS.some((tab) => tab.id === requested) ? (requested as TabId) : "alerts";
    const views: Record<TabId, () => string> = {
      alerts: alertsView,
      cases: casesView,
      customers: customersView,
      events: eventsView,
      auth: authView,
    };
    return renderInspectorPage("CyberSOAR Inspector", TABS, active, views[active](), SERVICE_LABEL);
  };
  app.get("/", (c) => c.html(render(c.req.query("tab"))));
  app.get("/_cybersoar", (c) => c.html(render(c.req.query("tab"))));

  function alertsView(): string {
    const rows = [...cs.alerts.all()]
      .sort((a, b) => (a.ingest_at < b.ingest_at ? 1 : -1))
      .slice(0, 300)
      .map((alert) => [
        escapeHtml(alert.ingest_at),
        code(alert.alert_id.slice(0, 8)),
        escapeHtml(alert.customer),
        badge(alert.service),
        escapeHtml(alert.rule_name),
        escapeHtml(String(alert.criticity)),
        badge(alert.status),
        badge(alert.verdict),
        escapeHtml(alert.tags.join(", ")),
        code(alert.case_id),
      ]);
    return section(
      "Alerts",
      `<p>List with <code>GET ${escapeHtml(baseUrl)}/incidents/alerts?name="MSP:Customer"&amp;status=CLOSED&amp;ingestAt.gt=...</code>. Create with <code>POST /_cybersoar/simulate/alert</code>, close with <code>POST /_cybersoar/simulate/close</code>.</p>` +
        table(
          ["Ingested", "Id", "Customer", "Service", "Rule", "Criticity", "Status", "Verdict", "Tags", "Case"],
          rows,
          "No alerts.",
        ),
    );
  }

  function casesView(): string {
    const grouped = new Map<string, CsAlert[]>();
    for (const alert of cs.alerts.all()) grouped.set(alert.case_id, [...(grouped.get(alert.case_id) ?? []), alert]);
    const rows = [...grouped.entries()].map(([caseId, alerts]) => [
      code(caseId),
      escapeHtml(alerts[0].customer),
      badge(alerts[0].service),
      escapeHtml(String(alerts.length)),
      badge(alerts.every((alert) => alert.status === "CLOSED") ? "CLOSED" : "WAITING_ANALYST"),
      badge(alerts[alerts.length - 1].verdict),
      escapeHtml(String(Math.max(...alerts.map((alert) => alert.criticity)))),
    ]);
    return section(
      "Cases",
      table(["Case", "Customer", "Service", "Alerts", "Status", "Verdict", "Criticity"], rows, "No cases."),
    );
  }

  function customersView(): string {
    const rows = cs.customers.all().map((customer) => {
      const alerts = cs.alerts.findBy("customer_id", customer.customer_id);
      return [
        escapeHtml(customer.name),
        escapeHtml(customer.msp),
        namespacesFor(customer).map(code).join("<br>"),
        escapeHtml(String(alerts.length)),
        escapeHtml(String(alerts.filter((alert) => alert.status === "CLOSED").length)),
        escapeHtml(String(alerts.filter((alert) => alert.tags.includes(MAIL_SENT_TAG)).length)),
      ];
    });
    return section(
      "Customers",
      `<p>The <code>name</code> query parameter matches either namespace form (display names or slugs), with or without surrounding quotes.</p>` +
        table(["Customer", "MSP", "Namespaces", "Alerts", "Closed", "Mail sent"], rows, "No customers."),
    );
  }

  function eventsView(): string {
    const rows = [...cs.events.all()]
      .sort((a, b) => b.id - a.id)
      .slice(0, 300)
      .map((event) => [
        badge(event.type),
        code(event.subject),
        `<code>${escapeHtml(JSON.stringify(event.detail))}</code>`,
        escapeHtml(event.created_at),
      ]);
    return section(
      "Events",
      `<p>Also available as JSON at <code>${escapeHtml(baseUrl)}/_cybersoar/events</code>.</p>` +
        table(["Type", "Subject", "Detail", "Created"], rows, "No events yet."),
    );
  }

  function authView(): string {
    const rows = cs.apiKeys
      .all()
      .map((key) => [
        escapeHtml(key.name),
        `<code>${escapeHtml(key.api_key.length <= 8 ? "****" : `${key.api_key.slice(0, 4)}...${key.api_key.slice(-4)}`)}</code>`,
      ]);
    return section(
      "API keys",
      `<p>Send <code>Authorization: ApiKey &lt;key&gt;</code> (Bearer and <code>X-API-Key</code> are accepted too). Unknown keys return <code>{ statusCode: 401 }</code>.</p>` +
        table(["Name", "Key"], rows, "No API keys configured."),
    );
  }
}

function code(value: string): string {
  return `<code>${escapeHtml(value)}</code>`;
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
