import type { Entity } from "@emulators/core";

export interface D360ApiToken extends Entity {
  token: string;
  description: string;
}

export interface D360Language {
  code: string;
  name: string;
  is_default: boolean;
  hidden: boolean;
  enable_rtl: boolean;
}

export interface D360ProjectVersion extends Entity {
  d360_id: string;
  version_number: number;
  base_version_number: number | null;
  version_code_name: string;
  is_main_version: boolean;
  is_beta: boolean;
  is_public: boolean;
  is_deprecated: boolean;
  slug: string;
  order: number;
  languages: D360Language[];
  version_type: number;
}

export type CategoryType = 0 | 1 | 2;

export interface D360Category extends Entity {
  d360_id: string;
  project_version_id: string;
  language_code: string;
  name: string;
  description: string | null;
  content: string | null;
  parent_category_id: string | null;
  order: number;
  hidden: boolean;
  icon: string | null;
  slug: string;
  category_type: CategoryType;
  status: number;
  content_type: number;
}

export interface D360Article extends Entity {
  d360_id: string;
  project_version_id: string;
  language_code: string;
  category_id: string;
  title: string;
  slug: string;
  description: string | null;
  content: string;
  html_content: string;
  content_type: number;
  order: number;
  hidden: boolean;
  exclude_from_search: boolean;
  allow_comments: boolean;
  show_table_of_contents: boolean;
  feature_image_url: string | null;
  seo_title: string | null;
  tags: string[];
  related_articles: string[];
  created_by: string;
  authors: string[];
  latest_version: number;
  public_version: number | null;
  status_indicator: number;
  deleted: boolean;
  review_reminder_at: string | null;
}

export interface D360ArticleVersion extends Entity {
  article_id: string;
  language_code: string;
  version_number: number;
  title: string;
  content: string;
  html_content: string;
  created_by: string;
  published: boolean;
  published_at: string | null;
  publish_message: string | null;
  status: number;
}

export interface D360Reader extends Entity {
  d360_id: string;
  first_name: string;
  last_name: string;
  email: string;
  is_sso_user: boolean;
  sso_id: string | null;
  invited_by: string | null;
  access_level: number;
  access_categories: string[] | null;
  access_project_versions: string[] | null;
  access_languages: string[] | null;
  status: number;
  last_login_at: string | null;
}

export interface D360ReaderGroup extends Entity {
  d360_id: string;
  title: string;
  description: string;
  reader_ids: string[];
  access_level: number;
  access_categories: string[] | null;
  access_project_versions: string[] | null;
  access_languages: string[] | null;
}

export type PortalRole = "owner" | "admin" | "editor" | "draft_writer" | "reader";

export interface D360TeamAccount extends Entity {
  d360_id: string;
  email: string;
  first_name: string;
  last_name: string;
  portal_role: PortalRole;
  is_sso_user: boolean;
  sso_id: string | null;
  profile_logo_url: string | null;
  last_login_at: string | null;
  invited_at: string;
  accepted: boolean;
}

export interface D360TeamGroup extends Entity {
  d360_id: string;
  title: string;
  description: string;
  account_ids: string[];
  portal_role: PortalRole;
}

export interface D360DriveFolder extends Entity {
  d360_id: string;
  title: string;
  parent_folder_id: string | null;
  is_system: boolean;
}

export interface D360DriveItem extends Entity {
  d360_id: string;
  folder_id: string;
  title: string;
  content_type: string;
  size: number;
  content: string;
  tags: string[];
  is_starred: boolean;
  created_by: string;
}

export interface D360EventLog extends Entity {
  type: string;
  subject: string;
  detail: Record<string, unknown>;
}
