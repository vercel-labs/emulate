import { randomBytes } from "node:crypto";
import type { Context, ContentfulStatusCode, RouteContext } from "@emulators/core";
import type { TwilioSendGridAddress, TwilioSendGridApiKey } from "../entities.js";
import { constantTimeEqual } from "../helpers.js";
import { getTwilioStore } from "../store.js";

// SendGrid Mail Send (https://api.sendgrid.com/v3/mail/send). SendGrid is a
// Twilio product with its own host, Bearer API keys, and `errors` array format.
// Validation messages follow https://www.twilio.com/docs/sendgrid/api-reference/mail-send/errors.

export interface SendGridError {
  message: string;
  field: string | null;
  help: string | null;
}

const MAX_BODY_BYTES = 30 * 1024 * 1024;
const MAX_PERSONALIZATIONS = 1000;
const MAX_RECIPIENTS = 1000;
const MAX_REPLY_TO_LIST = 1000;
const MAX_CATEGORIES = 10;
const MAX_SUBSTITUTIONS = 550;
const MAX_SUBSTITUTION_BYTES = 100_000;
const MAX_SCHEDULE_SECONDS = 72 * 60 * 60;
const RESERVED_HEADERS = new Set([
  "x-sg-id",
  "x-sg-eid",
  "received",
  "dkim-signature",
  "content-type",
  "content-transfer-encoding",
  "to",
  "from",
  "subject",
  "reply-to",
  "cc",
  "bcc",
]);

const EXAMPLE_ADDRESS = `e.g. {"email": "example@example.com"} or {"email": "example@example.com", "name": "Example Recipient"}`;
const RECIPIENT_MESSAGE = `Each recipient object must at least have an email address and may also contain a name. ${EXAMPLE_ADDRESS}`;
const TO_MESSAGE = `Each to object must at least have an email address and may also contain a name. ${EXAMPLE_ADDRESS}`;
const FROM_REQUIRED_MESSAGE = `The from object must be provided for every email send. It is an object that requires the email parameter, but may also contain a name parameter. ${EXAMPLE_ADDRESS}`;
const FROM_INVALID_MESSAGE = `The from object must at least have an email parameter with a valid email address and may also contain a name parameter. ${EXAMPLE_ADDRESS}`;
const REPLY_TO_MESSAGE = `The reply_to object, when used, must at least have an email parameter with a valid email address and it may also contain a name parameter. ${EXAMPLE_ADDRESS}`;
const SEND_AT_MESSAGE =
  "The send_at parameter is expecting a UNIX timestamp as an integer. We will send immediately if you include a send_at timestamp that is in the past.";

// Settings whose documented type errors have fixed messages.
const MAIL_SETTING_CHECKS: Array<[string, "boolean" | "string", string]> = [
  ["bypass_list_management.enable", "boolean", "The bypass list management enable param should be a Boolean value."],
  ["bypass_spam_management.enable", "boolean", "The bypass spam management enable param should be a Boolean value."],
  [
    "bypass_bounce_management.enable",
    "boolean",
    "The bypass bounce management enable param should be a Boolean value.",
  ],
  [
    "bypass_unsubscribe_management.enable",
    "boolean",
    "The bypass unsubscribe management enable param should be a Boolean value.",
  ],
  ["footer.enable", "boolean", "The footer enable param should be a Boolean value."],
  ["footer.html", "string", "The text/html version of your footer should be a string."],
  ["footer.text", "string", "The text/plain version of your footer should be a string."],
  ["sandbox_mode.enable", "boolean", "The sandbox mode enable param should be a boolean value."],
];

const TRACKING_SETTING_CHECKS: Array<[string, "boolean" | "string", string]> = [
  ["click_tracking.enable", "boolean", "The click tracking enable param should be a boolean value."],
  ["click_tracking.enable_text", "boolean", "The click tracking enable text must be a boolean value."],
  ["open_tracking.enable", "boolean", "The open tracking enable param should be a boolean value."],
  ["open_tracking.substitution_tag", "string", "The open tracking substitution tag must be a string."],
  ["subscription_tracking.enable", "boolean", "The subscription tracking enable param should be a boolean value."],
  [
    "subscription_tracking.html",
    "string",
    "The subscription tracking unsubscribe content for text/html messages must be a string.",
  ],
  [
    "subscription_tracking.text",
    "string",
    "The subscription tracking unsubscribe content for text/plain messages must be a string.",
  ],
  [
    "subscription_tracking.substitution_tag",
    "string",
    "The subscription tracking substitution tag must be a string value.",
  ],
  ["ganalytics.enable", "boolean", "The Google Analytics enable param must be a boolean value."],
  ["ganalytics.utm_source", "string", "The Google Analytics utm_source must be a string value."],
  ["ganalytics.utm_medium", "string", "The Google Analytics utm_medium must be a string value."],
  ["ganalytics.utm_term", "string", "The Google Analytics utm_term must be a string value."],
  ["ganalytics.utm_content", "string", "The Google Analytics utm_content must be a string value."],
  ["ganalytics.utm_campaign", "string", "The Google Analytics utm_campaign must be a string value."],
];

