import type { InspectorTab, RouteContext } from "@emulators/core";
import { escapeAttr, escapeHtml, renderInspectorPage } from "@emulators/core";
import { getLinearStore } from "../store.js";
import type { LinearUser } from "../entities.js";

const SERVICE_LABEL = "Linear";

const TABS: InspectorTab[] = [
  { id: "issues", label: "Issues", href: "/?tab=issues" },
  { id: "teams", label: "Teams", href: "/?tab=teams" },
  { id: "users", label: "Users", href: "/?tab=users" },
  { id: "projects", label: "Projects", href: "/?tab=projects" },
  { id: "agents", label: "Agents", href: "/?tab=agents" },
  { id: "auth", label: "Auth", href: "/?tab=auth" },
  { id: "webhooks", label: "Webhooks", href: "/?tab=webhooks" },
];

type TabId = (typeof TABS)[number]["id"];

export function inspectorRoutes({ app, store }: RouteContext): void {
  const ls = () => getLinearStore(store);

  app.get("/", (c) => {
    const requested = c.req.query("tab") ?? "issues";
    const active = TABS.some((tab) => tab.id === requested) ? (requested as TabId) : "issues";
    const body =
      active === "teams"
        ? teamsView()
        : active === "users"
          ? usersView()
          : active === "projects"
            ? projectsView()
            : active === "agents"
              ? agentsView()
              : active === "auth"
                ? authView()
                : active === "webhooks"
                  ? webhooksView()
                  : issuesView();
    return c.html(renderInspectorPage("Linear Inspector", TABS, active, body, SERVICE_LABEL));
  });

  function issuesView(): string {
    const rows = ls()
      .issues.all()
      .sort((a, b) => a.identifier.localeCompare(b.identifier))
      .map((issue) => {
        const team = ls().teams.findOneBy("linear_id", issue.team_id);
        const state = ls().workflowStates.findOneBy("linear_id", issue.state_id);
        const assignee = issue.assignee_id ? ls().users.findOneBy("linear_id", issue.assignee_id) : undefined;
        const delegate = issue.delegate_id ? ls().users.findOneBy("linear_id", issue.delegate_id) : undefined;
        const labels = issue.label_ids
          .map((labelId) => ls().issueLabels.findOneBy("linear_id", labelId)?.name)
          .filter((name): name is string => Boolean(name))
          .join(", ");
        return [
          linkCell(`/?tab=issues&issue=${encodeURIComponent(issue.linear_id)}`, issue.identifier),
          escapeHtml(issue.title),
          escapeHtml(team?.key ?? issue.team_id),
          escapeHtml(state?.name ?? issue.state_id),
          escapeHtml(userLabel(assignee)),
          escapeHtml(userLabel(delegate)),
          escapeHtml(labels),
          escapeHtml(issue.updated_at),
        ];
      });
    return section(
      "Issues",
      table(["ID", "Title", "Team", "State", "Assignee", "Delegate", "Labels", "Updated"], rows, "No issues."),
    );
  }

  function teamsView(): string {
    const rows = ls()
      .teams.all()
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((team) => {
        const stateNames = ls()
          .workflowStates.findBy("team_id", team.linear_id)
          .sort((a, b) => a.position - b.position)
          .map((state) => state.name)
          .join(", ");
        const issueCount = ls().issues.count((issue) => issue.team_id === team.linear_id);
        return [
          escapeHtml(team.key),
          escapeHtml(team.name),
          escapeHtml(String(issueCount)),
          escapeHtml(stateNames),
          escapeHtml(team.private ? "private" : "public"),
        ];
      });
    return section("Teams", table(["Key", "Name", "Issues", "States", "Access"], rows, "No teams."));
  }

  function usersView(): string {
    const rows = ls()
      .users.all()
      .sort((a, b) => a.email.localeCompare(b.email))
      .map((user) => [
        escapeHtml(user.display_name),
        escapeHtml(user.email),
        escapeHtml(user.app ? "app" : "user"),
        escapeHtml(user.admin ? "admin" : "member"),
        escapeHtml(user.active ? "active" : "inactive"),
        escapeHtml(String(ls().issues.count((issue) => issue.assignee_id === user.linear_id))),
      ]);
    return section("Users", table(["Name", "Email", "Kind", "Role", "Status", "Assigned"], rows, "No users."));
  }

  function projectsView(): string {
    const projectRows = ls()
      .projects.all()
      .map((project) => [
        escapeHtml(project.name),
        escapeHtml(project.state),
        escapeHtml(
          project.team_id ? (ls().teams.findOneBy("linear_id", project.team_id)?.key ?? project.team_id) : "workspace",
        ),
        escapeHtml(String(ls().issues.count((issue) => issue.project_id === project.linear_id))),
      ]);
    const cycleRows = ls()
      .cycles.all()
      .map((cycle) => [
        escapeHtml(cycle.name),
        escapeHtml(String(cycle.number)),
        escapeHtml(ls().teams.findOneBy("linear_id", cycle.team_id)?.key ?? cycle.team_id),
        escapeHtml(String(ls().issues.count((issue) => issue.cycle_id === cycle.linear_id))),
      ]);
    return (
      section("Projects", table(["Name", "State", "Team", "Issues"], projectRows, "No projects.")) +
      section("Cycles", table(["Name", "Number", "Team", "Issues"], cycleRows, "No cycles."))
    );
  }

  function agentsView(): string {
    const rows = ls()
      .agentSessions.all()
      .map((session) => {
        const issue = session.issue_id ? ls().issues.findOneBy("linear_id", session.issue_id) : undefined;
        const agent = ls().users.findOneBy("linear_id", session.agent_user_id);
        return [
          escapeHtml(session.linear_id),
          escapeHtml(session.state),
          escapeHtml(issue?.identifier ?? ""),
          escapeHtml(userLabel(agent)),
          escapeHtml(String(ls().agentActivities.count((activity) => activity.session_id === session.linear_id))),
          escapeHtml(session.updated_at),
        ];
      });
    return section(
      "Agent Sessions",
      table(["ID", "State", "Issue", "Agent", "Activities", "Updated"], rows, "No agent sessions."),
    );
  }

  function authView(): string {
    const appRows = ls()
      .oauthApps.all()
      .map((oauthApp) => [
        escapeHtml(oauthApp.name),
        escapeHtml(oauthApp.client_id),
        escapeHtml(oauthApp.actor),
        escapeHtml(oauthApp.scopes.join(", ")),
        escapeHtml(oauthApp.app_user_id ? userLabel(ls().users.findOneBy("linear_id", oauthApp.app_user_id)) : ""),
      ]);
    const tokenRows = ls()
      .tokens.all()
      .map((token) => [
        escapeHtml(maskToken(token.token)),
        escapeHtml(token.type),
        escapeHtml(token.actor_type),
        escapeHtml(token.user_id ? userLabel(ls().users.findOneBy("linear_id", token.user_id)) : (token.app_id ?? "")),
        escapeHtml(token.scopes.join(", ")),
        escapeHtml(token.revoked ? "revoked" : (token.expires_at ?? "active")),
      ]);
    return (
      section("OAuth Apps", table(["Name", "Client ID", "Actor", "Scopes", "App User"], appRows, "No OAuth apps.")) +
      section("Tokens", table(["Token", "Type", "Actor", "Subject", "Scopes", "Status"], tokenRows, "No tokens."))
    );
  }

  function webhooksView(): string {
    const webhookRows = ls()
      .webhooks.all()
      .map((webhook) => [
        escapeHtml(webhook.label),
        escapeHtml(webhook.url),
        escapeHtml(webhook.enabled ? "enabled" : "disabled"),
        escapeHtml(webhook.resource_types.join(", ")),
        escapeHtml(
          webhook.team_id
            ? (ls().teams.findOneBy("linear_id", webhook.team_id)?.key ?? webhook.team_id)
            : "all public teams",
        ),
      ]);
    const deliveryRows = ls()
      .webhookDeliveries.all()
      .slice(-30)
      .reverse()
      .map((delivery) => [
        escapeHtml(delivery.event),
        escapeHtml(delivery.action),
        escapeHtml(String(delivery.status ?? "")),
        escapeHtml(delivery.error ?? ""),
        escapeHtml(delivery.url),
        escapeHtml(delivery.created_at),
      ]);
    return (
      section(
        "Webhook Subscriptions",
        table(["Label", "URL", "Status", "Resources", "Scope"], webhookRows, "No webhooks."),
      ) +
      section(
        "Webhook Deliveries",
        table(["Event", "Action", "Status", "Error", "URL", "Created"], deliveryRows, "No deliveries."),
      )
    );
  }
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

function linkCell(href: string, label: string): string {
  return `<a href="${escapeAttr(href)}">${escapeHtml(label)}</a>`;
}

function userLabel(user: LinearUser | undefined): string {
  return user?.display_name ?? user?.email ?? "";
}

function maskToken(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}
