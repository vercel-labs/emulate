import { generateUid, normalizeLimit, parseOffset } from "./helpers.js";
import type { GoogleDriveItem } from "./entities.js";
import type { GoogleStore } from "./store.js";

export const GOOGLE_DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

export interface GoogleDriveItemInput {
  google_id?: string;
  user_email: string;
  name: string;
  mime_type: string;
  parent_google_ids?: string[];
  web_view_link?: string | null;
  size?: number | null;
  trashed?: boolean;
  data?: string | null;
}

export interface DriveListOptions {
  q?: string | null;
  pageSize?: string | null;
  pageToken?: string | null;
  orderBy?: string | null;
}

export interface ParsedDriveUpload {
  requestBody: Record<string, unknown>;
  media:
    | {
        mimeType: string;
        body: Buffer;
      }
    | undefined;
}

export function createDriveItemRecord(gs: GoogleStore, input: GoogleDriveItemInput): GoogleDriveItem {
  const itemId = input.google_id ?? generateUid("drv");
  const existing = gs.driveItems
    .findBy("user_email", input.user_email)
    .find((item) => item.google_id === itemId);
  if (existing) return existing;

  const item = gs.driveItems.insert({
    google_id: itemId,
    user_email: input.user_email,
    name: input.name,
    mime_type: input.mime_type,
    parent_google_ids: normalizeParentIds(input.parent_google_ids),
    web_view_link: input.web_view_link ?? buildDriveWebViewLink(itemId, input.mime_type),
    size: input.size ?? null,
    trashed: input.trashed ?? false,
    data: input.data ?? null,
  });

  return item;
}

export function getDriveItemById(gs: GoogleStore, userEmail: string, fileId: string): GoogleDriveItem | undefined {
  return gs.driveItems
    .findBy("user_email", userEmail)
    .find((item) => item.google_id === fileId);
}

export function listDriveItems(
  gs: GoogleStore,
  userEmail: string,
  options: DriveListOptions,
): { files: GoogleDriveItem[]; nextPageToken?: string } {
  let items = gs.driveItems.findBy("user_email", userEmail);
  const parsed = parseDriveQuery(options.q ?? null);

  if (parsed.parentId) {
    items = items.filter((item) => item.parent_google_ids.includes(parsed.parentId));
  }

  if (parsed.requireNotTrashed) {
    items = items.filter((item) => !item.trashed);
  }

  if (parsed.mimeTypes.length > 0) {
    items = items.filter((item) => parsed.mimeTypes.includes(item.mime_type));
  }

  if (parsed.excludeMimeTypes.length > 0) {
    items = items.filter((item) => !parsed.excludeMimeTypes.includes(item.mime_type));
  }

  if (options.orderBy?.includes("name")) {
    items = items.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    items = items.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  const offset = parseOffset(options.pageToken);
  const limit = normalizeLimit(options.pageSize, 100, 1000);

  return {
    files: items.slice(offset, offset + limit),
    nextPageToken: offset + limit < items.length ? String(offset + limit) : undefined,
  };
}

export function updateDriveItemRecord(
  gs: GoogleStore,
  item: GoogleDriveItem,
  input: {
    addParents?: string[];
    removeParents?: string[];
    name?: string;
    trashed?: boolean;
  },
): GoogleDriveItem {
  const nextParents = new Set(item.parent_google_ids);
  for (const parentId of input.addParents ?? []) {
    nextParents.add(parentId);
  }
  for (const parentId of input.removeParents ?? []) {
    nextParents.delete(parentId);
  }

  return (
    gs.driveItems.update(item.id, {
      name: input.name ?? item.name,
      parent_google_ids: normalizeParentIds(Array.from(nextParents)),
      trashed: input.trashed ?? item.trashed,
      web_view_link: buildDriveWebViewLink(item.google_id, item.mime_type),
    }) ?? item
  );
}

export function formatDriveItemResource(item: GoogleDriveItem) {
  return {
    kind: "drive#file",
    id: item.google_id,
    name: item.name,
    mimeType: item.mime_type,
    parents: item.parent_google_ids,
    webViewLink: item.web_view_link ?? undefined,
    createdTime: item.created_at,
    modifiedTime: item.updated_at,
    size: item.size != null ? String(item.size) : undefined,
    trashed: item.trashed || undefined,
  };
}

export function parseDriveMultipartUpload(contentType: string, rawBody: Buffer): ParsedDriveUpload {
  const boundaryMatch = contentType.match(/boundary="?([^";]+)"?/i);
  const boundary = boundaryMatch?.[1];
  if (!boundary) {
    return {
      requestBody: {},
      media: undefined,
    };
  }

  const raw = rawBody.toString("latin1");
  const parts = raw
    .split(`--${boundary}`)
    .slice(1)
    .filter((part) => part !== "--" && part !== "--\r\n" && part !== "--\n");

  let requestBody: Record<string, unknown> = {};
  let media: ParsedDriveUpload["media"];

  for (const part of parts) {
    const normalized = stripMultipartBoundaryPadding(part);
    const headerSeparator = normalized.includes("\r\n\r\n") ? "\r\n\r\n" : "\n\n";
    const separatorIndex = normalized.indexOf(headerSeparator);
    if (separatorIndex < 0) continue;

    const headers = normalized.slice(0, separatorIndex).toLowerCase();
    const bodyText = normalized.slice(separatorIndex + headerSeparator.length);

    if (headers.includes("application/json")) {
      try {
        const parsed = JSON.parse(bodyText);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          requestBody = parsed;
        }
      } catch {
        requestBody = {};
      }
      continue;
    }

    const mimeTypeMatch = headers.match(/content-type:\s*([^\r\n;]+)/i);
    media = {
      mimeType: mimeTypeMatch?.[1]?.trim() ?? "application/octet-stream",
      body: Buffer.from(bodyText, "latin1"),
    };
  }

  return {
    requestBody,
    media,
  };
}

