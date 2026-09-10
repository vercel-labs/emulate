import type { AppEnv, Hono } from "@emulators/core";
import { escapeHtml } from "@emulators/core";
import type { EmailFlag, ScwEmail } from "../entities.js";
import { num, parseJsonBody, ScalewayError, sendError, str } from "../helpers.js";
import { type ScwStore } from "../store.js";
import { formatEmail, resolveEmail, setEmailStatus } from "./emails.js";

export function emailContent(scw: ScwStore, email: ScwEmail): Record<string, unknown> {
  const siblings = scw.emails.findBy("message_id", email.message_id);
  return {
    ...formatEmail(scw, email),
    from: { email: email.mail_from, name: email.from_name },
    to: siblings
      .filter((sibling) => sibling.rcpt_type === "to")
      .map((sibling) => ({ email: sibling.mail_rcpt, name: sibling.rcpt_name })),
    cc: siblings
      .filter((sibling) => sibling.rcpt_type === "cc")
      .map((sibling) => ({ email: sibling.mail_rcpt, name: sibling.rcpt_name })),
    bcc: siblings
      .filter((sibling) => sibling.rcpt_type === "bcc")
      .map((sibling) => ({ email: sibling.mail_rcpt, name: sibling.rcpt_name })),
    text: email.text,
    html: email.html,
    attachments: email.attachments,
    additional_headers: email.additional_headers,
    send_before: email.send_before,
    region: email.region,
    domain_id: email.domain_id,
  };
}

export function miscRoutes(app: Hono<AppEnv>, scw: ScwStore): void {
  const resolveTargets = (body: Record<string, unknown>): ScwEmail[] => {
    const id = str(body.email_id) ?? str(body.id);
    if (id) return scw.emails.findBy("email_id", id);
    const messageId = str(body.message_id);
    if (messageId) return scw.emails.findBy("message_id", messageId);
    const rcpt = str(body.mail_rcpt) ?? str(body.to);
    if (rcpt)
      return scw.emails
        .findBy("mail_rcpt", rcpt)
        .filter((email) => ["new", "sending"].includes(resolveEmail(email).status));
    return [];
  };

  const simulate = (path: string, apply: (email: ScwEmail, body: Record<string, unknown>) => ScwEmail) => {
    app.post(`/_scaleway/simulate/${path}`, async (c) => {
      try {
        const body = await parseJsonBody(c);
        const targets = resolveTargets(body);
        if (targets.length === 0)
          return c.json(
            {
              message: "no email matched email_id, message_id, or mail_rcpt",
              type: "not_found",
              resource: "email",
              resource_id: str(body.email_id) ?? str(body.message_id) ?? str(body.mail_rcpt) ?? "",
            },
            404,
          );
        const updated = targets.map((email) => apply(email, body));
        return c.json({ emails: updated.map((email) => formatEmail(scw, email)) });
      } catch (error) {
        if (error instanceof ScalewayError) return sendError(c, error);
        throw error;
      }
    });
  };

  simulate("deliver", (email) =>
    setEmailStatus(scw, email, "sent", { details: "delivered", code: 250, message: "250 2.0.0 OK: queued as emulate" }),
  );
  simulate("bounce", (email, body) => {
    const hard = body.hard !== false && body.soft !== true;
    const flags: EmailFlag[] = hard ? ["hard_bounce", "mailbox_not_found"] : ["soft_bounce", "mailbox_full"];
    return setEmailStatus(scw, email, "failed", {
      details:
        str(body.details) ??
        (hard
          ? "550 5.1.1 The email account that you tried to reach does not exist"
          : "452 4.2.2 The recipient mailbox is full"),
      flags: (Array.isArray(body.flags) ? (body.flags as EmailFlag[]) : undefined) ?? flags,
      code: hard ? 550 : 452,
      message: hard ? "550 5.1.1 User unknown" : "452 4.2.2 Mailbox full",
    });
  });
  simulate("spam", (email) =>
    setEmailStatus(scw, email, "sent", {
      details: "delivered to spam folder",
      flags: ["spam"],
      code: 250,
      message: "250 2.0.0 OK (classified as spam)",
    }),
  );
  simulate("defer", (email, body) =>
    setEmailStatus(scw, email, "sending", {
      details: str(body.details) ?? "451 4.7.1 Greylisted, please try again later",
      flags: ["greylisted"],
      code: 451,
      message: "451 4.7.1 Greylisted",
    }),
  );
  simulate("fail", (email, body) =>
    setEmailStatus(scw, email, "failed", {
      details: str(body.details) ?? "554 5.7.1 Message rejected",
      code: num(body.code) ?? 554,
      message: str(body.details) ?? "554 5.7.1 Message rejected",
    }),
  );

  app.get("/_scaleway/emails", (c) => {
    const rows = [...scw.emails.all()]
      .sort((a, b) => b.id - a.id)
      .slice(0, Math.min(num(c.req.query("limit")) ?? 100, 1000));
    return c.json({ total_count: scw.emails.count(), emails: rows.map((email) => emailContent(scw, email)) });
  });

  app.get("/_scaleway/emails/:id", (c) => {
    const email =
      scw.emails.findOneBy("email_id", c.req.param("id")) ?? scw.emails.findOneBy("message_id", c.req.param("id"));
    if (!email)
      return c.json(
        { message: "resource is not found", type: "not_found", resource: "email", resource_id: c.req.param("id") },
        404,
      );
    return c.json(emailContent(scw, email));
  });

  app.get("/_scaleway/emails/:id/html", (c) => {
    const email = scw.emails.findOneBy("email_id", c.req.param("id"));
    if (!email) return c.text("not found", 404);
    return c.html(email.html || `<pre>${escapeHtml(email.text)}</pre>`);
  });

  app.get("/_scaleway/emails/:id/text", (c) => {
    const email = scw.emails.findOneBy("email_id", c.req.param("id"));
    if (!email) return c.text("not found", 404);
    return c.text(email.text);
  });

  app.delete("/_scaleway/emails", (c) => {
    scw.emails.clear();
    scw.webhookEvents.clear();
    return c.json({ ok: true });
  });

  app.get("/_scaleway/events", (c) => {
    const type = c.req.query("type");
    const limit = Math.min(num(c.req.query("limit")) ?? 100, 1000);
    const events = [...scw.events.all()]
      .filter((event) => !type || event.type === type)
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
    return c.json({
      events: events.map((event) => ({
        id: event.id,
        type: event.type,
        subject: event.subject,
        detail: event.detail,
        created_at: event.created_at,
      })),
    });
  });

  app.delete("/_scaleway/events", (c) => {
    scw.events.clear();
    return c.json({ ok: true });
  });
}
