import type { RouteContext } from "@emulators/core";
import { getResendStore } from "../store.js";
import { generateUuid, resendError, resendList, parseResendBody } from "../helpers.js";

export function emailRoutes(ctx: RouteContext): void {
  const { app, store, webhooks } = ctx;
  const rs = () => getResendStore(store);

  app.post("/emails/batch", async (c) => {
    let emails: Array<Record<string, unknown>>;
    try {
      const raw = await c.req.json();
      if (!Array.isArray(raw)) {
        return resendError(c, 422, "validation_error", "Request body must be an array");
      }
      emails = raw;
    } catch {
      return resendError(c, 422, "validation_error", "Request body must be an array");
    }

    if (emails.length > 100) {
      return resendError(c, 422, "validation_error", "Batch size cannot exceed 100 emails");
    }

    // Validate all emails before inserting any to prevent phantom records
    for (const emailData of emails) {
      if (!emailData.from) return resendError(c, 422, "validation_error", "Missing required field: from");
      if (!emailData.to) return resendError(c, 422, "validation_error", "Missing required field: to");
      if (!emailData.subject) return resendError(c, 422, "validation_error", "Missing required field: subject");
    }

    const results: Array<{ id: string }> = [];

    for (const emailData of emails) {
      const from = emailData.from as string;
      const to = emailData.to as string | string[];
      const subject = emailData.subject as string;
      const toArray = Array.isArray(to) ? to : [to];
      const uuid = generateUuid();

      const scheduledAt = emailData.scheduled_at as string | undefined;
      const status = scheduledAt ? "scheduled" as const : "delivered" as const;

      rs().emails.insert({
        uuid,
        from,
        to: toArray,
        subject,
        html: (emailData.html as string) ?? null,
        text: (emailData.text as string) ?? null,
        cc: normalizeStringArray(emailData.cc),
        bcc: normalizeStringArray(emailData.bcc),
        reply_to: normalizeStringArray(emailData.reply_to),
        headers: (emailData.headers as Record<string, string>) ?? {},
        tags: (emailData.tags as Array<{ name: string; value: string }>) ?? [],
        status,
        scheduled_at: scheduledAt ?? null,
        last_event: status === "scheduled" ? "email.scheduled" : "email.delivered",
      });

      if (!scheduledAt) {
        await webhooks.dispatch("email.sent", undefined, { type: "email.sent", data: { email_id: uuid, to: toArray, from, subject } }, "resend");
        await webhooks.dispatch("email.delivered", undefined, { type: "email.delivered", data: { email_id: uuid, to: toArray, from, subject } }, "resend");
      }

      results.push({ id: uuid });
    }

    return c.json({ data: results }, 200);
  });

  app.post("/emails", async (c) => {
    const body = await parseResendBody(c);
    const from = body.from as string | undefined;
    const to = body.to as string | string[] | undefined;
    const subject = body.subject as string | undefined;

    if (!from) return resendError(c, 422, "validation_error", "Missing required field: from");
    if (!to) return resendError(c, 422, "validation_error", "Missing required field: to");
    if (!subject) return resendError(c, 422, "validation_error", "Missing required field: subject");

    const toArray = Array.isArray(to) ? to : [to];
    const uuid = generateUuid();

    const scheduledAt = body.scheduled_at as string | undefined;
    const status = scheduledAt ? "scheduled" as const : "delivered" as const;

    rs().emails.insert({
      uuid,
      from,
      to: toArray,
      subject,
      html: (body.html as string) ?? null,
      text: (body.text as string) ?? null,
      cc: normalizeStringArray(body.cc),
      bcc: normalizeStringArray(body.bcc),
      reply_to: normalizeStringArray(body.reply_to),
      headers: (body.headers as Record<string, string>) ?? {},
      tags: (body.tags as Array<{ name: string; value: string }>) ?? [],
      status,
      scheduled_at: scheduledAt ?? null,
      last_event: status === "scheduled" ? "email.scheduled" : "email.delivered",
    });

    if (!scheduledAt) {
      await webhooks.dispatch("email.sent", undefined, { type: "email.sent", data: { email_id: uuid, to: toArray, from, subject } }, "resend");
      await webhooks.dispatch("email.delivered", undefined, { type: "email.delivered", data: { email_id: uuid, to: toArray, from, subject } }, "resend");
    }

    return c.json({ id: uuid }, 200);
  });

  app.get("/emails", (c) => {
    const allEmails = rs().emails.all();
    return c.json(resendList(allEmails.map(formatEmail)));
  });

  app.get("/emails/:id", (c) => {
    const id = c.req.param("id");
    const email = rs().emails.findOneBy("uuid", id);
    if (!email) return resendError(c, 404, "not_found", "Email not found");
    return c.json(formatEmail(email));
  });

  app.post("/emails/:id/cancel", (c) => {
    const id = c.req.param("id");
    const email = rs().emails.findOneBy("uuid", id);
    if (!email) return resendError(c, 404, "not_found", "Email not found");

    if (email.status !== "scheduled") {
      return resendError(c, 422, "validation_error", "Only scheduled emails can be canceled");
    }

    rs().emails.update(email.id, {
      status: "canceled",
      last_event: "email.canceled",
    });

    return c.json({ id: email.uuid, object: "email", canceled: true });
  });
}

function normalizeStringArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return [value];
  return [];
}

function formatEmail(email: any) {
  return {
    id: email.uuid,
    object: "email",
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
    status: email.status,
    scheduled_at: email.scheduled_at,
    last_event: email.last_event,
    created_at: email.created_at,
  };
}