export function seedDefaultDriveItems(gs: GoogleStore, userEmail: string): void {
  if (gs.driveItems.findBy("user_email", userEmail).length > 0) return;

  const contractsFolder = createDriveItemRecord(gs, {
    google_id: "drv_contracts",
    user_email: userEmail,
    name: "Contracts",
    mime_type: GOOGLE_DRIVE_FOLDER_MIME_TYPE,
    parent_google_ids: ["root"],
  });

  createDriveItemRecord(gs, {
    google_id: "drv_pdf_guide",
    user_email: userEmail,
    name: "Welcome Guide.pdf",
    mime_type: "application/pdf",
    parent_google_ids: [contractsFolder.google_id],
    size: Buffer.byteLength("sample-pdf-data", "utf8"),
    data: Buffer.from("sample-pdf-data", "utf8").toString("base64url"),
  });
}

function parseDriveQuery(query: string | null): {
  parentId: string | null;
  mimeTypes: string[];
  excludeMimeTypes: string[];
  requireNotTrashed: boolean;
} {
  const source = query ?? "";
  const parentMatch = source.match(/'([^']+)' in parents/i);
  const mimeTypes = Array.from(source.matchAll(/mimeType = '([^']+)'/g)).map((match) => match[1]);
  const excludeMimeTypes = Array.from(source.matchAll(/mimeType != '([^']+)'/g)).map((match) => match[1]);

  return {
    parentId: parentMatch?.[1] ?? null,
    mimeTypes,
    excludeMimeTypes,
    requireNotTrashed: source.includes("trashed = false"),
  };
}

function buildDriveWebViewLink(itemId: string, mimeType: string): string {
  if (mimeType === GOOGLE_DRIVE_FOLDER_MIME_TYPE) {
    return `https://drive.google.com/drive/folders/${itemId}`;
  }

  return `https://drive.google.com/file/d/${itemId}/view`;
}

function normalizeParentIds(parentIds: string[] | undefined): string[] {
  const normalized = [...new Set((parentIds ?? ["root"]).filter(Boolean))];
  return normalized.length > 0 ? normalized : ["root"];
}

function stripMultipartBoundaryPadding(part: string): string {
  let normalized = part;

  if (normalized.startsWith("\r\n")) {
    normalized = normalized.slice(2);
  } else if (normalized.startsWith("\n")) {
    normalized = normalized.slice(1);
  }

  if (normalized.endsWith("\r\n")) {
    normalized = normalized.slice(0, -2);
  } else if (normalized.endsWith("\n")) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}
