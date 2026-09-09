import type { InspectorTab } from "@emulators/core";
import { escapeHtml, renderInspectorPage } from "@emulators/core";
import { ARTICLE_STATUS_PUBLISHED, articleStatus, articleUrl, driveItemUrl } from "../formatters.js";
import { knowledgeBaseUrl, projectId, projectName } from "../store.js";
import type { D360RouteContext } from "../route-utils.js";

const SERVICE_LABEL = "Document360";
const TABS: InspectorTab[] = [
  { id: "articles", label: "Articles", href: "/?tab=articles" },
  { id: "categories", label: "Categories", href: "/?tab=categories" },
  { id: "versions", label: "Versions", href: "/?tab=versions" },
  { id: "readers", label: "Readers", href: "/?tab=readers" },
  { id: "teams", label: "Team", href: "/?tab=teams" },
  { id: "drive", label: "Drive", href: "/?tab=drive" },
  { id: "events", label: "Events", href: "/?tab=events" },
  { id: "auth", label: "Auth", href: "/?tab=auth" },
];

type TabId = (typeof TABS)[number]["id"];

function maskSecret(value: string): string {
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function inspectorRoutes(rc: D360RouteContext): void {
  const { app, ds, fmt, baseUrl } = rc;

  app.get("/", (c) => {
    const requested = c.req.query("tab") ?? "articles";
    const active = TABS.some((tab) => tab.id === requested) ? (requested as TabId) : "articles";
    const views: Record<TabId, () => string> = {
      articles: articlesView,
      categories: categoriesView,
      versions: versionsView,
      readers: readersView,
      teams: teamsView,
      drive: driveView,
      events: eventsView,
      auth: authView,
    };
    return c.html(renderInspectorPage("Document360 Inspector", TABS, active, views[active](), SERVICE_LABEL));
  });

  const versionLabel = (versionId: string) => {
    const version = ds.projectVersions.findOneBy("d360_id", versionId);
    return version ? version.version_code_name || `v${version.version_number}` : versionId;
  };

  function articlesView(): string {
    const rows = [...ds.articles.all()]
      .filter((article) => !article.deleted)
      .sort((a, b) => a.id - b.id)
      .map((article) => {
        const category = ds.categories
          .findBy("d360_id", article.category_id)
          .find((candidate) => candidate.language_code === article.language_code);
        return [
          `<a href="${escapeHtml(articleUrl(fmt, article))}">${escapeHtml(article.title)}</a>`,
          code(article.d360_id),
          escapeHtml(article.language_code),
          escapeHtml(category?.name ?? article.category_id),
          escapeHtml(versionLabel(article.project_version_id)),
          badge(articleStatus(article) === ARTICLE_STATUS_PUBLISHED ? "published" : "draft"),
          escapeHtml(
            `${article.latest_version}${article.public_version !== null ? ` (public ${article.public_version})` : ""}`,
          ),
          escapeHtml(article.updated_at),
        ];
      });
    return section(
      "Articles",
      table(["Title", "Id", "Lang", "Category", "Version", "Status", "Revisions", "Modified"], rows, "No articles."),
    );
  }

  function categoriesView(): string {
    const rows = [...ds.categories.all()]
      .sort((a, b) => a.id - b.id)
      .map((category) => {
        const parent = category.parent_category_id
          ? ds.categories
              .findBy("d360_id", category.parent_category_id)
              .find((candidate) => candidate.language_code === category.language_code)
          : undefined;
        return [
          escapeHtml(category.name),
          code(category.d360_id),
          escapeHtml(category.language_code),
          escapeHtml(parent?.name ?? ""),
          escapeHtml(versionLabel(category.project_version_id)),
          badge(["folder", "page", "index"][category.category_type] ?? String(category.category_type)),
          escapeHtml(
            String(
              ds.articles.count(
                (article) =>
                  article.category_id === category.d360_id &&
                  article.language_code === category.language_code &&
                  !article.deleted,
              ),
            ),
          ),
        ];
      });
    return section(
      "Categories",
      table(["Name", "Id", "Lang", "Parent", "Version", "Type", "Articles"], rows, "No categories."),
    );
  }

  function versionsView(): string {
    const rows = [...ds.projectVersions.all()]
      .sort((a, b) => a.order - b.order)
      .map((version) => [
        escapeHtml(version.version_code_name || `v${version.version_number}`),
        code(version.d360_id),
        escapeHtml(String(version.version_number)),
        escapeHtml(version.slug),
        escapeHtml(
          version.languages.map((language) => `${language.code}${language.is_default ? " (default)" : ""}`).join(", "),
        ),
        badge(
          version.is_main_version ? "main" : version.is_deprecated ? "deprecated" : version.is_beta ? "beta" : "active",
        ),
      ]);
    return section(
      `Project: ${escapeHtml(projectName(ds))}`,
      `<p>Project id ${code(projectId(ds))}, knowledge base ${escapeHtml(knowledgeBaseUrl(ds))}.</p>` +
        table(["Name", "Id", "Number", "Slug", "Languages", "State"], rows, "No project versions."),
    );
  }

  function readersView(): string {
    const readerRows = [...ds.readers.all()]
      .sort((a, b) => a.id - b.id)
      .map((reader) => [
        escapeHtml(reader.email),
        code(reader.d360_id),
        escapeHtml(`${reader.first_name} ${reader.last_name}`.trim()),
        escapeHtml(
          ds.readerGroups
            .all()
            .filter((group) => group.reader_ids.includes(reader.d360_id))
            .map((group) => group.title)
            .join(", "),
        ),
        escapeHtml(String(reader.access_level)),
        escapeHtml(reader.invited_by ?? ""),
        badge(reader.is_sso_user ? "sso" : "standard"),
      ]);
    const groupRows = [...ds.readerGroups.all()]
      .sort((a, b) => a.id - b.id)
      .map((group) => [
        escapeHtml(group.title),
        code(group.d360_id),
        escapeHtml(group.description),
        escapeHtml(String(group.reader_ids.length)),
        escapeHtml(String(group.access_level)),
      ]);
    return (
      section(
        "Readers",
        table(["Email", "Id", "Name", "Groups", "Access level", "Invited by", "Type"], readerRows, "No readers."),
      ) +
      section(
        "Reader groups",
        table(["Title", "Id", "Description", "Readers", "Access level"], groupRows, "No reader groups."),
      )
    );
  }

  function teamsView(): string {
    const accountRows = [...ds.teamAccounts.all()]
      .sort((a, b) => a.id - b.id)
      .map((account) => [
        escapeHtml(account.email),
        code(account.d360_id),
        escapeHtml(`${account.first_name} ${account.last_name}`.trim()),
        badge(account.portal_role),
        escapeHtml(
          ds.teamGroups
            .all()
            .filter((group) => group.account_ids.includes(account.d360_id))
            .map((group) => group.title)
            .join(", "),
        ),
        badge(account.accepted ? "accepted" : "invited"),
      ]);
    const groupRows = [...ds.teamGroups.all()]
      .sort((a, b) => a.id - b.id)
      .map((group) => [
        escapeHtml(group.title),
        code(group.d360_id),
        badge(group.portal_role),
        escapeHtml(String(group.account_ids.length)),
      ]);
    return (
      section(
        "Team accounts",
        table(["Email", "Id", "Name", "Role", "Groups", "State"], accountRows, "No team accounts."),
      ) + section("Team groups", table(["Title", "Id", "Role", "Members"], groupRows, "No team groups."))
    );
  }

  function driveView(): string {
    const folderRows = [...ds.driveFolders.all()]
      .sort((a, b) => a.id - b.id)
      .map((folder) => [
        escapeHtml(folder.title),
        code(folder.d360_id),
        escapeHtml(
          folder.parent_folder_id
            ? (ds.driveFolders.findOneBy("d360_id", folder.parent_folder_id)?.title ?? folder.parent_folder_id)
            : "",
        ),
        escapeHtml(String(ds.driveItems.count((item) => item.folder_id === folder.d360_id))),
        badge(folder.is_system ? "system" : "custom"),
      ]);
    const itemRows = [...ds.driveItems.all()]
      .sort((a, b) => a.id - b.id)
      .map((item) => [
        `<a href="${escapeHtml(driveItemUrl(fmt, item))}">${escapeHtml(item.title)}</a>`,
        code(item.d360_id),
        escapeHtml(ds.driveFolders.findOneBy("d360_id", item.folder_id)?.title ?? item.folder_id),
        escapeHtml(item.content_type),
        escapeHtml(`${item.size} B`),
        escapeHtml(item.tags.join(", ")),
      ]);
    return (
      section("Folders", table(["Title", "Id", "Parent", "Items", "Type"], folderRows, "No folders.")) +
      section("Items", table(["Title", "Id", "Folder", "Content type", "Size", "Tags"], itemRows, "No drive items."))
    );
  }

  function eventsView(): string {
    const rows = [...ds.events.all()]
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
      `<p>Also available as JSON at <code>${escapeHtml(baseUrl)}/_document360/events</code>.</p>` +
        table(["Type", "Subject", "Detail", "Created"], rows, "No events yet."),
    );
  }

  function authView(): string {
    const rows = ds.apiTokens
      .all()
      .map((token) => [
        `<code>${escapeHtml(maskSecret(token.token))}</code>`,
        escapeHtml(token.description),
        escapeHtml(token.created_at),
      ]);
    return section(
      "API tokens",
      `<p>Send the token in the <code>api_token</code> header on every request. Routes are served under both <code>/v2</code> and <code>/v1</code>. Base URL: <code>${escapeHtml(baseUrl)}/v2</code>.</p>` +
        table(["Token", "Description", "Created"], rows, "No API tokens configured."),
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
