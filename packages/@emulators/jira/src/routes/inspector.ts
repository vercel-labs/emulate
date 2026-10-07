import type { InspectorTab, RouteContext } from "@emulators/core";
import { escapeHtml, renderCardPage, renderErrorPage, renderInspectorPage } from "@emulators/core";
import { getJiraStore } from "../store.js";
import { adfToText } from "../adf.js";
import { findIssue } from "../lookup.js";

const SERVICE_LABEL = "Jira";
const TABS: InspectorTab[] = [
  { id: "issues", label: "Issues", href: "/?tab=issues" },
  { id: "projects", label: "Projects", href: "/?tab=projects" },
  { id: "boards", label: "Boards", href: "/?tab=boards" },
  { id: "users", label: "Users", href: "/?tab=users" },
  { id: "webhooks", label: "Webhooks", href: "/?tab=webhooks" },
  { id: "auth", label: "Auth", href: "/?tab=auth" },
];

function mask(secret: string): string {
  return secret.length <= 8 ? "********" : `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

export function inspectorRoutes({ app, store }: RouteContext): void {
  const js = () => getJiraStore(store);
  const userName = (id: string | null) => (id ? (js().users.findOneBy("account_id", id)?.display_name ?? id) : "");

  app.get("/", (c) => {
    const requested = c.req.query("tab") ?? "issues";
    const active = TABS.some((tab) => tab.id === requested) ? requested : "issues";
    const views: Record<string, () => string> = {
      issues: issuesView,
      projects: projectsView,
      boards: boardsView,
      users: usersView,
      webhooks: webhooksView,
      auth: authView,
    };
    return c.html(renderInspectorPage("Jira Inspector", TABS, active, views[active](), SERVICE_LABEL));
  });

  app.get("/browse/:key", (c) => {
    const issue = findIssue(js(), c.req.param("key"));
    if (!issue) {
      return c.html(
        renderErrorPage("Issue not found", `No issue with key ${c.req.param("key")} exists.`, SERVICE_LABEL),
        404,
      );
    }
    const status = js().statuses.get(issue.status_id)?.name ?? "";
    const type = js().issueTypes.get(issue.issue_type_id)?.name ?? "";
    const priority = issue.priority_id ? (js().priorities.get(issue.priority_id)?.name ?? "") : "";
    const details = table(
      ["Field", "Value"],
      [
        ["Type", escapeHtml(type)],
        ["Status", `<span class="badge badge-granted">${escapeHtml(status)}</span>`],
        ["Priority", escapeHtml(priority)],
        ["Assignee", escapeHtml(userName(issue.assignee_id) || "Unassigned")],
        ["Reporter", escapeHtml(userName(issue.reporter_id))],
        ["Labels", escapeHtml(issue.labels.join(", "))],
        ["Description", escapeHtml(adfToText(issue.description))],
      ],
      "",
    );
    const comments = js()
      .comments.findBy("issue_id", issue.id)
      .sort((a, b) => a.id - b.id)
      .map((comment) => [
        escapeHtml(userName(comment.author_id)),
        escapeHtml(adfToText(comment.body)),
        escapeHtml(comment.created_at),
      ]);
    return c.html(
      renderCardPage(
        `${issue.key}: ${issue.summary}`,
        escapeHtml(js().projects.get(issue.project_id)?.name ?? ""),
        details + section("Comments", table(["Author", "Comment", "Created"], comments, "No comments.")),
        SERVICE_LABEL,
      ),
    );
  });

  function issuesView(): string {
    const rows = js()
      .issues.all()
      .sort((a, b) => b.id - a.id)
      .map((issue) => [
        `<a href="/browse/${escapeHtml(issue.key)}">${escapeHtml(issue.key)}</a>`,
        escapeHtml(js().issueTypes.get(issue.issue_type_id)?.name ?? ""),
        escapeHtml(issue.summary),
        escapeHtml(js().statuses.get(issue.status_id)?.name ?? ""),
        escapeHtml(issue.priority_id ? (js().priorities.get(issue.priority_id)?.name ?? "") : ""),
        escapeHtml(userName(issue.assignee_id)),
        escapeHtml(issue.labels.join(", ")),
        escapeHtml(issue.updated_at),
      ]);
    return section(
      "Issues",
      table(["Key", "Type", "Summary", "Status", "Priority", "Assignee", "Labels", "Updated"], rows, "No issues."),
    );
  }

  function projectsView(): string {
    const rows = js()
      .projects.all()
      .map((project) => [
        escapeHtml(project.key),
        escapeHtml(project.name),
        escapeHtml(String(project.id)),
        escapeHtml(userName(project.lead_account_id)),
        escapeHtml(
          project.status_ids
            .map((id) => js().statuses.get(id)?.name)
            .filter(Boolean)
            .join(" > "),
        ),
        escapeHtml(String(js().issues.findBy("project_id", project.id).length)),
      ]);
    return section("Projects", table(["Key", "Name", "ID", "Lead", "Workflow", "Issues"], rows, "No projects."));
  }

  function boardsView(): string {
    const boardRows = js()
      .boards.all()
      .map((board) => [
        escapeHtml(String(board.id)),
        escapeHtml(board.name),
        escapeHtml(board.type),
        escapeHtml(js().projects.get(board.project_id)?.key ?? ""),
      ]);
    const sprintRows = js()
      .sprints.all()
      .map((sprint) => [
        escapeHtml(String(sprint.id)),
        escapeHtml(sprint.name),
        escapeHtml(sprint.state),
        escapeHtml(js().boards.get(sprint.board_id)?.name ?? ""),
        escapeHtml(String(js().issues.findBy("sprint_id", sprint.id).length)),
        escapeHtml(sprint.goal),
      ]);
    return (
      section("Boards", table(["ID", "Name", "Type", "Project"], boardRows, "No boards.")) +
      section("Sprints", table(["ID", "Name", "State", "Board", "Issues", "Goal"], sprintRows, "No sprints."))
    );
  }

  function usersView(): string {
    const rows = js()
      .users.all()
      .map((user) => [
        escapeHtml(user.display_name),
        escapeHtml(user.email),
        escapeHtml(user.account_id),
        user.admin ? '<span class="badge badge-granted">admin</span>' : "",
        user.active ? "active" : "inactive",
      ]);
    return section("Users", table(["Name", "Email", "Account ID", "Role", "Status"], rows, "No users."));
  }

  function webhooksView(): string {
    const hookRows = js()
      .webhooks.all()
      .map((hook) => [
        escapeHtml(String(hook.id)),
        escapeHtml(hook.name),
        escapeHtml(hook.kind),
        escapeHtml(hook.url),
        escapeHtml(hook.events.join(", ")),
        escapeHtml(hook.jql_filter ?? ""),
        hook.enabled ? "enabled" : "disabled",
      ]);
    const deliveryRows = js()
      .webhookDeliveries.all()
      .sort((a, b) => b.id - a.id)
      .slice(0, 100)
      .map((delivery) => [
        escapeHtml(delivery.event),
        escapeHtml(delivery.url),
        escapeHtml(delivery.status === null ? "" : String(delivery.status)),
        escapeHtml(delivery.error ?? ""),
        escapeHtml(delivery.created_at),
      ]);
    return (
      section("Webhooks", table(["ID", "Name", "Kind", "URL", "Events", "JQL", "State"], hookRows, "No webhooks.")) +
      section("Deliveries", table(["Event", "URL", "Status", "Error", "Sent"], deliveryRows, "No deliveries yet."))
    );
  }

  function authView(): string {
    const tokenRows = js()
      .apiTokens.all()
      .map((token) => {
        const user = js().users.findOneBy("account_id", token.account_id);
        return [escapeHtml(user?.email ?? token.account_id), escapeHtml(mask(token.token))];
      });
    const appRows = js()
      .oauthApps.all()
      .map((oauthApp) => [
        escapeHtml(oauthApp.name),
        escapeHtml(oauthApp.client_id),
        escapeHtml(mask(oauthApp.client_secret)),
        escapeHtml(oauthApp.redirect_uris.join(", ")),
        escapeHtml(oauthApp.scopes.join(" ")),
      ]);
    const siteRows = js()
      .sites.all()
      .map((site) => [escapeHtml(site.name), escapeHtml(site.cloud_id)]);
    return (
      section("API tokens (Basic auth email:token)", table(["Email", "Token"], tokenRows, "No API tokens.")) +
      section(
        "OAuth 2.0 apps",
        table(["Name", "Client ID", "Secret", "Redirect URIs", "Scopes"], appRows, "No OAuth apps."),
      ) +
      section("Sites (cloud IDs)", table(["Name", "Cloud ID"], siteRows, "No sites."))
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
  return `<div class="inspector-scroll"><table class="inspector-table">
  <thead><tr>${headerHtml}</tr></thead>
  <tbody>
${rowHtml}
  </tbody>
</table></div>`;
}
