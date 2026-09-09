import type { AppEnv, Hono } from "@emulators/core";
import type {
  D360Article,
  D360Category,
  D360DriveFolder,
  D360DriveItem,
  D360ProjectVersion,
  D360Reader,
  D360ReaderGroup,
  D360TeamAccount,
  D360TeamGroup,
} from "./entities.js";
import { defaultLanguage, type Fmt } from "./formatters.js";
import { notFound } from "./helpers.js";
import type { D360Store } from "./store.js";

export interface D360RouteContext {
  app: Hono<AppEnv>;
  ds: D360Store;
  fmt: Fmt;
  baseUrl: string;
}

export function findVersion(ds: D360Store, id: string): D360ProjectVersion {
  const version =
    ds.projectVersions.findOneBy("d360_id", id) ??
    ds.projectVersions.all().find((candidate) => String(candidate.version_number) === id || candidate.slug === id);
  if (!version) throw notFound("Project version not found", "project_version_not_found");
  return version;
}

export function mainVersion(ds: D360Store): D360ProjectVersion {
  const version =
    ds.projectVersions.all().find((candidate) => candidate.is_main_version) ?? ds.projectVersions.all()[0];
  if (!version) throw notFound("No project version is configured", "project_version_not_found");
  return version;
}

export function resolveLanguage(ds: D360Store, versionId: string, langCode: string | undefined): string {
  const version = ds.projectVersions.findOneBy("d360_id", versionId);
  if (!version) return langCode ?? "en";
  if (langCode && version.languages.some((language) => language.code.toLowerCase() === langCode.toLowerCase())) {
    return version.languages.find((language) => language.code.toLowerCase() === langCode.toLowerCase())!.code;
  }
  return defaultLanguage(version).code;
}

export interface LocalizedLookup<T> {
  entity: T;
  fallback: boolean;
}

export function findCategory(ds: D360Store, id: string, langCode: string | undefined): LocalizedLookup<D360Category> {
  const translations = ds.categories.findBy("d360_id", id);
  if (translations.length === 0) throw notFound("Category not found", "category_not_found");
  const exact = langCode
    ? translations.find((candidate) => candidate.language_code.toLowerCase() === langCode.toLowerCase())
    : undefined;
  if (exact) return { entity: exact, fallback: false };
  const defaultCode = resolveLanguage(ds, translations[0].project_version_id, undefined);
  const primary = translations.find((candidate) => candidate.language_code === defaultCode) ?? translations[0];
  return { entity: primary, fallback: langCode !== undefined };
}

export function findArticle(ds: D360Store, id: string, langCode: string | undefined): LocalizedLookup<D360Article> {
  const translations = ds.articles.findBy("d360_id", id).filter((candidate) => !candidate.deleted);
  if (translations.length === 0) throw notFound("Article not found", "article_not_found");
  const exact = langCode
    ? translations.find((candidate) => candidate.language_code.toLowerCase() === langCode.toLowerCase())
    : undefined;
  if (exact) return { entity: exact, fallback: false };
  const defaultCode = resolveLanguage(ds, translations[0].project_version_id, undefined);
  const primary = translations.find((candidate) => candidate.language_code === defaultCode) ?? translations[0];
  return { entity: primary, fallback: langCode !== undefined };
}

export function findReader(ds: D360Store, id: string): D360Reader {
  const reader = ds.readers.findOneBy("d360_id", id);
  if (!reader) throw notFound("Reader not found", "reader_not_found");
  return reader;
}

export function findReaderGroup(ds: D360Store, id: string): D360ReaderGroup {
  const group = ds.readerGroups.findOneBy("d360_id", id);
  if (!group) throw notFound("Reader group not found", "reader_group_not_found");
  return group;
}

export function findTeamAccount(ds: D360Store, id: string): D360TeamAccount {
  const account =
    ds.teamAccounts.findOneBy("d360_id", id) ??
    ds.teamAccounts.all().find((candidate) => candidate.email.toLowerCase() === id.toLowerCase());
  if (!account) throw notFound("Team account not found", "team_account_not_found");
  return account;
}

export function findTeamGroup(ds: D360Store, id: string): D360TeamGroup {
  const group = ds.teamGroups.findOneBy("d360_id", id);
  if (!group) throw notFound("Team group not found", "team_group_not_found");
  return group;
}

export function findFolder(ds: D360Store, id: string): D360DriveFolder {
  const folder = ds.driveFolders.findOneBy("d360_id", id);
  if (!folder) throw notFound("Folder not found", "folder_not_found");
  return folder;
}

export function findItem(ds: D360Store, id: string): D360DriveItem {
  const item = ds.driveItems.findOneBy("d360_id", id);
  if (!item) throw notFound("Drive item not found", "drive_item_not_found");
  return item;
}
