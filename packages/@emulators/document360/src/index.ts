import type { AppEnv, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import type { CategoryType, D360Language, PortalRole } from "./entities.js";
import type { Fmt } from "./formatters.js";
import { guid, markdownToHtml, nowIso, slugify, uniqueSlug } from "./helpers.js";
import { articleRoutes } from "./routes/articles.js";
import { categoryRoutes } from "./routes/categories.js";
import { driveRoutes } from "./routes/drive.js";
import { inspectorRoutes } from "./routes/inspector.js";
import { miscRoutes } from "./routes/misc.js";
import { languageName, projectVersionRoutes } from "./routes/project-versions.js";
import { readerRoutes } from "./routes/readers.js";
import { teamRoutes } from "./routes/teams.js";
import type { D360RouteContext } from "./route-utils.js";
import { getD360Store, setKnowledgeBaseUrl, setProjectId, setProjectName, type D360Store } from "./store.js";

export { getD360Store, type D360Store } from "./store.js";
export * from "./entities.js";
export { markdownToHtml } from "./helpers.js";

export interface Document360SeedArticle {
  id?: string;
  title: string;
  content?: string;
  html_content?: string;
  slug?: string;
  description?: string;
  hidden?: boolean;
  tags?: string[];
  published?: boolean;
  author?: string;
}

export interface Document360SeedCategory {
  id?: string;
  name: string;
  description?: string;
  slug?: string;
  icon?: string;
  hidden?: boolean;
  category_type?: CategoryType;
  articles?: Document360SeedArticle[];
  categories?: Document360SeedCategory[];
}

export interface Document360SeedConfig {
  port?: number;
  baseUrl?: string;
  project_name?: string;
  project_id?: string;
  knowledge_base_url?: string;
  api_tokens?: Array<{ token: string; description?: string }>;
  project_versions?: Array<{
    id?: string;
    version_number?: number;
    version_code_name?: string;
    slug?: string;
    is_main_version?: boolean;
    is_beta?: boolean;
    is_public?: boolean;
    is_deprecated?: boolean;
    languages?: Array<
      string | { code: string; name?: string; is_default?: boolean; hidden?: boolean; enable_rtl?: boolean }
    >;
    categories?: Document360SeedCategory[];
  }>;
  team_accounts?: Array<{
    id?: string;
    email: string;
    first_name?: string;
    last_name?: string;
    portal_role?: PortalRole;
    is_sso_user?: boolean;
    accepted?: boolean;
  }>;
  team_groups?: Array<{
    id?: string;
    title: string;
    description?: string;
    portal_role?: PortalRole;
    members?: string[];
  }>;
  reader_groups?: Array<{
    id?: string;
    title: string;
    description?: string;
    access_level?: number;
    categories?: string[];
    project_versions?: string[];
    languages?: string[];
  }>;
  readers?: Array<{
    id?: string;
    email: string;
    first_name?: string;
    last_name?: string;
    invited_by?: string;
    is_sso_user?: boolean;
    sso_id?: string;
    access_level?: number;
    groups?: string[];
  }>;
  drive?: Array<{
    id?: string;
    title: string;
    parent?: string;
    is_system?: boolean;
    items?: Array<{ id?: string; title: string; content?: string; content_type?: string; tags?: string[] }>;
  }>;
}

export const DEFAULT_API_TOKEN = "test_emulate_document360_token";
export const DEFAULT_PROJECT_NAME = "Emulate Knowledge Base";
export const DEFAULT_PROJECT_ID = "00000000-0000-4000-8000-000000000360";
export const DEFAULT_KNOWLEDGE_BASE_URL = "https://emulate.document360.io";
export const DEFAULT_MAIN_VERSION_ID = "00000000-0000-4000-8000-000000000001";
export const DEFAULT_OWNER_EMAIL = "admin@example.com";
export const DEFAULT_OWNER_ID = "00000000-0000-4000-8000-00000000a001";
export const DEFAULT_READER_EMAIL = "test@example.com";
export const DEFAULT_READER_ID = "00000000-0000-4000-8000-00000000b001";
export const DEFAULT_CUSTOMER_GROUP_ID = "00000000-0000-4000-8000-00000000c001";
export const DEFAULT_MSP_GROUP_ID = "00000000-0000-4000-8000-00000000c002";
export const DEFAULT_DISTRIBUTOR_GROUP_ID = "00000000-0000-4000-8000-00000000c003";
export const DEFAULT_GETTING_STARTED_CATEGORY_ID = "00000000-0000-4000-8000-00000000d001";
export const DEFAULT_FAQ_CATEGORY_ID = "00000000-0000-4000-8000-00000000d002";
export const DEFAULT_WELCOME_ARTICLE_ID = "00000000-0000-4000-8000-00000000e001";
export const DEFAULT_SETUP_ARTICLE_ID = "00000000-0000-4000-8000-00000000e002";
export const DEFAULT_DOCUMENTS_FOLDER_ID = "00000000-0000-4000-8000-00000000f001";

export const DEFAULT_SEED: Document360SeedConfig = {
  project_name: DEFAULT_PROJECT_NAME,
  project_id: DEFAULT_PROJECT_ID,
  knowledge_base_url: DEFAULT_KNOWLEDGE_BASE_URL,
  api_tokens: [{ token: DEFAULT_API_TOKEN, description: "Local API token" }],
  team_accounts: [
    {
      id: DEFAULT_OWNER_ID,
      email: DEFAULT_OWNER_EMAIL,
      first_name: "Admin",
      last_name: "User",
      portal_role: "owner",
      accepted: true,
    },
    { email: "editor@example.com", first_name: "Edith", last_name: "Editor", portal_role: "editor", accepted: true },
  ],
  team_groups: [
    { title: "Editors", description: "Content editors", portal_role: "editor", members: ["editor@example.com"] },
  ],
  project_versions: [
    {
      id: DEFAULT_MAIN_VERSION_ID,
      version_number: 1,
      version_code_name: "v1",
      slug: "v1",
      is_main_version: true,
      languages: [{ code: "en", is_default: true }, "fr"],
      categories: [
        {
          id: DEFAULT_GETTING_STARTED_CATEGORY_ID,
          name: "Getting Started",
          description: "Everything you need to get up and running.",
          articles: [
            {
              id: DEFAULT_WELCOME_ARTICLE_ID,
              title: "Welcome",
              content:
                "# Welcome\n\nThis knowledge base is served by the Document360 emulator.\n\n- Articles support **markdown** content.\n- Readers, reader groups and team accounts are fully stateful.",
              tags: ["intro"],
              published: true,
            },
            {
              id: DEFAULT_SETUP_ARTICLE_ID,
              title: "Setup guide",
              content: "# Setup guide\n\nPoint your client at the emulator base URL and send the `api_token` header.",
              published: false,
            },
          ],
        },
        {
          id: DEFAULT_FAQ_CATEGORY_ID,
          name: "FAQ",
          description: "Frequently asked questions.",
          articles: [
            {
              title: "How do I reset the emulator?",
              content: "Send `POST /_emulate/reset` or restart the process.",
              published: true,
            },
          ],
        },
      ],
    },
  ],
  reader_groups: [
    { id: DEFAULT_CUSTOMER_GROUP_ID, title: "Customers", description: "Customer accounts" },
    { id: DEFAULT_MSP_GROUP_ID, title: "MSP", description: "Managed service providers" },
    { id: DEFAULT_DISTRIBUTOR_GROUP_ID, title: "Distributors", description: "Distribution partners" },
  ],
  readers: [
    {
      id: DEFAULT_READER_ID,
      email: DEFAULT_READER_EMAIL,
      first_name: "Test",
      last_name: "Reader",
      groups: [DEFAULT_CUSTOMER_GROUP_ID],
    },
  ],
  drive: [
    {
      id: DEFAULT_DOCUMENTS_FOLDER_ID,
      title: "Documents",
      is_system: true,
      items: [
        {
          title: "readme.txt",
          content: "Files uploaded to Drive are served from the emulator.",
          content_type: "text/plain",
        },
      ],
    },
  ],
};

type SeedLanguage = NonNullable<NonNullable<Document360SeedConfig["project_versions"]>[number]["languages"]>[number];

function toLanguage(entry: SeedLanguage, isFirst: boolean): D360Language {
  const spec = typeof entry === "string" ? { code: entry } : entry;
  return {
    code: spec.code,
    name: spec.name ?? languageName(spec.code),
    is_default: spec.is_default ?? isFirst,
    hidden: spec.hidden ?? false,
    enable_rtl: spec.enable_rtl ?? false,
  };
}

function resolveEmailOrId(ds: D360Store, value: string | undefined): string | undefined {
  if (!value) return undefined;
  return (ds.teamAccounts.findOneBy("d360_id", value) ?? ds.teamAccounts.findOneBy("email", value.toLowerCase()))
    ?.d360_id;
}

function seedCategoryTree(
  ds: D360Store,
  versionId: string,
  langCode: string,
  entries: Document360SeedCategory[],
  parentId: string | null,
  authorId: string,
): void {
  entries.forEach((entry, index) => {
    const categoryId = entry.id ?? guid();
    if (ds.categories.findBy("d360_id", categoryId).some((candidate) => candidate.language_code === langCode)) return;
    const category = ds.categories.insert({
      d360_id: categoryId,
      project_version_id: versionId,
      language_code: langCode,
      name: entry.name,
      description: entry.description ?? null,
      content: null,
      parent_category_id: parentId,
      order: index,
      hidden: entry.hidden ?? false,
      icon: entry.icon ?? null,
      slug: uniqueSlug(slugify(entry.slug ?? entry.name), (slug) =>
        ds.categories
          .findBy("project_version_id", versionId)
          .some((candidate) => candidate.language_code === langCode && candidate.slug === slug),
      ),
      category_type: entry.category_type ?? 0,
      status: 0,
      content_type: 0,
    });
    (entry.articles ?? []).forEach((articleEntry, articleIndex) => {
      const articleId = articleEntry.id ?? guid();
      if (ds.articles.findBy("d360_id", articleId).some((candidate) => candidate.language_code === langCode)) return;
      const content =
        articleEntry.content ?? (articleEntry.html_content ? articleEntry.html_content.replace(/<[^>]+>/g, "") : "");
      const html = articleEntry.html_content ?? markdownToHtml(content);
      const author = resolveEmailOrId(ds, articleEntry.author) ?? authorId;
      const published = articleEntry.published ?? false;
      const article = ds.articles.insert({
        d360_id: articleId,
        project_version_id: versionId,
        language_code: langCode,
        category_id: category.d360_id,
        title: articleEntry.title,
        slug: uniqueSlug(slugify(articleEntry.slug ?? articleEntry.title), (slug) =>
          ds.articles
            .findBy("project_version_id", versionId)
            .some((candidate) => candidate.language_code === langCode && candidate.slug === slug),
        ),
        description: articleEntry.description ?? null,
        content,
        html_content: html,
        content_type: 0,
        order: articleIndex,
        hidden: articleEntry.hidden ?? false,
        exclude_from_search: false,
        allow_comments: true,
        show_table_of_contents: true,
        feature_image_url: null,
        seo_title: null,
        tags: articleEntry.tags ?? [],
        related_articles: [],
        created_by: author,
        authors: [author],
        latest_version: 1,
        public_version: published ? 1 : null,
        status_indicator: 0,
        deleted: false,
        review_reminder_at: null,
      });
      ds.articleVersions.insert({
        article_id: article.d360_id,
        language_code: langCode,
        version_number: 1,
        title: article.title,
        content,
        html_content: html,
        created_by: author,
        published,
        published_at: published ? nowIso() : null,
        publish_message: published ? "Initial version" : null,
        status: published ? 3 : 0,
      });
    });
    seedCategoryTree(ds, versionId, langCode, entry.categories ?? [], category.d360_id, authorId);
  });
}

export function seedFromConfig(
  store: Store,
  _baseUrl: string,
  config: Document360SeedConfig,
  _webhooks?: WebhookDispatcher,
): void {
  const ds = getD360Store(store);
  if (config.project_name) setProjectName(ds, config.project_name);
  if (config.project_id) setProjectId(ds, config.project_id);
  if (config.knowledge_base_url) setKnowledgeBaseUrl(ds, config.knowledge_base_url.replace(/\/+$/, ""));

  for (const entry of config.api_tokens ?? []) {
    if (!entry.token || ds.apiTokens.findOneBy("token", entry.token)) continue;
    ds.apiTokens.insert({ token: entry.token, description: entry.description ?? "API token" });
  }
  if (ds.apiTokens.count() === 0) ds.apiTokens.insert({ token: DEFAULT_API_TOKEN, description: "Local API token" });

  for (const entry of config.team_accounts ?? []) {
    const email = entry.email.toLowerCase();
    if (ds.teamAccounts.findOneBy("email", email) || (entry.id && ds.teamAccounts.findOneBy("d360_id", entry.id)))
      continue;
    ds.teamAccounts.insert({
      d360_id: entry.id ?? guid(),
      email,
      first_name: entry.first_name ?? "",
      last_name: entry.last_name ?? "",
      portal_role: entry.portal_role ?? "editor",
      is_sso_user: entry.is_sso_user ?? false,
      sso_id: null,
      profile_logo_url: null,
      last_login_at: null,
      invited_at: nowIso(),
      accepted: entry.accepted ?? true,
    });
  }
  if (ds.teamAccounts.count() === 0) {
    ds.teamAccounts.insert({
      d360_id: DEFAULT_OWNER_ID,
      email: DEFAULT_OWNER_EMAIL,
      first_name: "Admin",
      last_name: "User",
      portal_role: "owner",
      is_sso_user: false,
      sso_id: null,
      profile_logo_url: null,
      last_login_at: null,
      invited_at: nowIso(),
      accepted: true,
    });
  }
  const owner = ds.teamAccounts.all().find((account) => account.portal_role === "owner") ?? ds.teamAccounts.all()[0];

  for (const entry of config.team_groups ?? []) {
    if (
      (entry.id && ds.teamGroups.findOneBy("d360_id", entry.id)) ||
      ds.teamGroups.all().some((group) => group.title.toLowerCase() === entry.title.toLowerCase())
    )
      continue;
    ds.teamGroups.insert({
      d360_id: entry.id ?? guid(),
      title: entry.title,
      description: entry.description ?? "",
      account_ids: (entry.members ?? [])
        .map((member) => resolveEmailOrId(ds, member))
        .filter((id): id is string => !!id),
      portal_role: entry.portal_role ?? "editor",
    });
  }

  (config.project_versions ?? []).forEach((entry, index) => {
    const existing =
      (entry.id && ds.projectVersions.findOneBy("d360_id", entry.id)) ||
      (entry.version_number !== undefined &&
        ds.projectVersions.all().find((candidate) => candidate.version_number === entry.version_number));
    const versionNumber =
      entry.version_number ?? Math.max(0, ...ds.projectVersions.all().map((candidate) => candidate.version_number)) + 1;
    const version =
      existing ||
      ds.projectVersions.insert({
        d360_id: entry.id ?? guid(),
        version_number: versionNumber,
        base_version_number: null,
        version_code_name: entry.version_code_name ?? `v${versionNumber}`,
        is_main_version: entry.is_main_version ?? ds.projectVersions.count() === 0,
        is_beta: entry.is_beta ?? false,
        is_public: entry.is_public ?? true,
        is_deprecated: entry.is_deprecated ?? false,
        slug: uniqueSlug(slugify(entry.slug ?? `v${versionNumber}`), (slug) =>
          ds.projectVersions.all().some((candidate) => candidate.slug === slug),
        ),
        order: ds.projectVersions.count() + index,
        languages: (entry.languages && entry.languages.length > 0 ? entry.languages : ["en"]).map(
          (language, languageIndex) => toLanguage(language, languageIndex === 0),
        ),
        version_type: 0,
      });
    if (version.is_main_version)
      for (const other of ds.projectVersions.all())
        if (other.id !== version.id && other.is_main_version)
          ds.projectVersions.update(other.id, { is_main_version: false });
    if (!version.languages.some((language) => language.is_default))
      ds.projectVersions.update(version.id, {
        languages: version.languages.map((language, languageIndex) => ({
          ...language,
          is_default: languageIndex === 0,
        })),
      });
    const defaultCode = (
      ds.projectVersions.get(version.id)?.languages.find((language) => language.is_default) ?? version.languages[0]
    ).code;
    seedCategoryTree(ds, version.d360_id, defaultCode, entry.categories ?? [], null, owner.d360_id);
  });
  if (ds.projectVersions.count() === 0) {
    ds.projectVersions.insert({
      d360_id: DEFAULT_MAIN_VERSION_ID,
      version_number: 1,
      base_version_number: null,
      version_code_name: "v1",
      is_main_version: true,
      is_beta: false,
      is_public: true,
      is_deprecated: false,
      slug: "v1",
      order: 0,
      languages: [toLanguage({ code: "en", is_default: true }, true)],
      version_type: 0,
    });
  }

  for (const entry of config.reader_groups ?? []) {
    if (
      (entry.id && ds.readerGroups.findOneBy("d360_id", entry.id)) ||
      ds.readerGroups.all().some((group) => group.title.toLowerCase() === entry.title.toLowerCase())
    )
      continue;
    ds.readerGroups.insert({
      d360_id: entry.id ?? guid(),
      title: entry.title,
      description: entry.description ?? "",
      reader_ids: [],
      access_level: entry.access_level ?? 0,
      access_categories: entry.categories ?? null,
      access_project_versions: entry.project_versions ?? null,
      access_languages: entry.languages ?? null,
    });
  }

  for (const entry of config.readers ?? []) {
    const email = entry.email.toLowerCase();
    if (ds.readers.findOneBy("email", email) || (entry.id && ds.readers.findOneBy("d360_id", entry.id))) continue;
    const reader = ds.readers.insert({
      d360_id: entry.id ?? guid(),
      first_name: entry.first_name ?? "",
      last_name: entry.last_name ?? "",
      email,
      is_sso_user: entry.is_sso_user ?? false,
      sso_id: entry.sso_id ?? null,
      invited_by: entry.invited_by ?? owner.email,
      access_level: entry.access_level ?? 0,
      access_categories: null,
      access_project_versions: null,
      access_languages: null,
      status: 0,
      last_login_at: null,
    });
    for (const groupRef of entry.groups ?? []) {
      const group =
        ds.readerGroups.findOneBy("d360_id", groupRef) ??
        ds.readerGroups.all().find((candidate) => candidate.title.toLowerCase() === groupRef.toLowerCase());
      if (group && !group.reader_ids.includes(reader.d360_id))
        ds.readerGroups.update(group.id, { reader_ids: [...group.reader_ids, reader.d360_id] });
    }
  }

  for (const entry of config.drive ?? []) {
    const parent = entry.parent
      ? (ds.driveFolders.findOneBy("d360_id", entry.parent) ??
        ds.driveFolders.all().find((candidate) => candidate.title.toLowerCase() === entry.parent!.toLowerCase()))
      : undefined;
    const folder =
      (entry.id && ds.driveFolders.findOneBy("d360_id", entry.id)) ||
      ds.driveFolders
        .all()
        .find(
          (candidate) =>
            candidate.title.toLowerCase() === entry.title.toLowerCase() &&
            candidate.parent_folder_id === (parent?.d360_id ?? null),
        ) ||
      ds.driveFolders.insert({
        d360_id: entry.id ?? guid(),
        title: entry.title,
        parent_folder_id: parent?.d360_id ?? null,
        is_system: entry.is_system ?? false,
      });
    for (const item of entry.items ?? []) {
      if (
        (item.id && ds.driveItems.findOneBy("d360_id", item.id)) ||
        ds.driveItems.findBy("folder_id", folder.d360_id).some((candidate) => candidate.title === item.title)
      )
        continue;
      const buffer = Buffer.from(item.content ?? "", "utf8");
      ds.driveItems.insert({
        d360_id: item.id ?? guid(),
        folder_id: folder.d360_id,
        title: item.title,
        content_type: item.content_type ?? "application/octet-stream",
        size: buffer.byteLength,
        content: buffer.toString("base64"),
        tags: item.tags ?? [],
        is_starred: false,
        created_by: owner.d360_id,
      });
    }
  }
}

export const document360Plugin: ServicePlugin = {
  name: "document360",
  register(app: Hono<AppEnv>, store: Store, _webhooks: WebhookDispatcher, baseUrl: string, _tokenMap?: TokenMap): void {
    const ds = getD360Store(store);
    const fmt: Fmt = { ds, baseUrl };
    const rc: D360RouteContext = { app, ds, fmt, baseUrl };
    projectVersionRoutes(rc);
    categoryRoutes(rc);
    articleRoutes(rc);
    readerRoutes(rc);
    teamRoutes(rc);
    driveRoutes(rc);
    miscRoutes(rc);
    inspectorRoutes(rc);
  },
  seed(store: Store, baseUrl: string): void {
    seedFromConfig(store, baseUrl, DEFAULT_SEED);
  },
};

export default document360Plugin;
