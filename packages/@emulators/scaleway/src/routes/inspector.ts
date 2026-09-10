import type { AppEnv, Hono, InspectorTab } from "@emulators/core";
import { escapeHtml, renderInspectorPage } from "@emulators/core";
import { settings, type ScwStore } from "../store.js";
import { resolveEmail } from "./emails.js";

const SERVICE_LABEL = "Scaleway";
const TABS: InspectorTab[] = [
  { id: "emails", label: "Emails", href: "/?tab=emails" },
  { id: "domains", label: "Domains", href: "/?tab=domains" },
  { id: "webhooks", label: "Webhooks", href: "/?tab=webhooks" },
  { id: "blocklists", label: "Blocklists", href: "/?tab=blocklists" },
  { id: "events", label: "Events", href: "/?tab=events" },
  { id: "auth", label: "Auth", href: "/?tab=auth" },
];

type TabId = (typeof TABS)[number]["id"];

function maskSecret(value: string): string {
  return value.length <= 8 ? "****" : `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function inspectorRoutes(app: Hono<AppEnv>, scw: ScwStore, baseUrl: string): void {
  const domainName = (id: string | null) => (id ? (scw.domains.findOneBy("domain_id", id)?.name ?? id) : "");

  const render = (requested: string | undefined) => {
    const active = TABS.some((tab) => tab.id === requested) ? (requested as TabId) : "emails";
    const views: Record<TabId, () => string> = {
      emails: emailsView,
      domains: domainsView,
      webhooks: webhooksView,
      blocklists: blocklistsView,
      events: eventsView,
      auth: authView,
    };
    return renderInspectorPage("Scaleway Inspector", TABS, active, views[active](), SERVICE_LABEL);
  };
  app.get("/", (c) => c.html(render(c.req.query("tab"))));
  app.get("/_scaleway", (c) => c.html(render(c.req.query("tab"))));

  function emailsView(): string {
    const rows = [...scw.emails.all()]
      .sort((a, b) => b.id - a.id)
      .slice(0, 300)
      .map((email) => {
        const resolved = resolveEmail(email);
        return [
          escapeHtml(email.created_at_iso),
          escapeHtml(email.mail_from),
          escapeHtml(email.mail_rcpt),
          badge(email.rcpt_type),
          `<a href="/_scaleway/emails/${escapeHtml(email.email_id)}/html">${escapeHtml(email.subject)}</a>`,
          badge(resolved.status),
          escapeHtml(email.flags.join(", ")),
          escapeHtml(email.status_details ?? ""),
          escapeHtml(email.attachments.map((attachment) => attachment.name).join(", ")),
          code(email.email_id.slice(0, 8)),
        ];
      });
    return section(
      "Emails",
      `<p>Send with <code>POST ${escapeHtml(baseUrl)}/transactional-email/v1alpha1/regions/fr-par/emails</code> and header <code>X-Auth-Token</code>. Click a subject to preview the HTML body; <code>GET /_scaleway/emails/{id}</code> returns the full content. Delivery flips from <code>new</code> to <code>sending</code> to <code>sent</code> over ${escapeHtml(String(settings(scw).delivery_delay_ms))} ms.</p>` +
        table(
          ["Created", "From", "Recipient", "Type", "Subject", "Status", "Flags", "Details", "Attachments", "Id"],
          rows,
          "No emails sent yet.",
        ),
    );
  }

  function domainsView(): string {
    const rows = scw.domains
      .all()
      .map((domain) => [
        escapeHtml(domain.name),
        code(domain.domain_id),
        badge(domain.status),
        escapeHtml(domain.project_id),
        escapeHtml(String(scw.emails.findBy("domain_id", domain.domain_id).length)),
        escapeHtml(domain.last_valid_at ?? ""),
        escapeHtml(domain.spf_config),
      ]);
    return section(
      "Domains",
      `<p>Sender domains registered in the project. With <code>strict_domains</code> enabled in the seed, sending from an unchecked domain returns the 400 <code>invalid_arguments</code> error.</p>` +
        table(["Name", "Id", "Status", "Project", "Emails", "Last valid", "SPF"], rows, "No domains."),
    );
  }

  function webhooksView(): string {
    const rows = scw.webhooks
      .all()
      .map((webhook) => [
        escapeHtml(webhook.name),
        code(webhook.webhook_id),
        escapeHtml(domainName(webhook.domain_id)),
        escapeHtml(webhook.event_types.join(", ")),
        escapeHtml(webhook.sns_arn),
        escapeHtml(String(scw.webhookEvents.findBy("webhook_id", webhook.webhook_id).length)),
      ]);
    const events = [...scw.webhookEvents.all()]
      .sort((a, b) => b.id - a.id)
      .slice(0, 100)
      .map((event) => [
        escapeHtml(event.created_at),
        badge(event.type),
        badge(event.status),
        escapeHtml(domainName(event.domain_id)),
        code(event.email_id ?? ""),
        `<code>${escapeHtml(event.data)}</code>`,
      ]);
    return (
      section("Webhooks", table(["Name", "Id", "Domain", "Event types", "SNS ARN", "Events"], rows, "No webhooks.")) +
      section(
        "Recent webhook events",
        `<p>Scaleway delivers webhooks through SNS, so the emulator records the events here and serves them at <code>GET .../webhooks/{id}/events</code>.</p>` +
          table(["Created", "Type", "Status", "Domain", "Email", "Data"], events, "No webhook events."),
      )
    );
  }

  function blocklistsView(): string {
    const rows = scw.blocklists
      .all()
      .map((entry) => [
        escapeHtml(entry.email),
        escapeHtml(domainName(entry.domain_id)),
        badge(entry.type),
        escapeHtml(entry.reason),
        escapeHtml(String(entry.custom)),
        escapeHtml(entry.ends_at),
      ]);
    return section(
      "Blocklists",
      `<p>Emails to a blocklisted recipient fail immediately with the <code>blocklisted</code> flag.</p>` +
        table(["Email", "Domain", "Type", "Reason", "Custom", "Ends"], rows, "No blocklist entries."),
    );
  }

  function eventsView(): string {
    const rows = [...scw.events.all()]
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
      `<p>Also available as JSON at <code>${escapeHtml(baseUrl)}/_scaleway/events</code>.</p>` +
        table(["Type", "Subject", "Detail", "Created"], rows, "No events yet."),
    );
  }

  function authView(): string {
    const rows = scw.apiKeys
      .all()
      .map((key) => [
        escapeHtml(key.name),
        escapeHtml(key.access_key),
        `<code>${escapeHtml(maskSecret(key.secret_key))}</code>`,
        escapeHtml(key.project_ids?.join(", ") ?? "all projects"),
      ]);
    const projects = scw.projects
      .all()
      .map((project) => [escapeHtml(project.name), code(project.project_id), code(project.organization_id)]);
    return (
      section(
        "API keys",
        `<p>Send the secret key as <code>X-Auth-Token</code>. Unknown keys return the 401 <code>denied_authentication</code> body; a valid key used on a project it cannot access returns 403 <code>permissions_denied</code>.</p>` +
          table(["Name", "Access key", "Secret key", "Projects"], rows, "No API keys configured."),
      ) + section("Projects", table(["Name", "Project id", "Organization id"], projects, "No projects."))
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
