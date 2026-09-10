import type { AppEnv, Hono, InspectorTab } from "@emulators/core";
import { escapeHtml, renderInspectorPage } from "@emulators/core";
import type { GStore } from "../store.js";

const SERVICE_LABEL = "Microsoft Graph";
const TABS: InspectorTab[] = [
  { id: "users", label: "Users", href: "/?tab=users" },
  { id: "roles", label: "Role Assignments", href: "/?tab=roles" },
  { id: "invitations", label: "Invitations", href: "/?tab=invitations" },
  { id: "groups", label: "Groups", href: "/?tab=groups" },
  { id: "tenants", label: "Tenants", href: "/?tab=tenants" },
  { id: "events", label: "Events", href: "/?tab=events" },
  { id: "auth", label: "Auth", href: "/?tab=auth" },
];

type TabId = (typeof TABS)[number]["id"];

function maskSecret(value: string): string {
  return value.length <= 8 ? "****" : `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function inspectorRoutes(app: Hono<AppEnv>, gs: GStore, baseUrl: string): void {
  const tenantName = (tenantId: string) => gs.tenants.findOneBy("tenant_id", tenantId)?.display_name ?? tenantId;
  const roleName = (roleId: string) => gs.roleDefinitions.findOneBy("role_id", roleId)?.displayName ?? roleId;
  const userLabel = (objectId: string) => gs.users.findOneBy("object_id", objectId)?.userPrincipalName ?? objectId;

  app.get("/", (c) => {
    const requested = c.req.query("tab") ?? "users";
    const active = TABS.some((tab) => tab.id === requested) ? (requested as TabId) : "users";
    const views: Record<TabId, () => string> = {
      users: usersView,
      roles: rolesView,
      invitations: invitationsView,
      groups: groupsView,
      tenants: tenantsView,
      events: eventsView,
      auth: authView,
    };
    return c.html(renderInspectorPage("Microsoft Graph Inspector", TABS, active, views[active](), SERVICE_LABEL));
  });

  function usersView(): string {
    const rows = [...gs.users.all()]
      .sort((a, b) => a.id - b.id)
      .map((user) => [
        escapeHtml(user.userPrincipalName),
        code(user.object_id),
        escapeHtml(tenantName(user.tenant_id)),
        escapeHtml(user.displayName),
        escapeHtml(user.mail ?? ""),
        badge(user.userType),
        badge(user.deleted ? "deleted" : user.accountEnabled ? "enabled" : "disabled"),
        escapeHtml(user.externalUserState ?? ""),
        escapeHtml(
          gs.roleAssignments
            .findBy("principalId", user.object_id)
            .map((assignment) => roleName(assignment.roleDefinitionId))
            .join(", "),
        ),
      ]);
    return section(
      "Users",
      table(["UPN", "Id", "Tenant", "Display name", "Mail", "Type", "State", "Redemption", "Roles"], rows, "No users."),
    );
  }

  function rolesView(): string {
    const assignments = [...gs.roleAssignments.all()]
      .sort((a, b) => a.id - b.id)
      .map((assignment) => [
        escapeHtml(roleName(assignment.roleDefinitionId)),
        code(assignment.roleDefinitionId),
        escapeHtml(userLabel(assignment.principalId)),
        escapeHtml(tenantName(assignment.tenant_id)),
        escapeHtml(assignment.directoryScopeId),
        code(assignment.assignment_id),
      ]);
    const definitions = gs.roleDefinitions
      .all()
      .map((role) => [
        escapeHtml(role.displayName),
        code(role.templateId),
        escapeHtml(role.description),
        escapeHtml(String(gs.roleAssignments.findBy("roleDefinitionId", role.role_id).length)),
      ]);
    return (
      section(
        "Role assignments",
        table(
          ["Role", "Role definition id", "Principal", "Tenant", "Scope", "Assignment id"],
          assignments,
          "No role assignments.",
        ),
      ) +
      section(
        "Role definitions",
        table(["Name", "Template id", "Description", "Assignments"], definitions, "No role definitions."),
      )
    );
  }

  function invitationsView(): string {
    const rows = [...gs.invitations.all()]
      .sort((a, b) => b.id - a.id)
      .map((invitation) => [
        escapeHtml(invitation.invitedUserEmailAddress),
        code(invitation.invitation_id),
        escapeHtml(tenantName(invitation.tenant_id)),
        escapeHtml(invitation.invitedUserDisplayName ?? ""),
        badge(invitation.status),
        badge(invitation.sendInvitationMessage ? "email sent" : "silent"),
        `<a href="${escapeHtml(invitation.inviteRedeemUrl)}">redeem</a>`,
        escapeHtml(invitation.inviteRedirectUrl),
        escapeHtml(invitation.created_at),
      ]);
    return section(
      "Invitations",
      `<p>Accept one with <code>POST /_graph/simulate/accept-invitation</code> or by opening its redeem link.</p>` +
        table(
          ["Email", "Id", "Tenant", "Display name", "Status", "Message", "Redeem", "Redirect", "Created"],
          rows,
          "No invitations.",
        ),
    );
  }

  function groupsView(): string {
    const rows = [...gs.groups.all()]
      .sort((a, b) => a.id - b.id)
      .map((group) => [
        escapeHtml(group.displayName),
        code(group.object_id),
        escapeHtml(tenantName(group.tenant_id)),
        escapeHtml(group.mail ?? ""),
        badge(group.securityEnabled ? "security" : "distribution"),
        escapeHtml(String(group.member_ids.length)),
      ]);
    return section("Groups", table(["Name", "Id", "Tenant", "Mail", "Type", "Members"], rows, "No groups."));
  }

  function tenantsView(): string {
    const rows = gs.tenants.all().map((tenant) => [
      escapeHtml(tenant.display_name),
      code(tenant.tenant_id),
      escapeHtml(tenant.domain),
      escapeHtml(tenant.verified_domains.join(", ")),
      escapeHtml(String(gs.users.findBy("tenant_id", tenant.tenant_id).filter((user) => !user.deleted).length)),
      escapeHtml(
        gs.apps
          .all()
          .filter((app_) => !app_.tenant_ids || app_.tenant_ids.includes(tenant.tenant_id))
          .map((app_) => app_.name)
          .join(", "),
      ),
    ]);
    return section(
      "Tenants",
      `<p>Request a token at <code>${escapeHtml(baseUrl)}/{tenantId}/oauth2/v2.0/token</code>; it only sees that tenant's directory.</p>` +
        table(["Name", "Tenant id", "Domain", "Verified domains", "Users", "Apps"], rows, "No tenants."),
    );
  }

  function eventsView(): string {
    const rows = [...gs.events.all()]
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
      `<p>Also available as JSON at <code>${escapeHtml(baseUrl)}/_graph/events</code>.</p>` +
        table(["Type", "Tenant", "Subject", "Detail", "Created"], rows, "No events yet."),
    );
  }

  function authView(): string {
    const apps = gs.apps
      .all()
      .map((app_) => [
        escapeHtml(app_.name),
        code(app_.client_id),
        `<code>${escapeHtml(maskSecret(app_.client_secret))}</code>`,
        escapeHtml(app_.tenant_ids ? app_.tenant_ids.map(tenantName).join(", ") : "all tenants"),
        escapeHtml(app_.permissions.length > 0 ? app_.permissions.join(", ") : "all application permissions"),
      ]);
    const tokens = [...gs.tokens.all()]
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
        `<p>Use <code>grant_type=client_credentials</code> with <code>scope=https://graph.microsoft.com/.default</code> at <code>${escapeHtml(baseUrl)}/{tenantId}/oauth2/v2.0/token</code>, then call <code>${escapeHtml(baseUrl)}/v1.0/...</code>. Apps seeded with a <code>permissions</code> list get 403 <code>Authorization_RequestDenied</code> outside it.</p>` +
          table(["Name", "Client id", "Secret", "Tenants", "Permissions"], apps, "No applications configured."),
      ) + section("Issued tokens", table(["Token", "Tenant", "Client id", "Expires"], tokens, "No tokens issued yet."))
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
