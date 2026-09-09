import { Store, type Collection } from "@emulators/core";
import type {
  D360ApiToken,
  D360Article,
  D360ArticleVersion,
  D360Category,
  D360DriveFolder,
  D360DriveItem,
  D360EventLog,
  D360ProjectVersion,
  D360Reader,
  D360ReaderGroup,
  D360TeamAccount,
  D360TeamGroup,
} from "./entities.js";

export interface D360Store {
  raw: Store;
  apiTokens: Collection<D360ApiToken>;
  projectVersions: Collection<D360ProjectVersion>;
  categories: Collection<D360Category>;
  articles: Collection<D360Article>;
  articleVersions: Collection<D360ArticleVersion>;
  readers: Collection<D360Reader>;
  readerGroups: Collection<D360ReaderGroup>;
  teamAccounts: Collection<D360TeamAccount>;
  teamGroups: Collection<D360TeamGroup>;
  driveFolders: Collection<D360DriveFolder>;
  driveItems: Collection<D360DriveItem>;
  events: Collection<D360EventLog>;
}

export function getD360Store(store: Store): D360Store {
  return {
    raw: store,
    apiTokens: store.collection<D360ApiToken>("document360.api_tokens", ["token"]),
    projectVersions: store.collection<D360ProjectVersion>("document360.project_versions", ["d360_id"]),
    categories: store.collection<D360Category>("document360.categories", [
      "d360_id",
      "project_version_id",
      "parent_category_id",
    ]),
    articles: store.collection<D360Article>("document360.articles", ["d360_id", "project_version_id", "category_id"]),
    articleVersions: store.collection<D360ArticleVersion>("document360.article_versions", ["article_id"]),
    readers: store.collection<D360Reader>("document360.readers", ["d360_id", "email"]),
    readerGroups: store.collection<D360ReaderGroup>("document360.reader_groups", ["d360_id"]),
    teamAccounts: store.collection<D360TeamAccount>("document360.team_accounts", ["d360_id", "email"]),
    teamGroups: store.collection<D360TeamGroup>("document360.team_groups", ["d360_id"]),
    driveFolders: store.collection<D360DriveFolder>("document360.drive_folders", ["d360_id", "parent_folder_id"]),
    driveItems: store.collection<D360DriveItem>("document360.drive_items", ["d360_id", "folder_id"]),
    events: store.collection<D360EventLog>("document360.events", ["type"]),
  };
}

const PROJECT_NAME_KEY = "document360.project_name";
const PROJECT_ID_KEY = "document360.project_id";
const KB_URL_KEY = "document360.kb_url";

export function projectName(ds: D360Store): string {
  return ds.raw.getData<string>(PROJECT_NAME_KEY) ?? "Emulate Knowledge Base";
}

export function setProjectName(ds: D360Store, value: string): void {
  ds.raw.setData(PROJECT_NAME_KEY, value);
}

export function projectId(ds: D360Store): string {
  return ds.raw.getData<string>(PROJECT_ID_KEY) ?? "00000000-0000-4000-8000-000000000360";
}

export function setProjectId(ds: D360Store, value: string): void {
  ds.raw.setData(PROJECT_ID_KEY, value);
}

export function knowledgeBaseUrl(ds: D360Store): string {
  return ds.raw.getData<string>(KB_URL_KEY) ?? "https://emulate.document360.io";
}

export function setKnowledgeBaseUrl(ds: D360Store, value: string): void {
  ds.raw.setData(KB_URL_KEY, value);
}

export function logEvent(ds: D360Store, type: string, subject: string, detail: Record<string, unknown>): void {
  ds.events.insert({ type, subject, detail });
  const all = ds.events.all();
  if (all.length > 1000) for (const stale of all.slice(0, all.length - 1000)) ds.events.delete(stale.id);
}
