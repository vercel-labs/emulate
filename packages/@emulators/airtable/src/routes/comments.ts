import type { Context, RouteContext, Store } from "@emulators/core";
import { getAirtableStore } from "../store.js";
import type { AirtableComment, AirtableCommentAuthor, AirtableMention, AirtableRecordEntity } from "../entities.js";
import { airtableError, airtableNotFound, decodeOffset, encodeOffset, parseJsonBody } from "../helpers.js";
import { resolveBase, resolveTable } from "../schema.js";
import { generateCommentId } from "../ids.js";

const MODEL_NOT_FOUND =
  "Invalid permissions, or the requested model was not found. Check that both your user and your token have the required permissions, and that the model names and/or ids are correct.";
const MENTION_RE = /@\[(usr[A-Za-z0-9]+)\]/g;

/** Resolve base + table + record for a comment route, returning Airtable's distinct
 * errors (bare-string 404 for base/record, 403 for table). */
function resolveRecord(
  c: Context,
  store: Store,
  baseId: string,
  tableIdOrName: string,
  recordId: string,
): AirtableRecordEntity | Response {
  if (!resolveBase(store, baseId)) return airtableNotFound(c);
  const table = resolveTable(store, baseId, tableIdOrName);
  if (!table) return airtableError(c, 403, "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND", MODEL_NOT_FOUND);
  const rec = getAirtableStore(store).records.findOneBy("record_id", recordId);
  if (!rec || rec.table_id !== table.table_id) return airtableNotFound(c);
  return rec;
}

function currentAuthor(store: Store): AirtableCommentAuthor {
  const user = getAirtableStore(store).users.all()[0];
  if (!user) return { id: "usrEmulatorDefault", email: "dev@example.com" };
  return { id: user.user_id, email: user.email, name: user.name };
}

function parseMentions(store: Store, text: string): Record<string, AirtableMention> | null {
  const users = getAirtableStore(store).users;
  const mentioned: Record<string, AirtableMention> = {};
  for (const m of text.matchAll(MENTION_RE)) {
    const userId = m[1];
    const user = users.findOneBy("user_id", userId);
    mentioned[userId] = { type: "user", id: userId, displayName: user?.name, email: user?.email };
  }
  return Object.keys(mentioned).length > 0 ? mentioned : null;
}

function serializeComment(comment: AirtableComment) {
  return {
    id: comment.comment_id,
    author: comment.author,
    text: comment.text,
    createdTime: comment.created_time,
    lastUpdatedTime: comment.last_updated_time ?? null,
    mentioned: comment.mentioned ?? undefined,
  };
}

export function commentRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;

  app.get("/v0/:baseId/:tableId/:recordId/comments", (c) => {
    const rec = resolveRecord(c, store, c.req.param("baseId"), c.req.param("tableId"), c.req.param("recordId"));
    if (rec instanceof Response) return rec;

    const all = getAirtableStore(store)
      .comments.findBy("record_id", rec.record_id)
      .sort((a, b) => (a.created_time < b.created_time ? -1 : a.created_time > b.created_time ? 1 : a.id - b.id));

    const pageSizeRaw = c.req.query("pageSize");
    const pageSize = pageSizeRaw != null ? Number(pageSizeRaw) : 100;
    const start = decodeOffset(c.req.query("offset"));
    const page = all.slice(start, start + pageSize);
    const nextOffset = start + pageSize < all.length ? encodeOffset(start + pageSize) : undefined;

    const comments = page.map(serializeComment);
    return c.json(nextOffset ? { comments, offset: nextOffset } : { comments });
  });

  app.post("/v0/:baseId/:tableId/:recordId/comments", async (c) => {
    const rec = resolveRecord(c, store, c.req.param("baseId"), c.req.param("tableId"), c.req.param("recordId"));
    if (rec instanceof Response) return rec;

    const body = await parseJsonBody(c);
    const text = typeof body.text === "string" ? body.text : "";
    if (!text) {
      return airtableError(c, 422, "INVALID_REQUEST_MISSING_FIELDS", 'Could not find field "text" in the request body');
    }

    const comment = getAirtableStore(store).comments.insert({
      comment_id: generateCommentId(),
      record_id: rec.record_id,
      text,
      author: currentAuthor(store),
      created_time: new Date().toISOString(),
      last_updated_time: null,
      mentioned: parseMentions(store, text),
    });

    return c.json(serializeComment(comment));
  });

  app.delete("/v0/:baseId/:tableId/:recordId/comments/:commentId", (c) => {
    const rec = resolveRecord(c, store, c.req.param("baseId"), c.req.param("tableId"), c.req.param("recordId"));
    if (rec instanceof Response) return rec;
    const comment = getAirtableStore(store).comments.findOneBy("comment_id", c.req.param("commentId"));
    if (!comment || comment.record_id !== rec.record_id) return airtableNotFound(c);
    getAirtableStore(store).comments.delete(comment.id);
    return c.json({ id: comment.comment_id, deleted: true });
  });
}
