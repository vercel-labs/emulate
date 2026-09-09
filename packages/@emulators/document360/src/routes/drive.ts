import type { D360DriveFolder } from "../entities.js";
import { formatDriveFolder, formatDriveItem } from "../formatters.js";
import { api, badRequest, bool, envelope, guid, parseJsonBody, route, skipTake, str, stringArray } from "../helpers.js";
import { logEvent } from "../store.js";
import { findFolder, findItem, type D360RouteContext } from "../route-utils.js";

export const DRIVE_CONTENT_PATH = "/_document360/drive";

export function driveRoutes(rc: D360RouteContext): void {
  const { app, ds, fmt } = rc;

  const folderTree = (folder: D360DriveFolder): Record<string, unknown> => ({
    ...formatDriveFolder(fmt, folder),
    sub_folders: ds.driveFolders
      .findBy("parent_folder_id", folder.d360_id)
      .sort((a, b) => a.id - b.id)
      .map(folderTree),
  });

  route(
    app,
    "get",
    "/v2/Drive/Folders",
    api(ds, (c) => {
      const roots = ds.driveFolders
        .all()
        .filter((folder) => folder.parent_folder_id === null)
        .sort((a, b) => a.id - b.id);
      return c.json(envelope(roots.map(folderTree)));
    }),
  );

  route(
    app,
    "post",
    "/v2/Drive/Folders",
    api(ds, async (c) => {
      const body = await parseJsonBody(c);
      const title = str(body.title)?.trim();
      if (!title) throw badRequest("title is required", "validation_error");
      const parentId = str(body.parent_folder_id) ?? null;
      if (parentId) findFolder(ds, parentId);
      const folder = ds.driveFolders.insert({
        d360_id: str(body.id) ?? guid(),
        title,
        parent_folder_id: parentId,
        is_system: false,
      });
      logEvent(ds, "drive_folder.created", folder.d360_id, { title: folder.title });
      return c.json(envelope(formatDriveFolder(fmt, folder)));
    }),
  );

  route(
    app,
    "get",
    "/v2/Drive/Folders/:id",
    api(ds, (c) => c.json(envelope(folderTree(findFolder(ds, c.req.param("id")))))),
  );

  route(
    app,
    "put",
    "/v2/Drive/Folders/:id",
    api(ds, async (c) => {
      const folder = findFolder(ds, c.req.param("id"));
      const body = await parseJsonBody(c);
      const title = body.title !== undefined ? (str(body.title)?.trim() ?? "") : folder.title;
      if (!title) throw badRequest("title cannot be empty", "validation_error");
      const parentId =
        body.parent_folder_id !== undefined ? (str(body.parent_folder_id) ?? null) : folder.parent_folder_id;
      if (parentId) {
        if (parentId === folder.d360_id) throw badRequest("A folder cannot be its own parent", "invalid_parent");
        findFolder(ds, parentId);
      }
      const updated = ds.driveFolders.update(folder.id, { title, parent_folder_id: parentId })!;
      return c.json(envelope(formatDriveFolder(fmt, updated)));
    }),
  );

  route(
    app,
    "delete",
    "/v2/Drive/Folders/:id",
    api(ds, (c) => {
      const folder = findFolder(ds, c.req.param("id"));
      if (folder.is_system) throw badRequest("System folders cannot be deleted", "system_folder");
      const remove = (target: D360DriveFolder) => {
        for (const child of ds.driveFolders.findBy("parent_folder_id", target.d360_id)) remove(child);
        for (const item of ds.driveItems.findBy("folder_id", target.d360_id)) ds.driveItems.delete(item.id);
        ds.driveFolders.delete(target.id);
      };
      remove(folder);
      logEvent(ds, "drive_folder.deleted", folder.d360_id, { title: folder.title });
      return c.json(envelope({ id: folder.d360_id }));
    }),
  );

  route(
    app,
    "get",
    "/v2/Drive/Folders/:id/Items",
    api(ds, (c) => {
      const folder = findFolder(ds, c.req.param("id"));
      const { skip, take } = skipTake(c);
      const items = ds.driveItems
        .findBy("folder_id", folder.d360_id)
        .sort((a, b) => a.id - b.id)
        .slice(skip, skip + take);
      return c.json(envelope(items.map((item) => formatDriveItem(fmt, item))));
    }),
  );

  route(
    app,
    "post",
    "/v2/Drive/Folders/:id/Items",
    api(ds, async (c, token) => {
      const folder = findFolder(ds, c.req.param("id"));
      const contentType = c.req.header("content-type") ?? "";
      const created = [];
      if (contentType.includes("multipart/form-data")) {
        const form = await c.req.raw.formData();
        const tags = form.getAll("tags").map(String).filter(Boolean);
        for (const [, value] of form.entries()) {
          if (typeof value === "string") continue;
          const buffer = Buffer.from(await value.arrayBuffer());
          const item = ds.driveItems.insert({
            d360_id: guid(),
            folder_id: folder.d360_id,
            title: value.name || "file",
            content_type: value.type || "application/octet-stream",
            size: buffer.byteLength,
            content: buffer.toString("base64"),
            tags,
            is_starred: false,
            created_by: token.description,
          });
          created.push(item);
        }
      } else {
        const body = await parseJsonBody(c);
        const title = str(body.title)?.trim();
        if (!title) throw badRequest("title is required", "validation_error");
        const raw = str(body.content) ?? "";
        const isBase64 = bool(body.base64) ?? false;
        const buffer = isBase64 ? Buffer.from(raw, "base64") : Buffer.from(raw, "utf8");
        created.push(
          ds.driveItems.insert({
            d360_id: str(body.id) ?? guid(),
            folder_id: folder.d360_id,
            title,
            content_type: str(body.content_type) ?? "application/octet-stream",
            size: buffer.byteLength,
            content: buffer.toString("base64"),
            tags: stringArray(body.tags) ?? [],
            is_starred: false,
            created_by: token.description,
          }),
        );
      }
      if (created.length === 0) throw badRequest("No files were provided", "validation_error");
      for (const item of created)
        logEvent(ds, "drive_item.created", item.d360_id, { title: item.title, folder: folder.title, size: item.size });
      return c.json(envelope(created.map((item) => formatDriveItem(fmt, item))));
    }),
  );

  route(
    app,
    "get",
    "/v2/Drive/Items/:id",
    api(ds, (c) => c.json(envelope(formatDriveItem(fmt, findItem(ds, c.req.param("id")))))),
  );

  route(
    app,
    "put",
    "/v2/Drive/Items/:id",
    api(ds, async (c) => {
      const item = findItem(ds, c.req.param("id"));
      const body = await parseJsonBody(c);
      const title = body.title !== undefined ? (str(body.title)?.trim() ?? "") : item.title;
      if (!title) throw badRequest("title cannot be empty", "validation_error");
      const folderId = body.folder_id !== undefined ? str(body.folder_id) : undefined;
      if (folderId) findFolder(ds, folderId);
      const updated = ds.driveItems.update(item.id, {
        title,
        folder_id: folderId ?? item.folder_id,
        tags: stringArray(body.tags) ?? item.tags,
        is_starred: bool(body.is_starred) ?? item.is_starred,
      })!;
      return c.json(envelope(formatDriveItem(fmt, updated)));
    }),
  );

  route(
    app,
    "delete",
    "/v2/Drive/Items/:id",
    api(ds, (c) => {
      const item = findItem(ds, c.req.param("id"));
      ds.driveItems.delete(item.id);
      logEvent(ds, "drive_item.deleted", item.d360_id, { title: item.title });
      return c.json(envelope({ id: item.d360_id }));
    }),
  );

  route(
    app,
    "get",
    "/v2/Drive/Items",
    api(ds, (c) => {
      const query = (c.req.query("search") ?? c.req.query("q") ?? "").toLowerCase();
      const items = ds.driveItems
        .all()
        .filter(
          (item) =>
            !query ||
            item.title.toLowerCase().includes(query) ||
            item.tags.some((tag) => tag.toLowerCase().includes(query)),
        )
        .sort((a, b) => a.id - b.id);
      return c.json(envelope(items.map((item) => formatDriveItem(fmt, item))));
    }),
  );

  app.get(`${DRIVE_CONTENT_PATH}/:id/:name`, (c) => {
    const item = ds.driveItems.findOneBy("d360_id", c.req.param("id"));
    if (!item) return c.text("Not found", 404);
    return c.body(Buffer.from(item.content, "base64"), 200, {
      "Content-Type": item.content_type,
      "Content-Length": String(item.size),
    });
  });
}
