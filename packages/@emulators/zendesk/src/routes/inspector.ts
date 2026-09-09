import type { InspectorTab } from "@emulators/core";
import { escapeHtml, renderInspectorPage } from "@emulators/core";
import { ticketUpdatedAt } from "../formatters.js";
import { accountId, subdomain } from "../store.js";
import type { ZendeskRouteContext } from "../route-utils.js";

const SERVICE_LABEL = "Zendesk";
const TABS: InspectorTab[] = [
  { id: "tickets", label: "Tickets", href: "/?tab=tickets" },
  { id: "users", label: "Users", href: "/?tab=users" },
  { id: "organizations", label: "Organizations", href: "/?tab=organizations" },
  { id: "fields", label: "Fields", href: "/?tab=fields" },
  { id: "rules", label: "Rules", href: "/?tab=rules" },
  { id: "webhooks", label: "Webhooks", href: "/?tab=webhooks" },
  { id: "events", label: "Events", href: "/?tab=events" },
  { id: "auth", label: "Auth", href: "/?tab=auth" },
];

type TabId = (typeof TABS)[number]["id"];

function maskSecret(value: string): string {
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function inspectorRoutes(rc: ZendeskRouteContext): void {
  const { app, zs, baseUrl } = rc;

  app.get("/", (c) => {
    const requested = c.req.query("tab") ?? "tickets";
    const active = TABS.some((tab) => tab.id === requested) ? (requested as TabId) : "tickets";
    const views: Record<TabId, () => string> = {
      tickets: ticketsView,
      users: usersView,
      organizations: organizationsView,
      fields: fieldsView,
      rules: rulesView,
      webhooks: webhooksView,
      events: eventsView,
      auth: authView,
    };
    return c.html(renderInspectorPage("Zendesk Inspector", TABS, active, views[active](), SERVICE_LABEL));
  });

  const userName = (id: number | null) => (id === null ? "" : (zs.users.findOneBy("zd_id", id)?.name ?? String(id)));

  function ticketsView(): string {
    const rows = zs.tickets
      .all()
      .sort((a, b) => b.id - a.id)
      .map((ticket) => [
        escapeHtml(String(ticket.zd_id)),
        escapeHtml(ticket.subject),
        badge(ticket.deleted ? "deleted" : ticket.status),
        escapeHtml(ticket.priority ?? ""),
        escapeHtml(userName(ticket.requester_id)),
        escapeHtml(userName(ticket.assignee_id)),
        escapeHtml(ticket.tags.join(", ")),
        escapeHtml(String(zs.comments.count((comment) => comment.ticket_id === ticket.zd_id))),
        escapeHtml(ticketUpdatedAt(ticket)),
      ]);
    return section(
      "Tickets",
      table(
        ["ID", "Subject", "Status", "Priority", "Requester", "Assignee", "Tags", "Comments", "Updated"],
        rows,
        "No tickets.",
      ),
    );
  }

  function usersView(): string {
    const rows = zs.users
      .all()
      .sort((a, b) => a.id - b.id)
      .map((user) => [
        escapeHtml(String(user.zd_id)),
        escapeHtml(user.name),
        escapeHtml(user.email ?? ""),
        badge(user.role),
        escapeHtml(
          user.organization_id === null
            ? ""
            : (zs.organizations.findOneBy("zd_id", user.organization_id)?.name ?? String(user.organization_id)),
        ),
        escapeHtml(user.tags.join(", ")),
        badge(user.deleted ? "deleted" : user.suspended ? "suspended" : user.active ? "active" : "inactive"),
      ]);
    return section("Users", table(["ID", "Name", "Email", "Role", "Organization", "Tags", "State"], rows, "No users."));
  }

  function organizationsView(): string {
    const rows = zs.organizations
      .all()
      .sort((a, b) => a.id - b.id)
      .map((organization) => [
        escapeHtml(String(organization.zd_id)),
        escapeHtml(organization.name),
        escapeHtml(organization.domain_names.join(", ")),
        escapeHtml(organization.external_id ?? ""),
        escapeHtml(
          String(zs.organizationMemberships.count((membership) => membership.organization_id === organization.zd_id)),
        ),
        escapeHtml(JSON.stringify(organization.organization_fields)),
        badge(organization.deleted ? "deleted" : "active"),
      ]);
    const groupRows = zs.groups
      .all()
      .map((group) => [
        escapeHtml(String(group.zd_id)),
        escapeHtml(group.name),
        escapeHtml(group.default ? "default" : ""),
        escapeHtml(String(zs.groupMemberships.count((membership) => membership.group_id === group.zd_id))),
      ]);
    return (
      section(
        "Organizations",
        table(["ID", "Name", "Domains", "External ID", "Members", "Fields", "State"], rows, "No organizations."),
      ) + section("Groups", table(["ID", "Name", "Default", "Agents"], groupRows, "No groups."))
    );
  }

  function fieldsView(): string {
    const ticketFieldRows = [...zs.ticketFields.all()]
      .sort((a, b) => a.position - b.position)
      .map((field) => [
        escapeHtml(String(field.zd_id)),
        escapeHtml(field.title),
        escapeHtml(field.type),
        escapeHtml(field.custom_field_options.map((option) => option.value).join(", ")),
        badge(field.active ? "active" : "inactive"),
      ]);
    const customRows = zs.customFields
      .all()
      .map((field) => [escapeHtml(field.kind), escapeHtml(field.key), escapeHtml(field.title), escapeHtml(field.type)]);
    const statusRows = zs.customStatuses
      .all()
      .map((status) => [
        escapeHtml(String(status.zd_id)),
        escapeHtml(status.status_category),
        escapeHtml(status.agent_label),
        escapeHtml(status.default ? "default" : ""),
      ]);
    return (
      section(
        "Ticket Fields",
        table(["ID", "Title", "Type", "Options", "State"], ticketFieldRows, "No ticket fields."),
      ) +
      section(
        "User And Organization Fields",
        table(["Kind", "Key", "Title", "Type"], customRows, "No custom fields."),
      ) +
      section("Custom Statuses", table(["ID", "Category", "Label", "Default"], statusRows, "No custom statuses."))
    );
  }

  function rulesView(): string {
    const triggerRows = [...zs.triggers.all()]
      .sort((a, b) => a.position - b.position)
      .map((trigger) => [
        escapeHtml(String(trigger.zd_id)),
        escapeHtml(trigger.title),
        badge(trigger.active ? "active" : "inactive"),
        escapeHtml(JSON.stringify(trigger.conditions)),
        escapeHtml(trigger.actions.map((action) => action.field).join(", ")),
      ]);
    const viewRows = [...zs.views.all()]
      .sort((a, b) => a.position - b.position)
      .map((view) => [
        escapeHtml(String(view.zd_id)),
        escapeHtml(view.title),
        badge(view.active ? "active" : "inactive"),
      ]);
    const macroRows = [...zs.macros.all()]
      .sort((a, b) => a.position - b.position)
      .map((macro) => [
        escapeHtml(String(macro.zd_id)),
        escapeHtml(macro.title),
        escapeHtml(macro.actions.map((action) => action.field).join(", ")),
      ]);
    return (
      section("Triggers", table(["ID", "Title", "State", "Conditions", "Actions"], triggerRows, "No triggers.")) +
      section("Views", table(["ID", "Title", "State"], viewRows, "No views.")) +
      section("Macros", table(["ID", "Title", "Actions"], macroRows, "No macros."))
    );
  }

  function webhooksView(): string {
    const webhookRows = zs.webhooks
      .all()
      .map((webhook) => [
        escapeHtml(webhook.zd_id),
        escapeHtml(webhook.name),
        escapeHtml(webhook.endpoint),
        badge(webhook.status),
        escapeHtml(webhook.subscriptions.join(", ")),
        escapeHtml(webhook.authentication?.type ?? "none"),
        escapeHtml(maskSecret(webhook.signing_secret)),
      ]);
    const invocationRows = zs.webhookInvocations
      .all()
      .slice(-100)
      .reverse()
      .map((invocation) => [
        escapeHtml(invocation.zd_id),
        escapeHtml(zs.webhooks.findOneBy("zd_id", invocation.webhook_id)?.name ?? invocation.webhook_id),
        escapeHtml(invocation.event_type ?? (invocation.trigger_id ? `trigger ${invocation.trigger_id}` : "")),
        badge(invocation.status),
        escapeHtml(String(invocation.status_code ?? "")),
        escapeHtml(invocation.error_message ?? ""),
        escapeHtml(invocation.completed_at),
      ]);
    return (
      section(
        "Webhooks",
        table(
          ["ID", "Name", "Endpoint", "Status", "Subscriptions", "Auth", "Signing secret"],
          webhookRows,
          "No webhooks.",
        ),
      ) +
      section(
        "Invocations",
        table(["ID", "Webhook", "Source", "Status", "HTTP", "Error", "Completed"], invocationRows, "No invocations."),
      )
    );
  }

  function eventsView(): string {
    const rows = zs.events
      .all()
      .slice(-200)
      .reverse()
      .map((event) => [
        escapeHtml(event.zd_id),
        escapeHtml(event.type),
        escapeHtml(event.subject),
        escapeHtml(JSON.stringify(event.event)),
        escapeHtml(event.time),
      ]);
    return section("Events", table(["ID", "Type", "Subject", "Change", "Time"], rows, "No events."));
  }

  function authView(): string {
    const site = [
      ["Subdomain", escapeHtml(subdomain(zs))],
      ["Account ID", escapeHtml(String(accountId(zs)))],
      ["API base URL", escapeHtml(`${baseUrl}/api/v2`)],
    ];
    const tokenRows = zs.apiTokens
      .all()
      .map((token) => [
        escapeHtml(token.description),
        escapeHtml(token.email ?? "any agent"),
        escapeHtml(maskSecret(token.token)),
      ]);
    const oauthRows = zs.oauthTokens
      .all()
      .map((token) => [
        escapeHtml(userName(token.user_id)),
        escapeHtml(token.scopes.join(" ")),
        escapeHtml(maskSecret(token.token)),
      ]);
    return (
      section("Account", table(["Setting", "Value"], site, "No account.")) +
      section("API Tokens", table(["Description", "Bound email", "Token"], tokenRows, "No API tokens.")) +
      section("OAuth Tokens", table(["User", "Scopes", "Token"], oauthRows, "No OAuth tokens."))
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
