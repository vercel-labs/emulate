import type {
  D360Article,
  D360ArticleVersion,
  D360Category,
  D360DriveFolder,
  D360DriveItem,
  D360Language,
  D360ProjectVersion,
  D360Reader,
  D360ReaderGroup,
  D360TeamAccount,
  D360TeamGroup,
  PortalRole,
} from "./entities.js";
import { knowledgeBaseUrl, type D360Store } from "./store.js";

type Json = Record<string, unknown>;

export interface Fmt {
  ds: D360Store;
  baseUrl: string;
}

export const ARTICLE_STATUS_DRAFT = 0;
export const ARTICLE_STATUS_PUBLISHED = 3;

const PORTAL_ROLE_CODES: Record<PortalRole, number> = { owner: 0, admin: 1, editor: 2, draft_writer: 3, reader: 4 };

export function formatLanguage(language: D360Language, projectVersionId?: string): Json {
  return {
    ...(projectVersionId ? { id: `${projectVersionId}:${language.code}` } : {}),
    language_code: language.code,
    language_name: language.name,
    is_default: language.is_default,
    set_as_default: language.is_default,
    hidden: language.hidden,
    enable_rtl: language.enable_rtl,
    is_inheritance_disabled: false,
    is_ai_translated: false,
  };
}

export function formatProjectVersion(v: D360ProjectVersion): Json {
  return {
    id: v.d360_id,
    version_number: v.version_number,
    base_version_number: v.base_version_number,
    version_code_name: v.version_code_name,
    version_display_name: v.version_code_name || `v${v.version_number}`,
    is_main_version: v.is_main_version,
    is_beta: v.is_beta,
    is_public: v.is_public,
    is_deprecated: v.is_deprecated,
    created_at: v.created_at,
    modified_at: v.updated_at,
    language_versions: v.languages.map((language) => formatLanguage(language, v.d360_id)),
    slug: v.slug,
    order: v.order,
    version_type: v.version_type,
  };
}

export function defaultLanguage(v: D360ProjectVersion): D360Language {
  return (
    v.languages.find((language) => language.is_default) ??
    v.languages[0] ?? { code: "en", name: "English", is_default: true, hidden: false, enable_rtl: false }
  );
}

export function articleStatus(a: D360Article): number {
  return a.public_version !== null ? ARTICLE_STATUS_PUBLISHED : ARTICLE_STATUS_DRAFT;
}

export function articleUrl(f: Fmt, a: D360Article): string {
  const version = f.ds.projectVersions.findOneBy("d360_id", a.project_version_id);
  return `${knowledgeBaseUrl(f.ds)}/${version?.slug ?? "v1"}/${a.language_code}/docs/${a.slug}`;
}

export function formatArticleSummary(f: Fmt, a: D360Article): Json {
  return {
    id: a.d360_id,
    title: a.title,
    public_version: a.public_version,
    latest_version: a.latest_version,
    language_code: a.language_code,
    hidden: a.hidden,
    status: articleStatus(a),
    order: a.order,
    slug: a.slug,
    content_type: a.content_type,
    translation_option: 0,
    is_shared_article: false,
    category_id: a.category_id,
    modified_at: a.updated_at,
    url: articleUrl(f, a),
  };
}

export function formatArticle(f: Fmt, a: D360Article, version?: D360ArticleVersion | null, fallback = false): Json {
  const content = version?.content ?? a.content;
  const html = version?.html_content ?? a.html_content;
  const title = version?.title ?? a.title;
  return {
    id: a.d360_id,
    title,
    content,
    html_content: html,
    category_id: a.category_id,
    project_version_id: a.project_version_id,
    version_number: version?.version_number ?? a.latest_version,
    public_version: a.public_version,
    latest_version: a.latest_version,
    enable_rtl: false,
    hidden: a.hidden,
    status: articleStatus(a),
    order: a.order,
    created_by: a.created_by,
    authors: a.authors.map((id) => {
      const account = f.ds.teamAccounts.findOneBy("d360_id", id);
      return {
        id,
        first_name: account?.first_name ?? "",
        last_name: account?.last_name ?? "",
        email_id: account?.email ?? "",
      };
    }),
    created_at: a.created_at,
    modified_at: version?.updated_at ?? a.updated_at,
    slug: a.slug,
    is_fall_back_content: fallback,
    description: a.description,
    category_type: 0,
    content_type: a.content_type,
    is_shared_article: false,
    translation_option: 0,
    language_code: a.language_code,
    url: articleUrl(f, a),
    exclude_from_search: a.exclude_from_search,
    allow_comments: a.allow_comments,
    show_table_of_contents: a.show_table_of_contents,
    feature_image_url: a.feature_image_url,
    seo_title: a.seo_title,
    tags: a.tags,
    related_articles: a.related_articles,
    status_indicator: a.status_indicator,
    review_reminder_at: a.review_reminder_at,
  };
}

export function formatArticleVersion(v: D360ArticleVersion): Json {
  return {
    version_number: v.version_number,
    title: v.title,
    is_public: v.published,
    status: v.published ? ARTICLE_STATUS_PUBLISHED : v.status,
    created_by: v.created_by,
    created_at: v.created_at,
    modified_at: v.updated_at,
    published_at: v.published_at,
    publish_message: v.publish_message,
  };
}

