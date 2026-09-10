import type { AppEnv, Hono } from "@emulators/core";
import {
  EMAIL_FLAGS,
  EMAIL_STATUSES,
  type EmailFlag,
  type EmailStatus,
  type EmailTry,
  type RcptType,
  type Region,
  type ScwDomain,
  type ScwEmail,
  type WebhookEventType,
} from "../entities.js";
import {
  allQuery,
  api,
  domainOf,
  guid,
  invalidArguments,
  isEmail,
  notFound,
  nowIso,
  obj,
  paginate,
  parseDate,
  parseJsonBody,
  permissionsDenied,
  preconditionFailed,
  queryOf,
  route,
  str,
  type ArgumentDetail,
  type Json,
} from "../helpers.js";
import { logEvent, settings, type ScwStore } from "../store.js";

const ALLOWED_ATTACHMENT_TYPES = new Set([
  "application/pdf",
  "application/json",
  "application/xml",
  "text/xml",
  "text/plain",
  "text/csv",
  "text/calendar",
  "text/html",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "application/zip",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
]);

export interface ResolvedEmail {
  status: EmailStatus;
  updated_at: string;
  tries: EmailTry[];
}

export function resolveEmail(email: ScwEmail): ResolvedEmail {
  if (email.status_override)
    return {
      status: email.status_override,
      updated_at: email.status_override_at ?? email.created_at_iso,
      tries: email.tries,
    };
  const created = Date.parse(email.created_at_iso);
  const age = Date.now() - created;
  const delay = email.delivery_delay_ms;
  if (email.send_before && Date.parse(email.send_before) < Date.now() && age < delay)
    return { status: "failed", updated_at: email.send_before, tries: [] };
  if (age < delay / 2) return { status: "new", updated_at: email.created_at_iso, tries: [] };
  if (age < delay) return { status: "sending", updated_at: new Date(created + delay / 2).toISOString(), tries: [] };
  const sentAt = new Date(created + delay).toISOString();
  return {
    status: "sent",
    updated_at: sentAt,
    tries: [{ rank: 1, tried_at: sentAt, code: 250, message: "250 2.0.0 OK: queued as emulate" }],
  };
}

export function formatEmail(scw: ScwStore, email: ScwEmail): Json {
  const resolved = resolveEmail(email);
  if (resolved.status === "sent" && !email.delivered_event_sent) {
    scw.emails.update(email.id, { delivered_event_sent: true });
    recordWebhookEvent(scw, email, "email_delivered", { status: "sent", tried_at: resolved.updated_at });
  }
  return {
    id: email.email_id,
    message_id: email.message_id,
    project_id: email.project_id,
    mail_from: email.mail_from,
    rcpt_to: email.mail_rcpt,
    mail_rcpt: email.mail_rcpt,
    rcpt_type: email.rcpt_type,
    subject: email.subject,
    created_at: email.created_at_iso,
    updated_at: resolved.updated_at,
    status: resolved.status,
    status_details:
      email.status_details ??
      (resolved.status === "sent"
        ? "delivered"
        : resolved.status === "failed" && email.send_before
          ? "send_before expired"
          : null),
    try_count: resolved.tries.length,
    last_tries: resolved.tries,
    flags:
      email.send_before && resolved.status === "failed" && !email.status_override
        ? [...email.flags, "send_before_expiration"]
        : email.flags,
  };
}

export function recordWebhookEvent(scw: ScwStore, email: ScwEmail, type: WebhookEventType, extra: Json = {}): void {
  if (!email.domain_id) return;
  for (const webhook of scw.webhooks.findBy("domain_id", email.domain_id)) {
    if (!webhook.event_types.includes(type)) continue;
    scw.webhookEvents.insert({
      event_id: guid(),
      webhook_id: webhook.webhook_id,
      organization_id: webhook.organization_id,
      project_id: webhook.project_id,
      domain_id: webhook.domain_id,
      type,
      status: "sent",
      data: JSON.stringify({
        type,
        email_id: email.email_id,
        message_id: email.message_id,
        mail_from: email.mail_from,
        mail_rcpt: email.mail_rcpt,
        subject: email.subject,
        ...extra,
      }),
      email_id: email.email_id,
    });
  }
}

