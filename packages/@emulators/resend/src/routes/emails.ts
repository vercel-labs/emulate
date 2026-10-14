import type { RouteContext, Store } from "@emulators/core";
import { ALLOWLIST_DATA_KEY, getResendStore } from "../store.js";
import { generateUuid, resendError, resendList, parseResendBody } from "../helpers.js";
import type { ResendEmail } from "../entities.js";

const IDEMPOTENCY_KEY_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_KEY_MAX_LENGTH = 256;
type EmailEndpoint = "emails" | "emails/batch";

interface NormalizedEmailInput {
  from: string;
  to: string[];
  subject: string;
  html: string | null;
  text: string | null;
  cc: string[];
  bcc: string[];
  reply_to: string[];
  headers: Record<string, string>;
  tags: Array<{ name: string; value: string }>;
  scheduled_at: string | null;
}

interface PreparedEmail {
  uuid: string;
  input: NormalizedEmailInput;
  scheduled: boolean;
}

export function emailRoutes(ctx: RouteContext): void {
  const { app, store, webhooks } = ctx;
  const rs = () => getResendStore(store);

  app.post("/emails/batch", async (c) => {
    const idempotencyKey = c.req.header("Idempotency-Key");
    if (idempotencyKey !== undefined && !isValidIdempotencyKey(idempotencyKey)) {
      return invalidIdempotencyKey(c);
    }

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

    const normalizedEmails = emails.map(normalizeEmailInput);
    const fingerprint = requestFingerprint(normalizedEmails);
    const replay =
      idempotencyKey !== undefined
        ? findIdempotencyReplay(c, rs(), idempotencyKey, "emails/batch", fingerprint)
        : undefined;
    if (replay?.status === 200) return replay;

    for (const input of normalizedEmails) recordSendAttempt(rs(), input, idempotencyKey);
    if (replay) return replay;
    const denied = rejectAllowlist(c, store, normalizedEmails);
    if (denied) return denied;

    if (idempotencyKey === undefined) {
      const results: Array<{ id: string }> = [];
      for (const input of normalizedEmails) {
        const prepared = prepareEmail(input);
        insertPreparedEmail(rs().emails, prepared);
        await dispatchPreparedEmail(webhooks, prepared);
        results.push({ id: prepared.uuid });
      }
      return c.json({ data: results }, 200);
    }

    const preparedEmails = normalizedEmails.map(prepareEmail);
    for (const prepared of preparedEmails) {
      insertPreparedEmail(rs().emails, prepared);
    }

    const response = { data: preparedEmails.map(({ uuid }) => ({ id: uuid })) };
    cacheIdempotencyRecord(
      rs().idempotencyKeys,
      idempotencyKey,
      "emails/batch",
      fingerprint,
      response.data.map((r) => r.id),
    );

    for (const prepared of preparedEmails) {
      await dispatchPreparedEmail(webhooks, prepared);
    }

    return c.json(response, 200);
  });

  app.post("/emails", async (c) => {
    const idempotencyKey = c.req.header("Idempotency-Key");
    if (idempotencyKey !== undefined && !isValidIdempotencyKey(idempotencyKey)) {
      return invalidIdempotencyKey(c);
    }

    const body = await parseResendBody(c);
    const from = body.from as string | undefined;
    const to = body.to as string | string[] | undefined;
    const subject = body.subject as string | undefined;

    if (!from) return resendError(c, 422, "validation_error", "Missing required field: from");
    if (!to) return resendError(c, 422, "validation_error", "Missing required field: to");
    if (!subject) return resendError(c, 422, "validation_error", "Missing required field: subject");

    const normalizedInput = normalizeEmailInput(body);
    const fingerprint = requestFingerprint(normalizedInput);
    const replay =
      idempotencyKey !== undefined ? findIdempotencyReplay(c, rs(), idempotencyKey, "emails", fingerprint) : undefined;
    if (replay?.status === 200) return replay;

    recordSendAttempt(rs(), normalizedInput, idempotencyKey);
    if (replay) return replay;
    const denied = rejectAllowlist(c, store, [normalizedInput]);
    if (denied) return denied;

    const prepared = prepareEmail(normalizedInput);
    insertPreparedEmail(rs().emails, prepared);

    const response = { id: prepared.uuid };
    if (idempotencyKey !== undefined) {
      cacheIdempotencyRecord(rs().idempotencyKeys, idempotencyKey, "emails", fingerprint, [prepared.uuid]);
    }

    await dispatchPreparedEmail(webhooks, prepared);

    return c.json(response, 200);
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

function recordSendAttempt(
  resendStore: ReturnType<typeof getResendStore>,
  input: NormalizedEmailInput,
  idempotencyKey: string | undefined,
): void {
  resendStore.sendAttempts.insert({
    to: input.to,
    from: input.from,
    subject: input.subject,
    idempotency_key: idempotencyKey ?? null,
  });
}

function rejectAllowlist(
  c: Parameters<typeof resendError>[0],
  store: Store,
  inputs: NormalizedEmailInput[],
): Response | undefined {
  const allowlist = store.getData<string[]>(ALLOWLIST_DATA_KEY);
  if (!allowlist) return undefined;

  const rejected = [
    ...new Set(
      inputs
        .flatMap((input) => [...input.to, ...input.cc, ...input.bcc])
        .filter((address) => !allowlist.includes(address)),
    ),
  ];
  if (!rejected.length) return undefined;

  return resendError(
    c,
    403,
    "validation_error",
    `${rejected.join(", ")} is not in the allowlist: ${allowlist.join(", ")}.`,
  );
}

function isValidIdempotencyKey(key: string): boolean {
  return key.length >= 1 && key.length <= IDEMPOTENCY_KEY_MAX_LENGTH;
}

function invalidIdempotencyKey(c: Parameters<typeof resendError>[0]) {
  return resendError(c, 400, "invalid_idempotency_key", "Idempotency-Key must be between 1 and 256 characters");
}

function requestFingerprint(payload: unknown): string {
  return stableStringify(payload);
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(",")}}`;
}

function findIdempotencyReplay(
  c: Parameters<typeof resendError>[0],
  resendStore: ReturnType<typeof getResendStore>,
  key: string,
  endpoint: EmailEndpoint,
  fingerprint: string,
): Response | undefined {
  pruneExpiredIdempotencyRecords(resendStore);

  const record = resendStore.idempotencyKeys.findOneBy("idempotency_key", key);
  if (!record) return undefined;

  if (record.endpoint !== endpoint || record.request_fingerprint !== fingerprint) {
    return resendError(c, 409, "invalid_idempotent_request", "The idempotency key was used with a different request");
  }

  if (endpoint === "emails") {
    return c.json({ id: record.response_email_ids[0] }, 200);
  }

  return c.json({ data: record.response_email_ids.map((id) => ({ id })) }, 200);
}

function pruneExpiredIdempotencyRecords(resendStore: ReturnType<typeof getResendStore>): void {
  const cutoff = Date.now() - IDEMPOTENCY_KEY_TTL_MS;
  for (const record of resendStore.idempotencyKeys.all()) {
    if (Date.parse(record.created_at) < cutoff) {
      resendStore.idempotencyKeys.delete(record.id);
    }
  }
}

function cacheIdempotencyRecord(
  idempotencyKeys: ReturnType<typeof getResendStore>["idempotencyKeys"],
  key: string,
  endpoint: EmailEndpoint,
  fingerprint: string,
  responseEmailIds: string[],
): void {
  idempotencyKeys.insert({
    idempotency_key: key,
    endpoint,
    request_fingerprint: fingerprint,
    response_email_ids: responseEmailIds,
  });
}

function normalizeEmailInput(emailData: Record<string, unknown>): NormalizedEmailInput {
  const to = emailData.to as string | string[];
  return {
    from: emailData.from as string,
    to: Array.isArray(to) ? to : [to],
    subject: emailData.subject as string,
    html: (emailData.html as string) ?? null,
    text: (emailData.text as string) ?? null,
    cc: normalizeStringArray(emailData.cc),
    bcc: normalizeStringArray(emailData.bcc),
    reply_to: normalizeStringArray(emailData.reply_to),
    headers: (emailData.headers as Record<string, string>) ?? {},
    tags: (emailData.tags as Array<{ name: string; value: string }>) ?? [],
    scheduled_at: (emailData.scheduled_at as string) ?? null,
  };
}

function prepareEmail(input: NormalizedEmailInput): PreparedEmail {
  return {
    uuid: generateUuid(),
    input,
    scheduled: Boolean(input.scheduled_at),
  };
}

function insertPreparedEmail(emails: ReturnType<typeof getResendStore>["emails"], prepared: PreparedEmail): void {
  const status = prepared.scheduled ? ("scheduled" as const) : ("delivered" as const);
  emails.insert({
    uuid: prepared.uuid,
    ...prepared.input,
    status,
    last_event: prepared.scheduled ? "email.scheduled" : "email.delivered",
  });
}

async function dispatchPreparedEmail(webhooks: RouteContext["webhooks"], prepared: PreparedEmail): Promise<void> {
  if (prepared.scheduled) return;

  const { uuid, input } = prepared;
  await webhooks.dispatch(
    "email.sent",
    undefined,
    { type: "email.sent", data: { email_id: uuid, to: input.to, from: input.from, subject: input.subject } },
    "resend",
  );
  await webhooks.dispatch(
    "email.delivered",
    undefined,
    { type: "email.delivered", data: { email_id: uuid, to: input.to, from: input.from, subject: input.subject } },
    "resend",
  );
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
