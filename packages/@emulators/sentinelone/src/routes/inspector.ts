import type { InspectorTab } from "@emulators/core";
import { escapeHtml, renderInspectorPage } from "@emulators/core";
import { accountName, siteActiveLicenses, siteName } from "../formatters.js";
import { tenant } from "../store.js";
import type { S1RouteContext } from "../route-utils.js";

const SERVICE_LABEL = "SentinelOne";
const TABS: InspectorTab[] = [
  { id: "hierarchy", label: "Accounts & Sites", href: "/?tab=hierarchy" },
  { id: "agents", label: "Agents", href: "/?tab=agents" },
  { id: "threats", label: "Threats", href: "/?tab=threats" },
  { id: "risks", label: "Vulnerabilities", href: "/?tab=risks" },
  { id: "users", label: "Users & Roles", href: "/?tab=users" },
  { id: "protection", label: "Exclusions", href: "/?tab=protection" },
  { id: "activities", label: "Activities", href: "/?tab=activities" },
  { id: "events", label: "Events", href: "/?tab=events" },
  { id: "auth", label: "Auth", href: "/?tab=auth" },
];

type TabId = (typeof TABS)[number]["id"];

function maskSecret(value: string): string {
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function inspectorRoutes(rc: S1RouteContext): void {
  const { app, ss, baseUrl } = rc;

  app.get("/", (c) => {
    const requested = c.req.query("tab") ?? "hierarchy";
    const active = TABS.some((tab) => tab.id === requested) ? (requested as TabId) : "hierarchy";
    const views: Record<TabId, () => string> = {
      hierarchy: hierarchyView,
      agents: agentsView,
      threats: threatsView,
      risks: risksView,
      users: usersView,
      protection: protectionView,
      activities: activitiesView,
      events: eventsView,
      auth: authView,
    };
    return c.html(renderInspectorPage("SentinelOne Inspector", TABS, active, views[active](), SERVICE_LABEL));
  });

  function hierarchyView(): string {
    const accountRows = [...ss.accounts.all()]
      .sort((a, b) => a.id - b.id)
      .map((account) => [
        escapeHtml(account.name),
        code(account.s1_id),
        badge(account.accountType ?? "n/a"),
        badge(account.usageType ?? "n/a"),
        badge(account.state),
        escapeHtml(account.licenses.bundles.map((bundle) => bundle.name).join(", ")),
        escapeHtml(
          String(ss.sites.findBy("account_id", account.s1_id).filter((site) => site.state === "active").length),
        ),
        escapeHtml(account.expiration ?? "unlimited"),
      ]);
    const siteRows = [...ss.sites.all()]
      .sort((a, b) => a.id - b.id)
      .map((site) => [
        escapeHtml(site.name),
        code(site.s1_id),
        escapeHtml(accountName(ss, site.account_id) ?? ""),
        badge(site.siteType),
        badge(site.state),
        escapeHtml(site.externalId ?? ""),
        escapeHtml(String(siteActiveLicenses(ss, site.s1_id))),
        escapeHtml(String(ss.groups.findBy("site_id", site.s1_id).length)),
        escapeHtml(site.expiration ?? "unlimited"),
        code(maskSecret(site.registrationToken)),
      ]);
    const groupRows = [...ss.groups.all()]
      .sort((a, b) => a.id - b.id)
      .map((group) => [
        escapeHtml(group.name),
        code(group.s1_id),
        escapeHtml(siteName(ss, group.site_id) ?? ""),
        badge(group.type),
        group.isDefault ? badge("default") : "",
        escapeHtml(group.filter_id ? (ss.filters.findOneBy("s1_id", group.filter_id)?.name ?? group.filter_id) : ""),
        escapeHtml(String(ss.agents.findBy("group_id", group.s1_id).filter((agent) => !agent.isDecommissioned).length)),
      ]);
    return (
      section(
        `Tenant: ${escapeHtml(tenant(ss).name)}`,
        `<p>Console ${escapeHtml(tenant(ss).consoleUrl)}. API base <code>${escapeHtml(baseUrl)}/web/api/v2.1</code>.</p>`,
      ) +
      section(
        "Accounts",
        table(["Name", "Id", "Type", "Usage", "State", "Bundles", "Sites", "Expiration"], accountRows, "No accounts."),
      ) +
      section(
        "Sites",
        table(
          ["Name", "Id", "Account", "Type", "State", "External id", "Agents", "Groups", "Expiration", "Token"],
          siteRows,
          "No sites.",
        ),
      ) +
      section("Groups", table(["Name", "Id", "Site", "Type", "", "Filter", "Agents"], groupRows, "No groups."))
    );
  }

  function agentsView(): string {
    const rows = [...ss.agents.all()]
      .sort((a, b) => a.id - b.id)
      .map((agent) => [
        escapeHtml(agent.computerName),
        code(agent.s1_id),
        escapeHtml(siteName(ss, agent.site_id) ?? ""),
        escapeHtml(ss.groups.findOneBy("s1_id", agent.group_id)?.name ?? ""),
        badge(agent.osType),
        escapeHtml(`${agent.osName} ${agent.osRevision}`),
        badge(agent.machineType),
        escapeHtml(agent.agentVersion),
        badge(agent.isDecommissioned ? "decommissioned" : agent.isActive ? "online" : "offline"),
        badge(agent.consoleMigrationStatus),
        escapeHtml(String(agent.activeThreats)),
        escapeHtml(agent.lastActiveDate),
      ]);
    return section(
      "Agents",
      `<p>Register agents with <code>POST /_sentinelone/simulate/agent</code> and simulate check-ins with <code>POST /_sentinelone/simulate/agent-checkin</code>.</p>` +
        table(
          [
            "Computer",
            "Id",
            "Site",
            "Group",
            "OS",
            "Revision",
            "Type",
            "Version",
            "State",
            "Migration",
            "Threats",
            "Last active",
          ],
          rows,
          "No agents.",
        ),
    );
  }

  function threatsView(): string {
    const rows = [...ss.threats.all()]
      .sort((a, b) => b.id - a.id)
      .map((threat) => [
        escapeHtml(threat.threatName),
        code(threat.s1_id),
        escapeHtml(ss.agents.findOneBy("s1_id", threat.agent_id)?.computerName ?? ""),
        badge(threat.confidenceLevel),
        badge(threat.mitigationStatus),
        badge(threat.incidentStatus),
        badge(threat.analystVerdict),
        escapeHtml(threat.classification),
        escapeHtml(threat.identifiedAt),
      ]);
    return section(
      "Threats",
      `<p>Simulate detections with <code>POST /_sentinelone/simulate/threat</code>.</p>` +
        table(
          ["Name", "Id", "Agent", "Confidence", "Mitigation", "Incident", "Verdict", "Classification", "Identified"],
          rows,
          "No threats.",
        ),
    );
  }

  function risksView(): string {
    const applicationRows = [...ss.applications.all()]
      .sort((a, b) => a.id - b.id)
      .map((application) => [
        escapeHtml(application.name),
        code(application.s1_id),
        escapeHtml(application.vendor),
        escapeHtml(application.version),
        escapeHtml(ss.agents.findOneBy("s1_id", application.agent_id)?.computerName ?? ""),
        badge(application.highestSeverity),
        escapeHtml(String(application.cveCount)),
      ]);
    const cveRows = [...ss.cves.all()]
      .sort((a, b) => a.id - b.id)
      .map((cve) => [
        code(cve.cveId),
        escapeHtml(ss.applications.findOneBy("s1_id", cve.application_id)?.name ?? ""),
        badge(cve.severity),
        escapeHtml(cve.baseScore === null ? "" : String(cve.baseScore)),
        badge(cve.analystVerdict),
        badge(cve.status),
        escapeHtml(cve.detectionDate),
      ]);
    return (
      section(
        "Applications",
        table(
          ["Application", "Id", "Vendor", "Version", "Endpoint", "Highest severity", "CVEs"],
          applicationRows,
          "No applications.",
        ),
      ) +
      section(
        "CVEs",
        `<p>Simulate findings with <code>POST /_sentinelone/simulate/vulnerability</code>.</p>` +
          table(["CVE", "Application", "Severity", "Score", "Verdict", "Status", "Detected"], cveRows, "No CVEs."),
      )
    );
  }

  function usersView(): string {
    const userRows = [...ss.users.all()]
      .sort((a, b) => a.id - b.id)
      .map((user) => [
        escapeHtml(user.email),
        code(user.s1_id),
        escapeHtml(user.fullName),
        badge(user.scope),
        escapeHtml(
          user.scopeRoles
            .map(
              (role) =>
                `${ss.roles.findOneBy("s1_id", role.roleId)?.name ?? role.roleId} @ ${accountName(ss, role.id) ?? siteName(ss, role.id) ?? role.id}`,
            )
            .join("; "),
        ),
        badge(user.twoFaEnabled ? "2fa" : "no 2fa"),
        escapeHtml(String(user.onboardingEmailsSent)),
        escapeHtml(String(user.resetPasswordEmailsSent)),
      ]);
    const roleRows = [...ss.roles.all()]
      .sort((a, b) => a.id - b.id)
      .map((role) => [
        escapeHtml(role.name),
        code(role.s1_id),
        badge(role.scope),
        badge(role.predefinedRole ? "predefined" : "custom"),
        escapeHtml(role.description),
        escapeHtml(
          String(
            ss.users.all().filter((user) => user.scopeRoles.some((scopeRole) => scopeRole.roleId === role.s1_id))
              .length,
          ),
        ),
      ]);
    return (
      section(
        "Users",
        table(
          ["Email", "Id", "Name", "Scope", "Roles", "2FA", "Onboarding emails", "Reset emails"],
          userRows,
          "No users.",
        ),
      ) + section("RBAC roles", table(["Name", "Id", "Scope", "", "Description", "Users"], roleRows, "No roles."))
    );
  }

  function protectionView(): string {
    const scopeLabel = (level: string, id: string | null) =>
      level === "tenant"
        ? "tenant"
        : `${level} ${accountName(ss, id) ?? siteName(ss, id) ?? ss.groups.findOneBy("s1_id", id ?? "")?.name ?? id}`;
    const exclusionRows = [...ss.exclusions.all()]
      .sort((a, b) => a.id - b.id)
      .map((exclusion) => [
        badge(exclusion.unified ? "unified" : "legacy"),
        code(exclusion.s1_id),
        badge(exclusion.type),
        badge(exclusion.osType),
        escapeHtml(exclusion.value ?? ""),
        escapeHtml(exclusion.exclusionName ?? exclusion.description ?? ""),
        escapeHtml(exclusion.mode ?? exclusion.interactionLevel ?? ""),
        escapeHtml(scopeLabel(exclusion.scope_level, exclusion.scope_id)),
      ]);
    const restrictionRows = [...ss.restrictions.all()]
      .sort((a, b) => a.id - b.id)
      .map((restriction) => [
        code(restriction.s1_id),
        badge(restriction.type),
        badge(restriction.osType),
        escapeHtml(restriction.value ?? restriction.sha256Value ?? ""),
        escapeHtml(restriction.description),
        escapeHtml(scopeLabel(restriction.scope_level, restriction.scope_id)),
      ]);
    const deviceRows = [...ss.deviceRules.all()]
      .sort((a, b) => a.order - b.order)
      .map((rule) => [
        escapeHtml(String(rule.order)),
        escapeHtml(rule.ruleName),
        code(rule.s1_id),
        badge(rule.interface),
        badge(rule.ruleType),
        badge(rule.action),
        badge(rule.status),
        escapeHtml(scopeLabel(rule.scope_level, rule.scope_id)),
      ]);
    return (
      section(
        "Exclusions",
        table(["Kind", "Id", "Type", "OS", "Value", "Name", "Mode", "Scope"], exclusionRows, "No exclusions."),
      ) +
      section(
        "Blocklist",
        table(["Id", "Type", "OS", "Value", "Description", "Scope"], restrictionRows, "No restrictions."),
      ) +
      section(
        "Device control",
        table(
          ["Order", "Rule", "Id", "Interface", "Type", "Action", "Status", "Scope"],
          deviceRows,
          "No device rules.",
        ),
      )
    );
  }

  function activitiesView(): string {
    const rows = [...ss.activities.all()]
      .sort((a, b) => b.id - a.id)
      .slice(0, 300)
      .map((activity) => [
        escapeHtml(String(activity.activityType)),
        escapeHtml(activity.primaryDescription),
        escapeHtml(siteName(ss, activity.site_id) ?? accountName(ss, activity.account_id) ?? ""),
        escapeHtml(activity.created_at),
      ]);
    return section(
      "Activities",
      `<p>Also served at <code>GET /web/api/v2.1/activities</code>.</p>` +
        table(["Type", "Description", "Scope", "Created"], rows, "No activities yet."),
    );
  }

  function eventsView(): string {
    const rows = [...ss.events.all()]
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
      `<p>Also available as JSON at <code>${escapeHtml(baseUrl)}/_sentinelone/events</code>.</p>` +
        table(["Type", "Subject", "Detail", "Created"], rows, "No events yet."),
    );
  }

  function authView(): string {
    const rows = ss.apiTokens
      .all()
      .map((apiToken) => [
        `<code>${escapeHtml(maskSecret(apiToken.token))}</code>`,
        escapeHtml(apiToken.description),
        escapeHtml(
          apiToken.user_id ? (ss.users.findOneBy("s1_id", apiToken.user_id)?.email ?? apiToken.user_id) : "service",
        ),
        escapeHtml(apiToken.expires_at ?? "never"),
        escapeHtml(apiToken.created_at),
      ]);
    return section(
      "API tokens",
      `<p>Send <code>Authorization: ApiToken &lt;token&gt;</code>. Routes live under <code>${escapeHtml(baseUrl)}/web/api/v2.1</code> (and <code>/web/api/v2.0</code>). <code>POST /users/generate-api-token</code> mints a user token.</p>` +
        table(["Token", "Description", "User", "Expires", "Created"], rows, "No API tokens configured."),
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
  <h2>${title}</h2>
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
