import type { InspectorTab } from "@emulators/core";
import { escapeHtml, renderInspectorPage } from "@emulators/core";
import { webhookSigningKey } from "../store.js";
import { MESSAGE_HTML_PATH, type MailgunRouteContext } from "../route-utils.js";

const SERVICE_LABEL = "Mailgun";
const TABS: InspectorTab[] = [
  { id: "messages", label: "Messages", href: "/?tab=messages" },
  { id: "events", label: "Events", href: "/?tab=events" },
  { id: "lists", label: "Mailing Lists", href: "/?tab=lists" },
  { id: "suppressions", label: "Suppressions", href: "/?tab=suppressions" },
  { id: "templates", label: "Templates", href: "/?tab=templates" },
  { id: "domains", label: "Domains", href: "/?tab=domains" },
  { id: "webhooks", label: "Webhooks", href: "/?tab=webhooks" },
  { id: "routes", label: "Routes", href: "/?tab=routes" },
  { id: "auth", label: "Auth", href: "/?tab=auth" },
];

type TabId = (typeof TABS)[number]["id"];

function maskSecret(value: string): string {
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function inspectorRoutes(rc: MailgunRouteContext): void {
  const { app, ms, baseUrl } = rc;

  app.get("/", (c) => {
    const requested = c.req.query("tab") ?? "messages";
    const active = TABS.some((tab) => tab.id === requested) ? (requested as TabId) : "messages";
    const views: Record<TabId, () => string> = {
      messages: messagesView,
      events: eventsView,
      lists: listsView,
      suppressions: suppressionsView,
      templates: templatesView,
      domains: domainsView,
      webhooks: webhooksView,
      routes: routesView,
      auth: authView,
    };
    return c.html(renderInspectorPage("Mailgun Inspector", TABS, active, views[active](), SERVICE_LABEL));
  });

  function messagesView(): string {
    const rows = ms.messages
      .all()
      .sort((a, b) => b.id - a.id)
      .slice(0, 200)
      .map((message) => [
        `<a href="${MESSAGE_HTML_PATH}/${escapeHtml(message.key)}">${escapeHtml(message.subject || "(no subject)")}</a>`,
        escapeHtml(message.direction),
        escapeHtml(message.domain),
        escapeHtml(message.from),
        escapeHtml(message.recipients.join(", ")),
        escapeHtml(message.tags.join(", ")),
        badge(message.test_mode ? "test" : "live"),
        escapeHtml(message.created_at),
      ]);
    return section(
      "Messages",
      table(["Subject", "Direction", "Domain", "From", "Recipients", "Tags", "Mode", "Created"], rows, "No messages."),
    );
  }

  function eventsView(): string {
    const rows = ms.events
      .all()
      .sort((a, b) => b.id - a.id)
      .slice(0, 300)
      .map((event) => [
        badge(event.event),
        escapeHtml(event.domain),
        escapeHtml(event.recipient),
        escapeHtml(event.subject),
        escapeHtml([event.severity, event.reason].filter(Boolean).join(" ")),
        escapeHtml(event.tags.join(", ")),
        escapeHtml(new Date(event.timestamp * 1000).toISOString()),
      ]);
    return section(
      "Events",
      table(["Event", "Domain", "Recipient", "Subject", "Detail", "Tags", "Time"], rows, "No events."),
    );
  }

  function listsView(): string {
    const listRows = ms.lists
      .all()
      .map((list) => [
        escapeHtml(list.address),
        escapeHtml(list.name),
        escapeHtml(list.access_level),
        escapeHtml(String(ms.members.count((member) => member.list_address === list.address))),
      ]);
    const memberRows = ms.members
      .all()
      .sort((a, b) => a.list_address.localeCompare(b.list_address) || a.address.localeCompare(b.address))
      .map((member) => [
        escapeHtml(member.list_address),
        escapeHtml(member.address),
        escapeHtml(member.name),
        badge(member.subscribed ? "subscribed" : "unsubscribed"),
        escapeHtml(JSON.stringify(member.vars)),
      ]);
    return (
      section("Mailing Lists", table(["Address", "Name", "Access", "Members"], listRows, "No mailing lists.")) +
      section("Members", table(["List", "Address", "Name", "Status", "Vars"], memberRows, "No members."))
    );
  }

  function suppressionsView(): string {
    const rows = ms.suppressions
      .all()
      .sort(
        (a, b) =>
          a.domain.localeCompare(b.domain) || a.kind.localeCompare(b.kind) || a.address.localeCompare(b.address),
      )
      .map((item) => [
        escapeHtml(item.domain),
        badge(item.kind),
        escapeHtml(item.address),
        escapeHtml(item.code ?? ""),
        escapeHtml(item.error ?? item.reason ?? ""),
        escapeHtml(item.tags.join(", ")),
      ]);
    return section(
      "Suppressions",
      table(["Domain", "Kind", "Address", "Code", "Detail", "Tags"], rows, "No suppressions."),
    );
  }

  function templatesView(): string {
    const rows = ms.templateVersions
      .all()
      .sort((a, b) => a.template_name.localeCompare(b.template_name) || a.id - b.id)
      .map((version) => [
        escapeHtml(version.domain),
        escapeHtml(version.template_name),
        escapeHtml(version.tag),
        escapeHtml(version.engine),
        badge(version.active ? "active" : "inactive"),
        escapeHtml(version.content.slice(0, 120)),
      ]);
    return section(
      "Template Versions",
      table(["Domain", "Template", "Tag", "Engine", "State", "Content"], rows, "No templates."),
    );
  }

  function domainsView(): string {
    const rows = ms.domains
      .all()
      .map((domain) => [
        escapeHtml(domain.name),
        escapeHtml(domain.type),
        badge(domain.state),
        escapeHtml(`open ${domain.tracking.open ? "on" : "off"}, click ${domain.tracking.click ? "on" : "off"}`),
        escapeHtml(domain.authorized_recipients.join(", ")),
        escapeHtml(String(ms.messages.count((message) => message.domain === domain.name))),
      ]);
    const credentialRows = ms.credentials
      .all()
      .map((credential) => [
        escapeHtml(credential.domain),
        escapeHtml(credential.login),
        escapeHtml(maskSecret(credential.password)),
      ]);
    return (
      section(
        "Domains",
        table(["Name", "Type", "State", "Tracking", "Authorized recipients", "Messages"], rows, "No domains."),
      ) + section("SMTP Credentials", table(["Domain", "Login", "Password"], credentialRows, "No SMTP credentials."))
    );
  }

  function webhooksView(): string {
    const webhookRows = ms.webhooks
      .all()
      .map((webhook) => [escapeHtml(webhook.domain), escapeHtml(webhook.type), escapeHtml(webhook.urls.join(", "))]);
    const deliveryRows = ms.webhookDeliveries
      .all()
      .slice(-100)
      .reverse()
      .map((delivery) => [
        escapeHtml(delivery.domain),
        escapeHtml(delivery.type),
        escapeHtml(delivery.url),
        badge(delivery.success ? "ok" : "failed"),
        escapeHtml(String(delivery.status_code ?? "")),
        escapeHtml(delivery.error ?? ""),
        escapeHtml(delivery.created_at),
      ]);
    return (
      section("Webhooks", table(["Domain", "Type", "URLs"], webhookRows, "No webhooks.")) +
      section(
        "Deliveries",
        table(
          ["Domain", "Type", "URL", "Result", "HTTP", "Error", "Delivered at"],
          deliveryRows,
          "No webhook deliveries.",
        ),
      )
    );
  }

  function routesView(): string {
    const routeRows = [...ms.routes.all()]
      .sort((a, b) => a.priority - b.priority)
      .map((item) => [
        escapeHtml(item.route_id),
        escapeHtml(String(item.priority)),
        escapeHtml(item.description),
        escapeHtml(item.expression),
        escapeHtml(item.actions.join("; ")),
      ]);
    const deliveryRows = ms.routeDeliveries
      .all()
      .slice(-100)
      .reverse()
      .map((delivery) => [
        escapeHtml(delivery.route_id),
        escapeHtml(delivery.action),
        escapeHtml(delivery.recipient),
        badge(delivery.success ? "ok" : "failed"),
        escapeHtml(String(delivery.status_code ?? "")),
        escapeHtml(delivery.error ?? ""),
      ]);
    return (
      section(
        "Inbound Routes",
        table(["ID", "Priority", "Description", "Expression", "Actions"], routeRows, "No routes."),
      ) +
      section(
        "Route Deliveries",
        table(["Route", "Action", "Recipient", "Result", "HTTP", "Error"], deliveryRows, "No route deliveries."),
      )
    );
  }

  function authView(): string {
    const keyRows = ms.apiKeys
      .all()
      .map((key) => [
        escapeHtml(key.description),
        escapeHtml(key.kind),
        escapeHtml(key.domain ?? "all domains"),
        escapeHtml(maskSecret(key.key)),
      ]);
    const settings = [
      ["API base URL", escapeHtml(baseUrl)],
      ["Webhook signing key", escapeHtml(maskSecret(webhookSigningKey(ms)))],
    ];
    return (
      section("Settings", table(["Setting", "Value"], settings, "No settings.")) +
      section("API Keys", table(["Description", "Kind", "Domain", "Key"], keyRows, "No API keys."))
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