export function setEmailStatus(
  scw: ScwStore,
  email: ScwEmail,
  status: EmailStatus,
  options: { details?: string; flags?: EmailFlag[]; code?: number; message?: string } = {},
): ScwEmail {
  const at = nowIso();
  const tries: EmailTry[] =
    status === "sent" || status === "failed" || (status === "sending" && options.code)
      ? [
          ...email.tries,
          {
            rank: email.tries.length + 1,
            tried_at: at,
            code: options.code ?? (status === "sent" ? 250 : 550),
            message:
              options.message ??
              (status === "sent" ? "250 2.0.0 OK: queued as emulate" : "550 5.1.1 Recipient address rejected"),
          },
        ]
      : email.tries;
  const updated = scw.emails.update(email.id, {
    status_override: status,
    status_override_at: at,
    status_details: options.details ?? email.status_details,
    flags: [...new Set([...email.flags, ...(options.flags ?? [])])],
    tries,
    delivered_event_sent: status === "sent" ? true : email.delivered_event_sent,
  })!;
  const eventType: WebhookEventType | null =
    status === "sent"
      ? updated.flags.includes("spam")
        ? "email_spam"
        : "email_delivered"
      : status === "failed"
        ? updated.flags.includes("mailbox_not_found")
          ? "email_mailbox_not_found"
          : updated.flags.includes("blocklisted")
            ? "email_blocklisted"
            : "email_dropped"
        : status === "sending" && options.code
          ? "email_deferred"
          : null;
  if (eventType)
    recordWebhookEvent(scw, updated, eventType, { status, details: options.details ?? null, flags: updated.flags });
  logEvent(scw, `email.${status}`, updated.email_id, {
    mail_rcpt: updated.mail_rcpt,
    details: options.details ?? null,
    flags: updated.flags,
  });
  return updated;
}

interface Address {
  email: string;
  name: string | null;
}

function parseAddresses(value: unknown, field: string, details: ArgumentDetail[], required: boolean): Address[] {
  if (value === undefined || value === null) {
    if (required)
      details.push({ argument_name: field, help_message: "at least one recipient is required", reason: "required" });
    return [];
  }
  if (!Array.isArray(value)) {
    details.push({ argument_name: field, help_message: "must be an array of addresses", reason: "invalid_format" });
    return [];
  }
  if (required && value.length === 0)
    details.push({ argument_name: field, help_message: "at least one recipient is required", reason: "required" });
  return value.flatMap((entry, index) => {
    const record = obj(entry);
    const email = str(record?.email)?.trim();
    if (!email || !isEmail(email)) {
      details.push({
        argument_name: `${field}.${index}.email`,
        help_message: "must be a valid email address",
        reason: "invalid_format",
      });
      return [];
    }
    return [{ email, name: str(record?.name) ?? null }];
  });
}

