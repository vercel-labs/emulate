import type { Context, RouteContext, Store } from "@emulators/core";
import type { ExpoPushFault, ExpoPushReceipt, ExpoPushTicket } from "../entities.js";
import {
  MAX_PAYLOAD_BYTES,
  MAX_RECEIPT_IDS,
  MAX_RECIPIENTS_PER_REQUEST,
  errorMessage,
  isExpoPushToken,
  isPlainObject,
  readJsonBody,
  requestError,
  seededUuid,
  validateMessage,
} from "../helpers.js";
import { decideFault } from "../rules.js";
import { getConfig, getExpoPushStore, nextIdOrdinal } from "../store.js";

interface Recipient {
  token: string;
  message: Record<string, unknown>;
}

interface Decision {
  ticket: ExpoPushTicket;
  receipt: ExpoPushReceipt | null;
}

function checkAccess(c: Context, store: Store): Response | null {
  const required = getConfig(store).accessToken;
  if (required === null) return null;
  const given = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (given === required) return null;
  return requestError(
    c,
    401,
    "UNAUTHORIZED",
    "An access token is required to send push notifications for this project.",
  );
}

/** Splits each message into one record per recipient, keeping the request order. */
function expand(messages: Array<Record<string, unknown>>): Recipient[] {
  const out: Recipient[] = [];
  for (const message of messages) {
    const to = message.to as string | string[];
    for (const token of Array.isArray(to) ? to : [to]) out.push({ token, message: { ...message, to: token } });
  }
  return out;
}

function payloadBytes(message: Record<string, unknown>): number {
  const { to: _to, ...payload } = message;
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

export function pushRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const es = () => getExpoPushStore(store);

  function recordRequest(path: string, status: number, recipients: number, errorCode: string | null): number {
    return es().requests.insert({ path, status, recipients, error_code: errorCode }).id;
  }

  function reject(c: Context, status: number, code: string, message: string, recipients = 0, details?: unknown) {
    recordRequest(new URL(c.req.url).pathname, status, recipients, code);
    return requestError(c, status, code, message, details);
  }

  app.post("/--/api/v2/push/send", async (c) => {
    const denied = checkAccess(c, store);
    if (denied) return denied;

    const body = await readJsonBody(c);
    if (!body.ok) return reject(c, 400, "VALIDATION_ERROR", body.message);
    const list = Array.isArray(body.value) ? body.value : [body.value];
    if (list.length === 0) return reject(c, 400, "VALIDATION_ERROR", "Request body must not be an empty array");
    for (const message of list) {
      const violation = validateMessage(message);
      if (violation) return reject(c, 400, "VALIDATION_ERROR", violation);
    }

    const recipients = expand(list as Array<Record<string, unknown>>);
    if (recipients.length > MAX_RECIPIENTS_PER_REQUEST) {
      return reject(
        c,
        400,
        "PUSH_TOO_MANY_NOTIFICATIONS",
        `You are trying to send ${recipients.length} push notifications in one request. Send ${MAX_RECIPIENTS_PER_REQUEST} or fewer.`,
        recipients.length,
      );
    }

    const projects = new Map<string, string[]>();
    for (const { token } of recipients) {
      const project = es().devices.findOneBy("token", token)?.project;
      if (project) projects.set(project, [...(projects.get(project) ?? []), token]);
    }
    if (projects.size > 1) {
      return reject(
        c,
        400,
        "PUSH_TOO_MANY_EXPERIENCE_IDS",
        "You are trying to send push notifications to different Expo experiences. Send each project in its own request.",
        recipients.length,
        Object.fromEntries(projects),
      );
    }

    const config = getConfig(store);
    const decisions: Decision[] = [];
    for (const { token, message } of recipients) {
      let ticketError: ExpoPushFault | null = null;
      if (!isExpoPushToken(token)) ticketError = { at: "ticket", error: "DeviceNotRegistered" };
      else if (payloadBytes(message) > MAX_PAYLOAD_BYTES) ticketError = { at: "ticket", error: "MessageTooBig" };

      const fault = ticketError ?? decideFault(store, config, { token, message });
      if (fault?.at === "request") {
        return reject(
          c,
          fault.status ?? 429,
          fault.code ?? "TOO_MANY_REQUESTS",
          fault.message ?? "You are exceeding the request limit for this project. Retry with exponential backoff.",
          recipients.length,
        );
      }
      if (fault?.at === "ticket") {
        decisions.push({
          ticket: {
            status: "error",
            message: fault.message ?? errorMessage(fault.error, token, "ticket"),
            details: { error: fault.error },
          },
          receipt: null,
        });
        continue;
      }
      const id = seededUuid(config.seed, nextIdOrdinal(store));
      let receipt: ExpoPushReceipt = { status: "ok" };
      if (fault?.at === "receipt") {
        receipt = {
          status: "error",
          message: fault.message ?? errorMessage(fault.error, token, "receipt"),
          details: { error: fault.error },
        };
      } else if (es().devices.findOneBy("token", token)?.registered === false) {
        receipt = {
          status: "error",
          message: errorMessage("DeviceNotRegistered", token, "receipt"),
          details: { error: "DeviceNotRegistered" },
        };
      }
      decisions.push({ ticket: { status: "ok", id }, receipt });
    }

    const requestId = recordRequest(new URL(c.req.url).pathname, 200, recipients.length, null);
    recipients.forEach(({ token, message }, index) => {
      const { ticket, receipt } = decisions[index];
      es().messages.insert({ request_id: requestId, index, token, message, ticket, receipt });
    });
    return c.json({ data: decisions.map((d) => d.ticket) }, 200);
  });

  app.post("/--/api/v2/push/getReceipts", async (c) => {
    const denied = checkAccess(c, store);
    if (denied) return denied;

    const body = await readJsonBody(c);
    if (!body.ok) return reject(c, 400, "VALIDATION_ERROR", body.message);
    const ids = isPlainObject(body.value) ? body.value.ids : undefined;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
      return reject(c, 400, "VALIDATION_ERROR", `"ids" must be an array of strings`);
    }
    if (ids.length > MAX_RECEIPT_IDS) {
      return reject(
        c,
        400,
        "PUSH_TOO_MANY_RECEIPTS",
        `You are trying to get ${ids.length} push receipts in one request. Ask for ${MAX_RECEIPT_IDS} or fewer.`,
      );
    }

    const wanted = new Set(ids as string[]);
    const data: Record<string, ExpoPushReceipt> = {};
    for (const record of es().messages.all()) {
      if (record.ticket.status === "ok" && record.receipt && wanted.has(record.ticket.id)) {
        data[record.ticket.id] = record.receipt;
      }
    }
    recordRequest(new URL(c.req.url).pathname, 200, wanted.size, null);
    return c.json({ data }, 200);
  });
}