export function sendgridError(c: Context, status: number, errors: SendGridError[]) {
  return c.json({ errors }, status as ContentfulStatusCode);
}

function singleError(message: string, field: string | null = null): SendGridError {
  return { message, field, help: null };
}

export function sendgridRoutes({ app, store }: RouteContext): void {
  const ts = () => getTwilioStore(store);

  app.post("/v3/mail/send", async (c) => {
    const key = authenticate(c, ts().sendgridApiKeys.all());
    if (key instanceof Response) return key;

    const raw = await c.req.text();
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
      return sendgridError(c, 413, [singleError("content too large")]);
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return sendgridError(c, 400, [singleError("invalid request")]);
    }
    if (!isRecord(body)) return sendgridError(c, 400, [singleError("invalid request")]);

    const errors = validateMailSend(body, Math.floor(Date.now() / 1000));
    if (errors.length > 0) return sendgridError(c, 400, errors);

    const mailSettings = isRecord(body.mail_settings) ? body.mail_settings : {};
    if (isRecord(mailSettings.sandbox_mode) && mailSettings.sandbox_mode.enable === true) {
      return c.body(null, 200);
    }

    const messageId = randomBytes(16).toString("base64url");
    const personalizations = body.personalizations as Array<Record<string, unknown>>;
    ts().sendgridMessages.insert({
      message_id: messageId,
      api_key_name: key.name,
      from: address(body.from),
      recipients: personalizations.flatMap((item) =>
        (["to", "cc", "bcc"] as const).flatMap((kind) =>
          Array.isArray(item[kind]) ? (item[kind] as unknown[]).map((entry) => address(entry).email) : [],
        ),
      ),
      subject: typeof body.subject === "string" ? body.subject : null,
      template_id: typeof body.template_id === "string" ? body.template_id : null,
      request: body,
    });
    return c.body(null, 202, { "X-Message-Id": messageId });
  });

  for (const method of ["GET", "PUT", "PATCH", "DELETE"] as const) {
    app.on(method, "/v3/mail/send", (c) => sendgridError(c, 405, [singleError("method not allowed")]));
  }
}

