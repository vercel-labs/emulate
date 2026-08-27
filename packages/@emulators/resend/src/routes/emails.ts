import type { AppEnv, ContentfulStatusCode, Context, RouteContext } from "@emulators/core";
import { getResendStore, type ResendStore } from "../store.js";
import { generateUuid, resendError, resendList, parseResendBody } from "../helpers.js";
import type { ResendEmail } from "../entities.js";
import {
  canonicalizeEmailPayload,
  completeIdempotencyRecord,
  CONCURRENT_IDEMPOTENT_REQUESTS_MESSAGE,
  idempotencyLookupDigest,
  INVALID_IDEMPOTENCY_KEY_MESSAGE,
  INVALID_IDEMPOTENT_REQUEST_MESSAGE,
  isValidIdempotencyKey,
  readIdempotencyKey,
  releaseIdempotencyRecord,
  requestFingerprint,
  reserveIdempotencyRecord,
} from "../idempotency.js";

type EmailInput = Record<string, unknown>;
type IdempotencyStart = { kind: "continue"; recordId: number | null } | { kind: "response"; response: Response };

export function emailRoutes(ctx: RouteContext): void {
  const { app, store, webhooks } = ctx;
  const rs = () => getResendStore(store);

  app.post("/emails/batch", async (c) => {
    const keyError = validateIdempotencyKey(c);
    if (keyError) return keyError;

    let emails: EmailInput[];
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

    // Validate the whole operation before reserving its key or inserting any rows.
    for (const emailData of emails) {
      const validation = validateEmail(c, emailData);
      if (validation) return validation;
    }

    const currentStore = rs();
    const idempotency = beginIdempotency(c, currentStore, "/emails/batch", emails.map(canonicalizeEmailPayload));
    if (idempotency.kind === "response") return idempotency.response;

    return executeSend(c, currentStore, idempotency.recordId, async (insertedEmailIds) => {
      const results: Array<{ id: string }> = [];

      for (const emailData of emails) {
        const email = insertEmail(currentStore, emailData);
        insertedEmailIds.push(email.id);
        await dispatchEmailWebhooks(email);
        results.push({ id: email.uuid });
      }

      return { data: results };
    });
  });

  app.post("/emails", async (c) => {
    const keyError = validateIdempotencyKey(c);
    if (keyError) return keyError;

    const body = await parseResendBody(c);

    const validation = validateEmail(c, body);
    if (validation) return validation;

    const currentStore = rs();
    const idempotency = beginIdempotency(c, currentStore, "/emails", canonicalizeEmailPayload(body));
    if (idempotency.kind === "response") return idempotency.response;

    return executeSend(c, currentStore, idempotency.recordId, async (insertedEmailIds) => {
      const email = insertEmail(currentStore, body);
      insertedEmailIds.push(email.id);
      await dispatchEmailWebhooks(email);
      return { id: email.uuid };
    });
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

  async function dispatchEmailWebhooks(email: ResendEmail): Promise<void> {
    if (email.scheduled_at) return;

    const data = {
      email_id: email.uuid,
      to: email.to,
      from: email.from,
      subject: email.subject,
    };
    await webhooks.dispatch("email.sent", undefined, { type: "email.sent", data }, "resend");
    await webhooks.dispatch("email.delivered", undefined, { type: "email.delivered", data }, "resend");
  }
}

function validateIdempotencyKey(c: Context<AppEnv>): Response | undefined {
  const header = readIdempotencyKey(c);
  if (header.present && !isValidIdempotencyKey(header.key)) {
    return resendError(c, 400, "invalid_idempotency_key", INVALID_IDEMPOTENCY_KEY_MESSAGE);
  }
  return undefined;
}

function validateEmail(c: Context<AppEnv>, emailData: EmailInput): Response | undefined {
  if (!emailData || typeof emailData !== "object" || Array.isArray(emailData)) {
    return resendError(c, 422, "validation_error", "Missing required field: from");
  }
  if (!emailData.from) return resendError(c, 422, "validation_error", "Missing required field: from");
  if (!emailData.to) return resendError(c, 422, "validation_error", "Missing required field: to");
  if (!emailData.subject) return resendError(c, 422, "validation_error", "Missing required field: subject");
  return undefined;
}

function beginIdempotency(
  c: Context<AppEnv>,
  rs: ResendStore,
  endpoint: "/emails" | "/emails/batch",
  canonicalPayload: unknown,
): IdempotencyStart {
  const header = readIdempotencyKey(c);
  if (!header.present) return { kind: "continue", recordId: null };

  const decision = reserveIdempotencyRecord(
    rs.idempotencyRecords,
    idempotencyLookupDigest(c, "POST", endpoint, header.key),
    requestFingerprint(canonicalPayload),
  );

  if (decision.kind === "replay") {
    return {
      kind: "response",
      response: c.json(decision.body, decision.status as ContentfulStatusCode),
    };
  }
  if (decision.kind === "payload_conflict") {
    return {
      kind: "response",
      response: resendError(c, 409, "invalid_idempotent_request", INVALID_IDEMPOTENT_REQUEST_MESSAGE),
    };
  }
  if (decision.kind === "concurrent") {
    return {
      kind: "response",
      response: resendError(c, 409, "concurrent_idempotent_requests", CONCURRENT_IDEMPOTENT_REQUESTS_MESSAGE),
    };
  }

  return { kind: "continue", recordId: decision.record.id };
}

async function executeSend<T extends Record<string, unknown>>(
  c: Context<AppEnv>,
  rs: ResendStore,
  idempotencyRecordId: number | null,
  operation: (insertedEmailIds: number[]) => Promise<T>,
): Promise<Response> {
  const insertedEmailIds: number[] = [];
  try {
    const responseBody = await operation(insertedEmailIds);
    const response = c.json(responseBody, 200);
    if (idempotencyRecordId !== null) {
      completeIdempotencyRecord(rs.idempotencyRecords, idempotencyRecordId, 200, responseBody);
    }
    return response;
  } catch (error) {
    for (const emailId of insertedEmailIds.reverse()) rs.emails.delete(emailId);
    if (idempotencyRecordId !== null) releaseIdempotencyRecord(rs.idempotencyRecords, idempotencyRecordId);
    throw error;
  }
}

function insertEmail(rs: ResendStore, emailData: EmailInput): ResendEmail {
  const from = emailData.from as string;
  const to = emailData.to as string | string[];
  const subject = emailData.subject as string;
  const toArray = Array.isArray(to) ? to : [to];
  const scheduledAt = emailData.scheduled_at as string | undefined;
  const status = scheduledAt ? ("scheduled" as const) : ("delivered" as const);

  return rs.emails.insert({
    uuid: generateUuid(),
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
}

function normalizeStringArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return [value];
  return [];
}

function formatEmail(email: ResendEmail) {
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
