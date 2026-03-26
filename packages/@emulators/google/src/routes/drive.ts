import type { RouteContext } from "@emulators/core";
import type { Context } from "hono";
import {
  createDriveItemRecord,
  formatDriveItemResource,
  getDriveItemById,
  listDriveItems,
  parseDriveMultipartUpload,
  updateDriveItemRecord,
} from "../drive-helpers.js";
import { googleApiError } from "../helpers.js";
import { getRecord, getString, parseDriveItemInputFromBody, parseGoogleBody, requireGoogleAuth } from "../route-helpers.js";
import { getGoogleStore } from "../store.js";

export function driveRoutes({ app, store }: RouteContext): void {
  const gs = getGoogleStore(store);

  const createHandler = async (c: Context) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const contentType = c.req.header("Content-Type") ?? "";
    let requestBody: Record<string, unknown> = {};
    let media: { mimeType: string; body: Buffer } | undefined;

    if (contentType.includes("multipart/related")) {
      const rawBody = Buffer.from(await c.req.raw.arrayBuffer());
      const parsed = parseDriveMultipartUpload(contentType, rawBody);
      requestBody = parsed.requestBody;
      media = parsed.media;
    } else {
      const body = await parseGoogleBody(c);
      requestBody = getRecord(body, "requestBody") ?? body;
    }

    const item = createDriveItemRecord(gs, {
      user_email: authEmail,
      ...parseDriveItemInputFromBody(requestBody, {
        mimeType: media?.mimeType,
      }),
      size: media ? media.body.length : null,
      data: media ? media.body.toString("base64url") : null,
    });
    return c.json(formatDriveItemResource(item));
  };

  app.get("/drive/v3/files", (c) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const url = new URL(c.req.url);
    const response = listDriveItems(gs, authEmail, {
      q: url.searchParams.get("q"),
      pageSize: url.searchParams.get("pageSize"),
      pageToken: url.searchParams.get("pageToken"),
      orderBy: url.searchParams.get("orderBy"),
    });

    return c.json({
      kind: "drive#fileList",
      files: response.files.map((item) => formatDriveItemResource(item)),
      nextPageToken: response.nextPageToken,
    });
  });

  app.post("/drive/v3/files", createHandler);
  app.post("/upload/drive/v3/files", createHandler);

  app.get("/drive/v3/files/:fileId", (c) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const item = getDriveItemById(gs, authEmail, c.req.param("fileId"));
    if (!item) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    const url = new URL(c.req.url);
    if (url.searchParams.get("alt") === "media") {
      return new Response(item.data ? Buffer.from(item.data, "base64url") : Buffer.alloc(0), {
        status: 200,
        headers: {
          "Content-Type": item.mime_type,
        },
      });
    }

    return c.json(formatDriveItemResource(item));
  });

  const updateHandler = async (c: Context) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const item = getDriveItemById(gs, authEmail, c.req.param("fileId"));
    if (!item) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    const url = new URL(c.req.url);
    const body = await parseGoogleBody(c);
    const requestBody = getRecord(body, "requestBody") ?? body;
    const addParents = (url.searchParams.get("addParents") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const removeParents = (url.searchParams.get("removeParents") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    const updated = updateDriveItemRecord(gs, item, {
      addParents,
      removeParents,
      name: getString(requestBody, "name"),
    });

    return c.json(formatDriveItemResource(updated));
  };

  app.patch("/drive/v3/files/:fileId", updateHandler);
  app.put("/drive/v3/files/:fileId", updateHandler);
}