function authenticate(c: Context, keys: TwilioSendGridApiKey[]): TwilioSendGridApiKey | Response {
  const header = c.req.header("Authorization") ?? "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match) return sendgridError(c, 401, [singleError("authorization required")]);
  const key = keys.find((candidate) => constantTimeEqual(match[1], candidate.key));
  if (!key) {
    return sendgridError(c, 401, [singleError("The provided authorization grant is invalid, expired, or revoked")]);
  }
  if (key.scopes && !key.scopes.includes("mail.send")) {
    return sendgridError(c, 403, [singleError("access forbidden")]);
  }
  return key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function address(value: unknown): TwilioSendGridAddress {
  const record = value as Record<string, unknown>;
  const result: TwilioSendGridAddress = { email: String(record.email) };
  if (typeof record.name === "string") result.name = record.name;
  return result;
}

function isEmail(value: unknown): value is string {
  return typeof value === "string" && /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+\.[^\s@<>,;:"()[\]\\]+$/.test(value);
}

function isAddress(value: unknown, asciiOnly = false): boolean {
  if (!isRecord(value) || !isEmail(value.email)) return false;
  if (asciiOnly && !/^[\x20-\x7e]+$/.test(value.email)) return false;
  return value.name === undefined || typeof value.name === "string";
}

function isAscii(value: string): boolean {
  return /^[\x21-\x7e]+$/.test(value);
}

function isBase64(value: string): boolean {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

function getPath(record: Record<string, unknown>, path: string): unknown {
  let current: unknown = record;
  for (const part of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

export function validateMailSend(body: Record<string, unknown>, now: number): SendGridError[] {
  const errors: SendGridError[] = [];
  const add = (message: string, field: string | null) => errors.push(singleError(message, field));
  const usesTemplate = body.template_id !== undefined;

  if (body.from === undefined) add(FROM_REQUIRED_MESSAGE, "from");
  else if (!isAddress(body.from, true)) add(FROM_INVALID_MESSAGE, "from.email");

  validatePersonalizations(body, now, add);

  if (body.subject !== undefined && (typeof body.subject !== "string" || body.subject.length === 0)) {
    add("The subject of your email must be a string at least one character in length.", "subject");
  }

  if (body.reply_to !== undefined && body.reply_to_list !== undefined) {
    add("The reply_to and reply_to_list properties are mutually exclusive.", "reply_to_list");
  }
  if (body.reply_to !== undefined && !isAddress(body.reply_to)) add(REPLY_TO_MESSAGE, "reply_to");
  if (body.reply_to_list !== undefined) validateReplyToList(body.reply_to_list, add);

  if (body.content === undefined) {
    if (!usesTemplate) {
      add(
        "The content param is required unless you are using a transactional template and have defined a template_ID.",
        "content",
      );
    }
  } else {
    validateContent(body.content, add);
  }

  if (body.attachments !== undefined) validateAttachments(body.attachments, add);

  if (usesTemplate && typeof body.template_id !== "string") {
    add(`The template ID must be a string, you provided ${JSON.stringify(body.template_id)}.`, "template_id");
  }
  if (body.headers !== undefined) validateHeaders(body.headers, "headers", false, add);
  if (body.categories !== undefined) validateCategories(body.categories, add);
  if (body.custom_args !== undefined) validateCustomArgs(body.custom_args, "custom_args", add);
  if (body.send_at !== undefined) validateSendAt(body.send_at, "send_at", now, add);
  if (body.batch_id !== undefined && typeof body.batch_id !== "string") {
    add("The batch_id must be a string.", "batch_id");
  }
  if (body.ip_pool_name !== undefined && typeof body.ip_pool_name !== "string") {
    add("The name of your IP pool must be a string.", "ip_pool_name");
  }
  if (body.asm !== undefined) validateAsm(body.asm, add);
  validateSettings(body, "mail_settings", MAIL_SETTING_CHECKS, add);
  validateSettings(body, "tracking_settings", TRACKING_SETTING_CHECKS, add);

  return errors;
}

type AddError = (message: string, field: string | null) => void;

function validatePersonalizations(body: Record<string, unknown>, now: number, add: AddError): void {
  const personalizations = body.personalizations;
  if (!Array.isArray(personalizations) || personalizations.length === 0) {
    add("You must have at least one personalization.", "personalizations");
    return;
  }
  if (personalizations.length > MAX_PERSONALIZATIONS) {
    add(
      `The personalization block is limited to ${MAX_PERSONALIZATIONS} personalizations per API request. You have provided ${personalizations.length} personalizations. Please consider splitting this into multiple requests and resending your request.`,
      "personalizations",
    );
  }

  let recipientCount = 0;
  let everyPersonalizationHasSubject = true;
  personalizations.forEach((personalization, index) => {
    const base = `personalizations.${index}`;
    if (!isRecord(personalization)) {
      add("The to parameter is required for all personalization objects.", `${base}.to`);
      everyPersonalizationHasSubject = false;
      return;
    }

    const seen = new Set<string>();
    for (const kind of ["to", "cc", "bcc"] as const) {
      const list = personalization[kind];
      if (list === undefined) {
        if (kind === "to") add("The to parameter is required for all personalization objects.", `${base}.to`);
        continue;
      }
      if (!Array.isArray(list) || (kind === "to" && list.length === 0)) {
        add(
          kind === "to" ? "The to parameter is required for all personalization objects." : RECIPIENT_MESSAGE,
          `${base}.${kind}`,
        );
        continue;
      }
      list.forEach((entry, entryIndex) => {
        if (!isAddress(entry)) {
          add(kind === "to" ? TO_MESSAGE : RECIPIENT_MESSAGE, `${base}.${kind}.${entryIndex}.email`);
          return;
        }
        recipientCount++;
        const email = String((entry as Record<string, unknown>).email).toLowerCase();
        if (seen.has(email)) {
          add(
            `Each unique email address in the personalization block should only be included once. You have included ${email} more than once.`,
            `${base}.${kind}`,
          );
        }
        seen.add(email);
      });
    }

    if (personalization.from !== undefined && !isAddress(personalization.from, true)) {
      add(FROM_INVALID_MESSAGE, `${base}.from.email`);
    }
    if (personalization.subject === undefined) {
      everyPersonalizationHasSubject = false;
    } else if (typeof personalization.subject !== "string" || personalization.subject.length === 0) {
      add("The subject of your email must be a string at least one character in length.", `${base}.subject`);
    }
    if (personalization.headers !== undefined) validateHeaders(personalization.headers, `${base}.headers`, true, add);
    if (personalization.substitutions !== undefined) {
      validateSubstitutions(personalization.substitutions, `${base}.substitutions`, add);
    }
    if (personalization.custom_args !== undefined) {
      validateCustomArgs(personalization.custom_args, `${base}.custom_args`, add);
    }
    if (personalization.send_at !== undefined) validateSendAt(personalization.send_at, `${base}.send_at`, now, add);
  });

  if (recipientCount > MAX_RECIPIENTS) {
    add(`There is a limit of ${MAX_RECIPIENTS} total recipients (to + cc + bcc) per request.`, "personalizations");
  }
  if (body.subject === undefined && body.template_id === undefined && !everyPersonalizationHasSubject) {
    add(
      "The subject is required. You can get around this requirement if you use a template with a subject defined or if every personalization has a subject defined.",
      "subject",
    );
  }
}

function validateReplyToList(value: unknown, add: AddError): void {
  if (!Array.isArray(value) || value.length === 0) {
    add("The reply_to_list must be an array of at least one email object.", "reply_to_list");
    return;
  }
  if (value.length > MAX_REPLY_TO_LIST) {
    add(`There is a limit of ${MAX_REPLY_TO_LIST} reply_to_list emails per Mail Send request.`, "reply_to_list");
  }
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    if (!isAddress(entry)) {
      add(REPLY_TO_MESSAGE, `reply_to_list.${index}.email`);
      return;
    }
    const email = String((entry as Record<string, unknown>).email).toLowerCase();
    if (seen.has(email)) add(`Each email address in the reply_to_list should be unique.`, `reply_to_list.${index}`);
    seen.add(email);
  });
}

function validateContent(value: unknown, add: AddError): void {
  if (!Array.isArray(value) || value.length === 0) {
    add(
      "There must be at least one defined content block. We typically suggest both text/plain and text/html blocks are included, but only one block is required.",
      "content",
    );
    return;
  }
  const types: string[] = [];
  value.forEach((part, index) => {
    const base = `content.${index}`;
    const record = isRecord(part) ? part : {};
    if (record.type === undefined) {
      add("A content type is required, this tells email clients how to display the email.", `${base}.type`);
    } else if (typeof record.type !== "string" || record.type.length === 0) {
      add("Your content type must be a string with length of at least one character.", `${base}.type`);
    } else if (/[;\r\n]/.test(record.type)) {
      add("Cannot contain ';', or CRLF characters.", `${base}.type`);
    } else {
      types.push(record.type.toLowerCase());
    }
    if (record.value === undefined) {
      add("A content value is required, this is the content of the email you are sending.", `${base}.value`);
    } else if (typeof record.value !== "string" || record.value.length === 0) {
      add("The content value must be a string at least one character in length.", `${base}.value`);
    }
  });

  const plain = types.filter((type) => type === "text/plain").length;
  const html = types.filter((type) => type === "text/html").length;
  if (plain > 1 || html > 1) {
    add("If present, text/plain and text/html may only be provided once.", "content");
    return;
  }
  const expected = [...(plain ? ["text/plain"] : []), ...(html ? ["text/html"] : [])];
  if (expected.some((type, index) => types[index] !== type)) {
    add(
      "Following RFC 1341, section 7.2, if either text/html or text/plain are to be sent in your email: text/plain needs to be first, followed by text/html, followed by any other content.",
      "content",
    );
  }
}

function validateAttachments(value: unknown, add: AddError): void {
  if (!Array.isArray(value)) {
    add("The attachments must be an array of attachment objects.", "attachments");
    return;
  }
  value.forEach((attachment, index) => {
    const base = `attachments.${index}`;
    const record = isRecord(attachment) ? attachment : {};
    if (typeof record.content !== "string" || record.content.length === 0) {
      add("The attachment content must be a string at least one character in length.", `${base}.content`);
    } else if (!isBase64(record.content)) {
      add("The attachment content must be base64 encoded.", `${base}.content`);
    }
    if (record.filename === undefined) {
      add("filename is required.", `${base}.filename`);
    } else if (typeof record.filename !== "string") {
      add("The filename of your attachment must be a string.", `${base}.filename`);
    } else if (/[;,\r\n]/.test(record.filename)) {
      add("The filename of your attachment can't contain CRLF characters.", `${base}.filename`);
    }
    if (record.type !== undefined) {
      if (typeof record.type !== "string" || record.type.length === 0) {
        add("The attachment type must be a string and at least one character in length.", `${base}.type`);
      } else if (/[;,\r\n]/.test(record.type)) {
        add("The type can't contain ';', or CRLF characters.", `${base}.type`);
      }
    }
    if (record.disposition !== undefined && record.disposition !== "inline" && record.disposition !== "attachment") {
      add(
        `The disposition of your attachment can be either "inline" or "attachment". You provided ${JSON.stringify(record.disposition)}.`,
        `${base}.disposition`,
      );
    }
    if (record.content_id !== undefined) {
      if (typeof record.content_id !== "string") {
        add(
          `The content ID of your attachment must be a string. You provided ${JSON.stringify(record.content_id)}.`,
          `${base}.content_id`,
        );
      } else if (/[;\r\n]/.test(record.content_id)) {
        add("The content ID of your attachment can't contain CRLF characters.", `${base}.content_id`);
      }
    }
  });
}

function validateHeaders(value: unknown, field: string, personalization: boolean, add: AddError): void {
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== "string")) {
    add(
      personalization ? "All values of the headers object must be strings." : "The header values must be strings.",
      field,
    );
    return;
  }
  const seen = new Set<string>();
  for (const name of Object.keys(value)) {
    const lower = name.toLowerCase();
    if (!isAscii(name)) {
      add(
        personalization
          ? "Header keys can't contain non-ASCII characters or empty spaces."
          : "Header keys can't contain non-ASCII characters and empty spaces.",
        field,
      );
    } else if (RESERVED_HEADERS.has(lower)) {
      add(
        personalization ? "Header can't be one of the reserved keys." : "Header can not be one of the reserved keys.",
        `${field}.${name}`,
      );
    } else if (seen.has(lower)) {
      add("The headers can't contain duplicate keys.", `${field}.${name}`);
    }
    seen.add(lower);
  }
}

function validateSubstitutions(value: unknown, field: string, add: AddError): void {
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== "string")) {
    add("The substitution values must be an object of key/value pairs, where the values are all strings.", field);
    return;
  }
  if (Object.keys(value).length > MAX_SUBSTITUTIONS) {
    add(`Substitutions are limited to ${MAX_SUBSTITUTIONS} items per personalization block.`, field);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_SUBSTITUTION_BYTES) {
    add("Substitutions are limited to 100,000 bytes per personalization block.", field);
  }
}

