import type { InspectorTab } from "@emulators/core";
import { escapeHtml, renderInspectorPage } from "@emulators/core";
import { liveActionStatus } from "../formatters.js";
import { actionDelays } from "../store.js";
import type { DefRouteContext } from "../route-utils.js";

const SERVICE_LABEL = "Defender for Endpoint";
const TABS: InspectorTab[] = [
  { id: "machines", label: "Machines", href: "/?tab=machines" },
  { id: "alerts", label: "Alerts", href: "/?tab=alerts" },
  { id: "actions", label: "Actions", href: "/?tab=actions" },
  { id: "tvm", label: "Vulnerabilities", href: "/?tab=tvm" },
  { id: "indicators", label: "Indicators", href: "/?tab=indicators" },
  { id: "tenants", label: "Tenants", href: "/?tab=tenants" },
  { id: "events", label: "Events", href: "/?tab=events" },
  { id: "auth", label: "Auth", href: "/?tab=auth" },
];

type TabId = (typeof TABS)[number]["id"];

function maskSecret(value: string): string {
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function inspectorRoutes(rc: DefRouteContext): void {
  const { app, ds, baseUrl } = rc;

  const tenantName = (tenantId: string) => ds.tenants.findOneBy("tenant_id", tenantId)?.name ?? tenantId;

  app.get("/", (c) => {
    const requested = c.req.query("tab") ?? "machines";
    const active = TABS.some((tab) => tab.id === requested) ? (requested as TabId) : "machines";
    const views: Record<TabId, () => string> = {
      machines: machinesView,
      alerts: alertsView,
      actions: actionsView,
      tvm: tvmView,
      indicators: indicatorsView,
      tenants: tenantsView,
      events: eventsView,
      auth: authView,
    };
    return c.html(renderInspectorPage("Defender for Endpoint Inspector", TABS, active, views[active](), SERVICE_LABEL));
  });

  function machinesView(): string {
    const rows = [...ds.machines.all()]
      .sort((a, b) => a.id - b.id)
      .map((machine) => [
        escapeHtml(machine.computerDnsName),
        code(machine.machine_id),
        escapeHtml(tenantName(machine.tenant_id)),
        escapeHtml(`${machine.osPlatform} ${machine.version}`.trim()),
        badge(machine.onboardingStatus),
        badge(machine.healthStatus),
        badge(machine.riskScore),
        badge(machine.exposureLevel),
        escapeHtml(machine.machineTags.join(", ")),
        machine.isolated ? badge("isolated") : "",
        escapeHtml(machine.lastSeen),
      ]);
    return section(
      "Machines",
      table(
        ["Name", "Id", "Tenant", "OS", "Onboarding", "Health", "Risk", "Exposure", "Tags", "State", "Last seen"],
        rows,
        "No machines.",
      ),
    );
  }

  function alertsView(): string {
    const rows = [...ds.alerts.all()]
      .sort((a, b) => b.id - a.id)
      .map((alert) => [
        escapeHtml(alert.title),
        code(alert.alert_id),
        escapeHtml(tenantName(alert.tenant_id)),
        escapeHtml(alert.computerDnsName),
        badge(alert.severity),
        badge(alert.status),
        escapeHtml(alert.category),
        escapeHtml(alert.classification ?? ""),
        escapeHtml(alert.assignedTo ?? ""),
        escapeHtml(alert.alertCreationTime),
      ]);
    return section(
      "Alerts",
      table(
        ["Title", "Id", "Tenant", "Machine", "Severity", "Status", "Category", "Classification", "Assigned", "Created"],
        rows,
        "No alerts.",
      ),
    );
  }

  function actionsView(): string {
    const delays = actionDelays(ds);
    const rows = [...ds.actions.all()]
      .sort((a, b) => b.id - a.id)
      .map((action) => [
        badge(action.type),
        code(action.action_id),
        escapeHtml(action.computerDnsName),
        badge(liveActionStatus(ds, action)),
        escapeHtml(action.requestor),
        escapeHtml(action.requestorComment),
        escapeHtml(action.creationDateTimeUtc),
      ]);
    return section(
      "Machine actions",
      `<p>Actions move to InProgress after ${delays.in_progress_after_ms} ms and Succeeded after ${delays.succeeded_after_ms} ms. Change this with <code>POST /_defender/simulate/action-delays</code>.</p>` +
        table(["Type", "Id", "Machine", "Status", "Requestor", "Comment", "Created"], rows, "No machine actions."),
    );
  }

  function tvmView(): string {
    const vulnerabilityRows = [...ds.vulnerabilities.all()]
      .sort((a, b) => b.cvssV3 - a.cvssV3)
      .map((vulnerability) => [
        code(vulnerability.cve_id),
        escapeHtml(tenantName(vulnerability.tenant_id)),
        escapeHtml(vulnerability.name),
        badge(vulnerability.severity),
        escapeHtml(String(vulnerability.cvssV3)),
        escapeHtml(
          String(
            ds.machineVulnerabilities
              .findBy("cve_id", vulnerability.cve_id)
              .filter((link) => link.tenant_id === vulnerability.tenant_id).length,
          ),
        ),
        vulnerability.publicExploit ? badge("public exploit") : "",
      ]);
    const softwareRows = [...ds.software.all()].map((software) => [
      code(software.software_id),
      escapeHtml(tenantName(software.tenant_id)),
      escapeHtml(software.name),
      escapeHtml(software.vendor),
      escapeHtml(String(software.weaknesses)),
      escapeHtml(
        String(
          ds.machineSoftware
            .findBy("software_id", software.software_id)
            .filter((link) => link.tenant_id === software.tenant_id).length,
        ),
      ),
    ]);
    const recommendationRows = [...ds.recommendations.all()].map((item) => [
      code(item.recommendation_id),
      escapeHtml(tenantName(item.tenant_id)),
      escapeHtml(item.recommendationName),
      escapeHtml(item.recommendationCategory),
      escapeHtml(String(item.severityScore)),
      badge(item.status),
    ]);
    return (
      section(
        "Vulnerabilities",
        table(["CVE", "Tenant", "Name", "Severity", "CVSS", "Machines", ""], vulnerabilityRows, "No vulnerabilities."),
      ) +
      section(
        "Software",
        table(["Id", "Tenant", "Name", "Vendor", "Weaknesses", "Machines"], softwareRows, "No software."),
      ) +
      section(
        "Recommendations",
        table(["Id", "Tenant", "Name", "Category", "Score", "Status"], recommendationRows, "No recommendations."),
      )
    );
  }

  function indicatorsView(): string {
    const rows = [...ds.indicators.all()]
      .sort((a, b) => b.id - a.id)
      .map((indicator) => [
        code(indicator.indicator_id),
        escapeHtml(tenantName(indicator.tenant_id)),
        badge(indicator.indicatorType),
        `<code>${escapeHtml(indicator.indicatorValue)}</code>`,
        badge(indicator.action),
        badge(indicator.severity),
        escapeHtml(indicator.title),
        escapeHtml(indicator.expirationTime ?? "never"),
      ]);
    return section(
      "Indicators",
      table(["Id", "Tenant", "Type", "Value", "Action", "Severity", "Title", "Expires"], rows, "No indicators."),
    );
  }

  function tenantsView(): string {
    const rows = [...ds.tenants.all()].map((tenant) => [
      escapeHtml(tenant.name),
      code(tenant.tenant_id),
      escapeHtml(String(ds.machines.findBy("tenant_id", tenant.tenant_id).length)),
      escapeHtml(
        String(
          ds.machines
            .findBy("tenant_id", tenant.tenant_id)
            .filter((machine) => machine.onboardingStatus === "Onboarded").length,
        ),
      ),
      escapeHtml(String(ds.alerts.findBy("tenant_id", tenant.tenant_id).length)),
      escapeHtml(
        ds.apps
          .all()
          .filter((app_) => !app_.tenant_ids || app_.tenant_ids.includes(tenant.tenant_id))
          .map((app_) => app_.name)
          .join(", "),
      ),
    ]);
    return section(
      "Tenants",
      `<p>Request a token at <code>${escapeHtml(baseUrl)}/{tenantId}/oauth2/v2.0/token</code>; the token only sees that tenant's data.</p>` +
        table(["Name", "Tenant id", "Machines", "Onboarded", "Alerts", "Apps"], rows, "No tenants."),
    );
  }

  function eventsView(): string {
    const rows = [...ds.events.all()]
      .sort((a, b) => b.id - a.id)
      .slice(0, 300)
      .map((event) => [
        badge(event.type),
        escapeHtml(tenantName(event.tenant_id)),
        code(event.subject),
        `<code>${escapeHtml(JSON.stringify(event.detail))}</code>`,
        escapeHtml(event.created_at),
      ]);
    return section(
      "Events",
      `<p>Also available as JSON at <code>${escapeHtml(baseUrl)}/_defender/events</code>.</p>` +
        table(["Type", "Tenant", "Subject", "Detail", "Created"], rows, "No events yet."),
    );
  }

  function authView(): string {
    const appRows = ds.apps
      .all()
      .map((app_) => [
        escapeHtml(app_.name),
        code(app_.client_id),
        `<code>${escapeHtml(maskSecret(app_.client_secret))}</code>`,
        escapeHtml(app_.tenant_ids ? app_.tenant_ids.map(tenantName).join(", ") : "all tenants"),
        escapeHtml(app_.roles.length > 0 ? app_.roles.join(", ") : "all roles"),
      ]);
    const tokenRows = [...ds.tokens.all()]
      .sort((a, b) => b.id - a.id)
      .slice(0, 50)
      .map((token) => [
        `<code>${escapeHtml(maskSecret(token.token))}</code>`,
        escapeHtml(tenantName(token.tenant_id)),
        code(token.client_id),
        escapeHtml(token.expires_at),
      ]);
    return (
      section(
        "Applications",
        `<p>Use <code>grant_type=client_credentials</code> with <code>scope=https://api.securitycenter.microsoft.com/.default</code> at <code>${escapeHtml(baseUrl)}/{tenantId}/oauth2/v2.0/token</code>, then call <code>${escapeHtml(baseUrl)}/api/...</code> with the bearer token.</p>` +
          table(["Name", "Client id", "Secret", "Tenants", "Roles"], appRows, "No applications configured."),
      ) +
      section("Issued tokens", table(["Token", "Tenant", "Client id", "Expires"], tokenRows, "No tokens issued yet."))
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