export interface CreateEmailInput {
  projectId: string;
  region: Region;
  from: Address;
  to: Address[];
  cc?: Address[];
  bcc?: Address[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<{ name: string; type: string; size: number }>;
  additionalHeaders?: Array<{ key: string; value: string }>;
  sendBefore?: string | null;
  createdAt?: string;
  messageId?: string;
  status?: EmailStatus;
  flags?: EmailFlag[];
  statusDetails?: string;
}

export function createEmails(scw: ScwStore, input: CreateEmailInput): ScwEmail[] {
  const config = settings(scw);
  const domain: ScwDomain | undefined = scw.domains
    .all()
    .find(
      (candidate) =>
        candidate.name.toLowerCase() === domainOf(input.from.email) &&
        candidate.project_id === input.projectId &&
        candidate.status !== "revoked",
    );
  const messageId = input.messageId ?? `<${guid()}@${domain?.name ?? "emulate.scaleway"}>`;
  const createdAt = input.createdAt ?? nowIso();
  const recipients: Array<{ address: Address; type: RcptType }> = [
    ...input.to.map((address) => ({ address, type: "to" as const })),
    ...(input.cc ?? []).map((address) => ({ address, type: "cc" as const })),
    ...(input.bcc ?? []).map((address) => ({ address, type: "bcc" as const })),
  ];
  const emails = recipients.map(({ address, type }) => {
    const blocklisted = domain
      ? scw.blocklists
          .findBy("domain_id", domain.domain_id)
          .find(
            (entry) =>
              entry.email.toLowerCase() === address.email.toLowerCase() && Date.parse(entry.ends_at) > Date.now(),
          )
      : undefined;
    const email = scw.emails.insert({
      email_id: guid(),
      message_id: messageId,
      project_id: input.projectId,
      domain_id: domain?.domain_id ?? null,
      region: input.region,
      mail_from: input.from.email,
      from_name: input.from.name,
      mail_rcpt: address.email,
      rcpt_name: address.name,
      rcpt_type: type,
      subject: input.subject,
      text: input.text ?? "",
      html: input.html ?? "",
      attachments: input.attachments ?? [],
      additional_headers: input.additionalHeaders ?? [],
      send_before: input.sendBefore ?? null,
      created_at_iso: createdAt,
      status_override: input.status ?? null,
      status_override_at: input.status ? createdAt : null,
      status_details: input.statusDetails ?? null,
      flags: input.flags ?? [],
      tries:
        input.status === "sent"
          ? [{ rank: 1, tried_at: createdAt, code: 250, message: "250 2.0.0 OK: queued as emulate" }]
          : [],
      delivered_event_sent: input.status === "sent",
      delivery_delay_ms: config.delivery_delay_ms,
    });
    if (blocklisted) {
      return setEmailStatus(scw, email, "failed", {
        details: `recipient is blocklisted (${blocklisted.type})`,
        flags: ["blocklisted", blocklisted.type],
        code: blocklisted.type === "mailbox_full" ? 452 : 550,
        message: blocklisted.type === "mailbox_full" ? "452 4.2.2 Mailbox full" : "550 5.1.1 User unknown",
      });
    }
    recordWebhookEvent(scw, email, "email_queued", { status: "new" });
    return email;
  });
  logEvent(scw, "email.created", messageId, {
    from: input.from.email,
    recipients: recipients.map((entry) => entry.address.email),
    subject: input.subject,
    domain: domain?.name ?? null,
    count: emails.length,
  });
  return emails;
}

export function emailRoutes(app: Hono<AppEnv>, scw: ScwStore): void {
  const findEmail = (id: string) => {
    const email = scw.emails.findOneBy("email_id", id);
    if (!email) throw notFound("email", id);
    return email;
  };
  const assertProject = (
    projectId: string | undefined,
    key: { project_ids: string[] | null },
    details: ArgumentDetail[],
  ): string | undefined => {
    if (!projectId) {
      details.push({ argument_name: "project_id", help_message: "project_id is required", reason: "required" });
      return undefined;
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
      details.push({
        argument_name: "project_id",
        help_message: "project_id must be a UUID",
        reason: "invalid_format",
      });
      return undefined;
    }
    return projectId;
  };

  route(
    app,
    "post",
    "/emails",
    api(scw, async (c, key, region) => {
      const body = await parseJsonBody(c);
      const config = settings(scw);
      const details: ArgumentDetail[] = [];
      const projectId = assertProject(str(body.project_id), key, details);
      const fromRecord = obj(body.from);
      const fromEmail = str(fromRecord?.email)?.trim();
      if (!fromEmail)
        details.push({ argument_name: "from.email", help_message: "from.email is required", reason: "required" });
      else if (!isEmail(fromEmail))
        details.push({
          argument_name: "from.email",
          help_message: "must be a valid email address",
          reason: "invalid_format",
        });
      const to = parseAddresses(body.to, "to", details, true);
      const cc = parseAddresses(body.cc, "cc", details, false);
      const bcc = parseAddresses(body.bcc, "bcc", details, false);
      if (to.length + cc.length + bcc.length > config.max_recipients)
        details.push({
          argument_name: "to",
          help_message: `an email cannot have more than ${config.max_recipients} recipients`,
          reason: "constraint",
        });
      const subject = str(body.subject)?.trim();
      if (!subject) details.push({ argument_name: "subject", help_message: "subject is required", reason: "required" });
      const text = str(body.text);
      const html = str(body.html);
      if (!text && !html)
        details.push({ argument_name: "text", help_message: "text or html is required", reason: "required" });
      const attachments: Array<{ name: string; type: string; size: number }> = [];
      if (body.attachments !== undefined && !Array.isArray(body.attachments))
        details.push({ argument_name: "attachments", help_message: "must be an array", reason: "invalid_format" });
      let attachmentBytes = 0;
      for (const [index, entry] of (Array.isArray(body.attachments) ? body.attachments : []).entries()) {
        const record = obj(entry) ?? {};
        const name = str(record.name);
        const type = str(record.type)?.toLowerCase();
        const content = str(record.content) ?? "";
        if (!name)
          details.push({
            argument_name: `attachments.${index}.name`,
            help_message: "name is required",
            reason: "required",
          });
        if (!type || !ALLOWED_ATTACHMENT_TYPES.has(type))
          details.push({
            argument_name: `attachments.${index}.type`,
            help_message: `unsupported attachment type ${type ?? ""}`,
            reason: "constraint",
          });
        const size = Buffer.from(content, "base64").length;
        attachmentBytes += size;
        attachments.push({ name: name ?? "", type: type ?? "", size });
      }
      if (attachmentBytes > config.max_attachment_bytes)
        details.push({
          argument_name: "attachments",
          help_message: `attachments cannot exceed ${config.max_attachment_bytes} bytes`,
          reason: "constraint",
        });
      const headers: Array<{ key: string; value: string }> = [];
      for (const [index, entry] of (Array.isArray(body.additional_headers) ? body.additional_headers : []).entries()) {
        const record = obj(entry) ?? {};
        const headerKey = str(record.key);
        if (!headerKey)
          details.push({
            argument_name: `additional_headers.${index}.key`,
            help_message: "key is required",
            reason: "required",
          });
        else headers.push({ key: headerKey, value: str(record.value) ?? "" });
      }
      const sendBefore = str(body.send_before);
      if (sendBefore && Number.isNaN(Date.parse(sendBefore)))
        details.push({
          argument_name: "send_before",
          help_message: "must be an RFC 3339 timestamp",
          reason: "invalid_format",
        });
      if (fromEmail && projectId && config.strict_domains) {
        const domain = scw.domains
          .all()
          .find(
            (candidate) => candidate.name.toLowerCase() === domainOf(fromEmail) && candidate.project_id === projectId,
          );
        if (!domain || domain.status !== "checked")
          details.push({
            argument_name: "from.email",
            help_message: `domain ${domainOf(fromEmail)} is not validated in this project`,
            reason: "constraint",
          });
      }
      if (details.length > 0) throw invalidArguments(details);
      if (
        !scw.projects.findOneBy("project_id", projectId!) ||
        (key.project_ids && !key.project_ids.includes(projectId!))
      )
        throw permissionsDenied();
      const emails = createEmails(scw, {
        projectId: projectId!,
        region,
        from: { email: fromEmail!, name: str(fromRecord?.name) ?? null },
        to,
        cc,
        bcc,
        subject: subject!,
        text,
        html,
        attachments,
        additionalHeaders: headers,
        sendBefore: sendBefore ? new Date(Date.parse(sendBefore)).toISOString() : null,
      });
      return c.json({ emails: emails.map((email) => formatEmail(scw, email)) });
    }),
  );

  route(
    app,
    "get",
    "/emails",
    api(scw, (c, key) => {
      const query = queryOf(c);
      const since = parseDate(query.since, "since");
      const until = parseDate(query.until, "until");
      const statuses = allQuery(c, "statuses");
      for (const status of statuses)
        if (!EMAIL_STATUSES.includes(status as EmailStatus))
          throw invalidArguments([
            {
              argument_name: "statuses",
              help_message: `statuses must be one of ${EMAIL_STATUSES.join(", ")}`,
              reason: "constraint",
            },
          ]);
      const flags = allQuery(c, "flags");
      for (const flag of flags)
        if (!EMAIL_FLAGS.includes(flag as EmailFlag))
          throw invalidArguments([
            {
              argument_name: "flags",
              help_message: `flags must be one of ${EMAIL_FLAGS.join(", ")}`,
              reason: "constraint",
            },
          ]);
      const orderBy = query.order_by ?? "created_at_desc";
      const match = orderBy.match(/^(created_at|updated_at|status|mail_from|mail_rcpt|subject)_(asc|desc)$/);
      if (!match)
        throw invalidArguments([
          { argument_name: "order_by", help_message: "unsupported order_by value", reason: "constraint" },
        ]);
      const rows = scw.emails
        .all()
        .filter((email) => !key.project_ids || key.project_ids.includes(email.project_id))
        .filter((email) => {
          if (query.project_id && email.project_id !== query.project_id) return false;
          if (query.domain_id && email.domain_id !== query.domain_id) return false;
          if (query.message_id && email.message_id !== query.message_id) return false;
          if (query.mail_from && email.mail_from.toLowerCase() !== query.mail_from.toLowerCase()) return false;
          const rcpt = query.mail_rcpt ?? query.mail_to;
          if (rcpt && email.mail_rcpt.toLowerCase() !== rcpt.toLowerCase()) return false;
          if (query.subject && !email.subject.toLowerCase().includes(query.subject.toLowerCase())) return false;
          if (
            query.search &&
            !`${email.subject} ${email.mail_from} ${email.mail_rcpt} ${email.message_id}`
              .toLowerCase()
              .includes(query.search.toLowerCase())
          )
            return false;
          const created = Date.parse(email.created_at_iso);
          if (since !== undefined && created < since) return false;
          if (until !== undefined && created > until) return false;
          if (statuses.length > 0 && !statuses.includes(resolveEmail(email).status)) return false;
          if (flags.length > 0 && !flags.some((flag) => email.flags.includes(flag as EmailFlag))) return false;
          return true;
        })
        .map((email) => ({ email, view: formatEmail(scw, email) }))
        .sort((a, b) => {
          const field = match[1];
          const left = String(a.view[field] ?? "");
          const right = String(b.view[field] ?? "");
          const compare = left < right ? -1 : left > right ? 1 : a.email.id - b.email.id;
          return match[2] === "desc" ? -compare : compare;
        });
      const page = paginate(c, rows);
      return c.json({ total_count: page.total, emails: page.items.map((row) => row.view) });
    }),
  );

  route(
    app,
    "get",
    "/emails/:id",
    api(scw, (c) => c.json(formatEmail(scw, findEmail(c.req.param("id"))))),
  );

  route(
    app,
    "post",
    "/emails/:id/cancel",
    api(scw, (c) => {
      const email = findEmail(c.req.param("id"));
      const status = resolveEmail(email).status;
      if (status !== "new" && status !== "sending")
        throw preconditionFailed("email_status", `email in status ${status} cannot be canceled`);
      const updated = setEmailStatus(scw, email, "canceled", { details: "canceled by user" });
      return c.json(formatEmail(scw, updated));
    }),
  );

  route(
    app,
    "get",
    "/statistics",
    api(scw, (c, key) => {
      const query = queryOf(c);
      const since = parseDate(query.since, "since");
      const until = parseDate(query.until, "until");
      const rows = scw.emails.all().filter((email) => {
        if (key.project_ids && !key.project_ids.includes(email.project_id)) return false;
        if (query.project_id && email.project_id !== query.project_id) return false;
        if (query.domain_id && email.domain_id !== query.domain_id) return false;
        if (query.mail_from && email.mail_from.toLowerCase() !== query.mail_from.toLowerCase()) return false;
        const created = Date.parse(email.created_at_iso);
        if (since !== undefined && created < since) return false;
        if (until !== undefined && created > until) return false;
        return true;
      });
      const count = (status: EmailStatus) => rows.filter((email) => resolveEmail(email).status === status).length;
      return c.json({
        total_count: rows.length,
        new_count: count("new"),
        sending_count: count("sending"),
        sent_count: count("sent"),
        failed_count: count("failed"),
        canceled_count: count("canceled"),
      });
    }),
  );
}