function validateCustomArgs(value: unknown, field: string, add: AddError): void {
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== "string")) {
    add("All values of custom arguments object must be strings", field);
  } else if (Object.keys(value).length === 0) {
    add("custom_args can't be empty.", field);
  }
}

function validateSendAt(value: unknown, field: string, now: number, add: AddError): void {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    add(SEND_AT_MESSAGE, field);
  } else if (value > now + MAX_SCHEDULE_SECONDS) {
    add("Scheduling more than 72 hours in advance is forbidden.", field);
  }
}

function validateCategories(value: unknown, add: AddError): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    add("Categories must be an array of strings.", "categories");
    return;
  }
  if (value.length > MAX_CATEGORIES) {
    add(
      `There is a limit of ${MAX_CATEGORIES} categories for each email that is sent. You provided ${value.length} categories.`,
      "categories",
    );
  }
  const seen = new Set<string>();
  for (const category of value as string[]) {
    if (category.length > 255) {
      add(`Each category must not be longer than 255 characters. ${category} exceeds this limit.`, "categories");
    }
    if (!/^[\x00-\x7f]*$/.test(category)) add("Categories can not contain non-ASCII characters.", "categories");
    if (seen.has(category)) {
      add(`The categories must be a unique list, and you have included ${category} more than once.`, "categories");
    }
    seen.add(category);
  }
}

function validateAsm(value: unknown, add: AddError): void {
  const record = isRecord(value) ? value : {};
  if (typeof record.group_id !== "number" || !Number.isInteger(record.group_id)) {
    add("The ASM group ID must be an integer.", "asm.group_id");
  }
  const display = record.groups_to_display;
  if (display === undefined) return;
  if (!Array.isArray(display) || display.some((item) => typeof item !== "number" || !Number.isInteger(item))) {
    add("The ASM Group IDs to display must be an array of integers.", "asm.groups_to_display");
  } else if (display.length > 25) {
    add(
      "There is a limit of 25 unsubscribe groups that can be displayed to a user at a time.",
      "asm.groups_to_display",
    );
  }
}

function validateSettings(
  body: Record<string, unknown>,
  name: "mail_settings" | "tracking_settings",
  checks: Array<[string, "boolean" | "string", string]>,
  add: AddError,
): void {
  const settings = body[name];
  if (settings === undefined) return;
  if (!isRecord(settings)) {
    add(`The ${name} must be an object.`, name);
    return;
  }
  for (const [path, type, message] of checks) {
    const value = getPath(settings, path);
    if (value !== undefined && typeof value !== type) add(message, `${name}.${path}`);
  }
}