export function formatCategory(
  f: Fmt,
  c: D360Category,
  options: { includeChildren?: boolean; includeArticles?: boolean; fallback?: boolean } = {},
): Json {
  const base: Json = {
    id: c.d360_id,
    name: c.name,
    description: c.description,
    project_version_id: c.project_version_id,
    order: c.order,
    parent_category_id: c.parent_category_id,
    hidden: c.hidden,
    icon: c.icon,
    slug: c.slug,
    language_code: c.language_code,
    category_type: c.category_type,
    status: c.status,
    content_type: c.content_type,
    content: c.content,
    is_fall_back_content: options.fallback ?? false,
    created_at: c.created_at,
    modified_at: c.updated_at,
  };
  if (options.includeChildren) {
    base.child_categories = f.ds.categories
      .findBy("parent_category_id", c.d360_id)
      .filter((child) => child.language_code === c.language_code)
      .sort((a, b) => a.order - b.order || a.id - b.id)
      .map((child) => formatCategory(f, child, options));
  }
  if (options.includeArticles) {
    base.articles = f.ds.articles
      .findBy("category_id", c.d360_id)
      .filter((article) => article.language_code === c.language_code && !article.deleted)
      .sort((a, b) => a.order - b.order || a.id - b.id)
      .map((article) => formatArticleSummary(f, article));
  }
  return base;
}

function accessScope(entity: {
  access_level: number;
  access_categories: string[] | null;
  access_project_versions: string[] | null;
  access_languages: string[] | null;
}): Json {
  return {
    access_level: entity.access_level,
    categories: entity.access_categories,
    project_versions: entity.access_project_versions,
    languages: entity.access_languages,
  };
}

export function formatReader(f: Fmt, r: D360Reader): Json {
  const groups = f.ds.readerGroups.all().filter((group) => group.reader_ids.includes(r.d360_id));
  return {
    reader_id: r.d360_id,
    first_name: r.first_name,
    last_name: r.last_name,
    email: r.email,
    is_sso_user: r.is_sso_user,
    sso_id: r.sso_id,
    invited_by: r.invited_by,
    access_scope: accessScope(r),
    associated_reader_groups: groups.map((group) => ({ id: group.d360_id, title: group.title })),
    status: r.status,
    created_at: r.created_at,
    modified_at: r.updated_at,
    last_login_at: r.last_login_at,
  };
}

export function formatReaderGroup(f: Fmt, g: D360ReaderGroup): Json {
  const readers = g.reader_ids
    .map((id) => f.ds.readers.findOneBy("d360_id", id))
    .filter((reader): reader is D360Reader => !!reader);
  return {
    id: g.d360_id,
    title: g.title,
    description: g.description,
    access_scope: accessScope(g),
    associated_readers: readers.map((reader) => ({
      reader_id: reader.d360_id,
      email: reader.email,
      first_name: reader.first_name,
      last_name: reader.last_name,
    })),
    readers_count: readers.length,
    created_at: g.created_at,
    modified_at: g.updated_at,
  };
}

export function formatTeamAccount(a: D360TeamAccount): Json {
  return {
    user_id: a.d360_id,
    first_name: a.first_name,
    last_name: a.last_name,
    email_id: a.email,
    unique_user_name: a.email.split("@")[0],
    portal_role: a.portal_role,
    user_role: PORTAL_ROLE_CODES[a.portal_role],
    is_sso_user: a.is_sso_user,
    sso_id: a.sso_id,
    profile_logo_url: a.profile_logo_url,
    last_login_at: a.last_login_at,
    invited_at: a.invited_at,
    accepted: a.accepted,
  };
}

export function formatTeamGroup(f: Fmt, g: D360TeamGroup): Json {
  return {
    id: g.d360_id,
    title: g.title,
    description: g.description,
    portal_role: g.portal_role,
    associated_team_accounts: g.account_ids
      .map((id) => f.ds.teamAccounts.findOneBy("d360_id", id))
      .filter((account): account is D360TeamAccount => !!account)
      .map((account) => ({ user_id: account.d360_id, email_id: account.email })),
    created_at: g.created_at,
    modified_at: g.updated_at,
  };
}

export function formatDriveFolder(f: Fmt, folder: D360DriveFolder): Json {
  return {
    id: folder.d360_id,
    title: folder.title,
    parent_folder_id: folder.parent_folder_id,
    is_system: folder.is_system,
    items_count: f.ds.driveItems.count((item) => item.folder_id === folder.d360_id),
    created_at: folder.created_at,
    modified_at: folder.updated_at,
  };
}

export function driveItemUrl(f: Fmt, item: D360DriveItem): string {
  return `${f.baseUrl}/_document360/drive/${item.d360_id}/${encodeURIComponent(item.title)}`;
}

export function formatDriveItem(f: Fmt, item: D360DriveItem): Json {
  return {
    id: item.d360_id,
    title: item.title,
    url: driveItemUrl(f, item),
    folder_id: item.folder_id,
    content_type: item.content_type,
    size: item.size,
    tags: item.tags,
    is_starred: item.is_starred,
    created_by: item.created_by,
    created_at: item.created_at,
    modified_at: item.updated_at,
  };
}

export function highlight(text: string, query: string): string {
  if (!query) return text;
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index === -1) return text.slice(0, 160);
  const start = Math.max(0, index - 60);
  const snippet = text.slice(start, index + query.length + 100);
  return snippet.replace(
    new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"),
    (match) => `<em>${match}</em>`,
  );
}
