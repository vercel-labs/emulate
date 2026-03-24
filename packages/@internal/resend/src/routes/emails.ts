import type { RouteContext } from "@internal/core";
import { parseJsonBody, requireAuth } from "@internal/core";
import { getResendStore } from "../store.js";
import {
  resendError,
  parseResendPagination,
  applyResendPagination,
} from "../helpers.js";
import type { ResendEmail } from "../entities.js";

function formatEmail(email: ResendEmail) {
  return {
    object: "email" as const,
    id: String(email.id),
    from: email.from,
    to: email.to,
    subject: email.subject,
    html: email.html,
    text: email.text,
    cc: email.cc,
    bcc: email.bcc,
    reply_to: email.reply_to,
    headers: email.headers,
    tags: email.tags,
    scheduled_at: email.scheduled_at,
    last_event: email.last_event,
    created_at: email.created_at,
    updated_at: email.updated_at,
  };
}

function normalizeToArray(to: unknown): string[] | null {
  if (typeof to === "string") return [to];
  if (Array.isArray(to)) return to.filter((v): v is string => typeof v === "string");
  return null;
}

export function emailRoutes({ app, store }: RouteContext): void {
  const rs = getResendStore(store);

  // Send email
  app.post("/emails", requireAuth(), async (c) => {
    const body = await parseJsonBody(c);

    const from = body.from;
    const to = normalizeToArray(body.to);
    const subject = body.subject;

    if (typeof from !== "string" || !from) {
      return resendError(c, 422, "validation_error", "Missing required field: from");
    }
    if (!to || to.length === 0) {
      return resendError(c, 422, "validation_error", "Missing required field: to");
    }
    if (typeof subject !== "string" || !subject) {
      return resendError(c, 422, "validation_error", "Missing required field: subject");
    }

    const scheduledAt = typeof body.scheduled_at === "string" ? body.scheduled_at : null;
    const lastEvent = scheduledAt ? "scheduled" : "sent";

    const email = rs.emails.insert({
      from,
      to,
      subject,
      html: typeof body.html === "string" ? body.html : null,
      text: typeof body.text === "string" ? body.text : null,
      cc: normalizeToArray(body.cc),
      bcc: normalizeToArray(body.bcc),
      reply_to: normalizeToArray(body.reply_to),
      headers: body.headers && typeof body.headers === "object" && !Array.isArray(body.headers)
        ? (body.headers as Record<string, string>)
        : null,
      tags: Array.isArray(body.tags) ? body.tags as Array<{ name: string; value: string }> : null,
      scheduled_at: scheduledAt,
      last_event: lastEvent,
    });

    return c.json({ id: String(email.id) });
  });

  // Batch send
  app.post("/emails/batch", requireAuth(), async (c) => {
    let items: unknown[];
    try {
      const raw = await c.req.json();
      if (!Array.isArray(raw)) {
        return resendError(c, 422, "validation_error", "Request body must be an array");
      }
      items = raw;
    } catch {
      return resendError(c, 400, "validation_error", "Problems parsing JSON");
    }

    if (items.length > 100) {
      return resendError(c, 422, "validation_error", "Batch size cannot exceed 100");
    }

    const results: Array<{ id: string }> = [];

    for (const item of items) {
      if (!item || typeof item !== "object") {
        return resendError(c, 422, "validation_error", "Each item must be an object");
      }
      const body = item as Record<string, unknown>;
      const from = body.from;
      const to = normalizeToArray(body.to);
      const subject = body.subject;

      if (typeof from !== "string" || !from) {
        return resendError(c, 422, "validation_error", "Missing required field: from");
      }
      if (!to || to.length === 0) {
        return resendError(c, 422, "validation_error", "Missing required field: to");
      }
      if (typeof subject !== "string" || !subject) {
        return resendError(c, 422, "validation_error", "Missing required field: subject");
      }

      const email = rs.emails.insert({
        from,
        to,
        subject,
        html: typeof body.html === "string" ? body.html : null,
        text: typeof body.text === "string" ? body.text : null,
        cc: normalizeToArray(body.cc),
        bcc: normalizeToArray(body.bcc),
        reply_to: normalizeToArray(body.reply_to),
        headers: body.headers && typeof body.headers === "object" && !Array.isArray(body.headers)
          ? (body.headers as Record<string, string>)
          : null,
        tags: Array.isArray(body.tags) ? body.tags as Array<{ name: string; value: string }> : null,
        scheduled_at: null,
        last_event: "sent",
      });

      results.push({ id: String(email.id) });
    }

    return c.json({ data: results });
  });

  // List emails
  app.get("/emails", requireAuth(), (c) => {
    const pagination = parseResendPagination(c);
    const allEmails = rs.emails.all();
    const { data, has_more } = applyResendPagination(allEmails, pagination);

    return c.json({
      object: "list",
      has_more,
      data: data.map(formatEmail),
    });
  });

  // Get email
  app.get("/emails/:id", requireAuth(), (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const email = rs.emails.get(id);
    if (!email) {
      return resendError(c, 404, "not_found", "Email not found");
    }
    return c.json(formatEmail(email));
  });

  // Update email (only scheduled_at)
  app.patch("/emails/:id", requireAuth(), async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const email = rs.emails.get(id);
    if (!email) {
      return resendError(c, 404, "not_found", "Email not found");
    }

    const body = await parseJsonBody(c);
    const updates: Partial<ResendEmail> = {};

    if (typeof body.scheduled_at === "string") {
      updates.scheduled_at = body.scheduled_at;
    }

    const updated = rs.emails.update(id, updates);
    if (!updated) {
      return resendError(c, 404, "not_found", "Email not found");
    }

    return c.json(formatEmail(updated));
  });

  // Cancel scheduled email
  app.post("/emails/:id/cancel", requireAuth(), (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const email = rs.emails.get(id);
    if (!email) {
      return resendError(c, 404, "not_found", "Email not found");
    }

    const updated = rs.emails.update(id, { last_event: "canceled" } as Partial<ResendEmail>);
    if (!updated) {
      return resendError(c, 404, "not_found", "Email not found");
    }

    return c.json(formatEmail(updated));
  });
}
