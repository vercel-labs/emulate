import type { EventType, MailgunAttachment, MailgunDomain, MailgunEvent, MailgunMessage } from "./entities.js";
import {
  all,
  badRequest,
  displayName,
  domainOf,
  emailValid,
  extractEmail,
  first,
  parseJson,
  parseTime,
  splitAddresses,
  yesNo,
  type ParsedBody,
} from "./helpers.js";
import { eventId, messageId, storageKey } from "./ids.js";
import { type MailgunStore } from "./store.js";
import { deliverEventWebhooks, type MailgunCtx } from "./webhooks.js";

export interface SendInput {
  domain: MailgunDomain;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string | null;
  html: string | null;
  ampHtml: string | null;
  headers: Record<string, string>;
  variables: Record<string, unknown>;
  recipientVariables: Record<string, Record<string, unknown>> | null;
  tags: string[];
  template: string | null;
  templateVersion: string | null;
  testMode: boolean;
  deliveryTime: number | null;
  attachments: MailgunAttachment[];
  rawMime: string | null;
  direction: "outbound" | "inbound";
}

const MAX_TAGS = 10;
const MAX_RECIPIENTS = 1000;

export function parseSendBody(body: ParsedBody, domain: MailgunDomain): SendInput {
  const from = first(body, "from");
  if (!from) throw badRequest("'from' parameter is missing");
  const toValues = all(body, "to").flatMap(splitAddresses);
  if (toValues.length === 0) throw badRequest("'to' parameter is missing");
  for (const address of toValues) {
    if (!emailValid(extractEmail(address)))
      throw badRequest(`'to' parameter is not a valid address. please check documentation`);
  }
  const text = first(body, "text") ?? null;
  const html = first(body, "html") ?? null;
  const template = first(body, "template") ?? null;
  if (text === null && html === null && template === null && !first(body, "amp-html")) {
    throw badRequest("Need at least one of 'text' or 'html' parameters specified");
  }
  const headers: Record<string, string> = {};
  const variables: Record<string, unknown> = {};
  for (const [key, values] of Object.entries(body.fields)) {
    if (key.startsWith("h:")) headers[key.slice(2)] = values[values.length - 1];
    if (key.startsWith("v:")) variables[key.slice(2)] = values[values.length - 1];
  }
  if (headers["X-Mailgun-Variables"]) {
    Object.assign(variables, parseJson<Record<string, unknown>>(headers["X-Mailgun-Variables"]) ?? {});
    delete headers["X-Mailgun-Variables"];
  }
  const templateVariables = parseJson<Record<string, unknown>>(
    first(body, "t:variables") ?? first(body, "h:X-Mailgun-Template-Variables"),
  );
  if (templateVariables) Object.assign(variables, templateVariables);
  const tags = [
    ...new Set(
      all(body, "o:tag").flatMap((value) =>
        value
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    ),
  ];
  if (tags.length > MAX_TAGS) throw badRequest("Too many tags specified. Max: 10");
  const recipientVariablesRaw = first(body, "recipient-variables");
  const recipientVariables = recipientVariablesRaw
    ? parseJson<Record<string, Record<string, unknown>>>(recipientVariablesRaw)
    : undefined;
  if (recipientVariablesRaw && recipientVariables === undefined)
    throw badRequest("'recipient-variables' parameter is not a valid JSON");
  const deliveryTimeRaw = first(body, "o:deliverytime");
  const deliveryTime = deliveryTimeRaw ? parseTime(deliveryTimeRaw) : undefined;
  if (deliveryTimeRaw && deliveryTime === undefined)
    throw badRequest("'o:deliverytime' parameter is not a valid RFC 2822 date");
  const attachments: MailgunAttachment[] = [
    ...(body.files.attachment ?? []).map((file) => ({
      name: file.name,
      content_type: file.type,
      size: file.content.length,
      content: file.content.toString("base64"),
      inline: false,
    })),
    ...(body.files.inline ?? []).map((file) => ({
      name: file.name,
      content_type: file.type,
      size: file.content.length,
      content: file.content.toString("base64"),
      inline: true,
    })),
  ];
  return {
    domain,
    from,
    to: toValues,
    cc: all(body, "cc").flatMap(splitAddresses),
    bcc: all(body, "bcc").flatMap(splitAddresses),
    subject: first(body, "subject") ?? "",
    text,
    html,
    ampHtml: first(body, "amp-html") ?? null,
    headers,
    variables,
    recipientVariables: recipientVariables ?? null,
    tags,
    template,
    templateVersion: first(body, "t:version") ?? null,
    testMode: yesNo(first(body, "o:testmode"), false),
    deliveryTime: deliveryTime ?? null,
    attachments,
    rawMime: null,
    direction: "outbound",
  };
}

export function parseMimeBody(body: ParsedBody, domain: MailgunDomain): SendInput {
  const toValues = all(body, "to").flatMap(splitAddresses);
  if (toValues.length === 0) throw badRequest("'to' parameter is missing");
  const file = body.files.message?.[0];
  const raw = file ? file.content.toString("utf8") : first(body, "message");
  if (!raw) throw badRequest("'message' parameter is missing");
  const [headerPart, ...bodyParts] = raw.split(/\r?\n\r?\n/);
  const headers: Record<string, string> = {};
  for (const line of headerPart.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  const bodyText = bodyParts.join("\n\n");
  const isHtml = (headers["Content-Type"] ?? "").toLowerCase().includes("text/html");
  const from = headers.From ?? `postmaster@${domain.name}`;
  const custom: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers))
    if (key.startsWith("X-") && key !== "X-Mailgun-Variables") custom[key] = value;
  return {
    domain,
    from,
    to: toValues,
    cc: headers.Cc ? splitAddresses(headers.Cc) : [],
    bcc: [],
    subject: headers.Subject ?? "",
    text: isHtml ? null : bodyText,
    html: isHtml ? bodyText : null,
    ampHtml: null,
    headers: custom,
    variables: parseJson<Record<string, unknown>>(headers["X-Mailgun-Variables"]) ?? {},
    recipientVariables: null,
    tags: headers["X-Mailgun-Tag"] ? headers["X-Mailgun-Tag"].split(",").map((tag) => tag.trim()) : [],
    template: null,
    templateVersion: null,
    testMode: yesNo(first(body, "o:testmode"), false),
    deliveryTime: null,
    attachments: [],
    rawMime: raw,
    direction: "outbound",
  };
}

function lookupPath(vars: Record<string, unknown>, path: string): unknown {
  let current: unknown = vars;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function renderTemplate(content: string, vars: Record<string, unknown>): string {
  let output = content.replace(
    /\{\{#if\s+([a-zA-Z0-9_.]+)\s*\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g,
    (_match, path: string, truthy: string, falsy: string | undefined) => {
      const value = lookupPath(vars, path);
      return value ? truthy : (falsy ?? "");
    },
  );
  output = output.replace(
    /\{\{#each\s+([a-zA-Z0-9_.]+)\s*\}\}([\s\S]*?)\{\{\/each\}\}/g,
    (_match, path: string, block: string) => {
      const value = lookupPath(vars, path);
      if (!Array.isArray(value)) return "";
      return value
        .map((item) =>
          block
            .replace(/\{\{\s*this\s*\}\}/g, String(item))
            .replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (inner, innerPath: string) => {
              const resolved =
                item && typeof item === "object" ? lookupPath(item as Record<string, unknown>, innerPath) : undefined;
              return resolved === undefined ? inner : String(resolved);
            }),
        )
        .join("");
    },
  );
  return output
    .replace(/\{\{\{?\s*([a-zA-Z0-9_.]+)\s*\}?\}\}/g, (match, path: string) => {
      const value = lookupPath(vars, path);
      if (value === undefined || value === null) return "";
      return typeof value === "object" ? JSON.stringify(value) : String(value);
    })
    .replace(/\{\{[^}]*\}\}/g, (match) => (match.includes("this") ? "" : match));
}

export function substituteRecipientVariables(text: string, vars: Record<string, unknown>): string {
  return text.replace(/%recipient\.([a-zA-Z0-9_.]+)%/g, (match, path: string) => {
    const value = lookupPath(vars, path);
    return value === undefined || value === null ? match : String(value);
  });
}

export function expandRecipients(
  ms: MailgunStore,
  addresses: string[],
): Array<{ address: string; vars: Record<string, unknown> }> {
  const result: Array<{ address: string; vars: Record<string, unknown> }> = [];
  const seen = new Set<string>();
  for (const raw of addresses) {
    const email = extractEmail(raw);
    const list = ms.lists.findOneBy("address", email);
    if (list) {
      for (const member of ms.members.findBy("list_address", list.address)) {
        if (!member.subscribed || seen.has(member.address)) continue;
        seen.add(member.address);
        result.push({ address: member.address, vars: { name: member.name, ...member.vars } });
      }
      continue;
    }
    if (seen.has(email)) continue;
    seen.add(email);
    result.push({ address: email, vars: { name: displayName(raw) ?? "" } });
  }
  return result;
}

export function isSuppressed(
  ms: MailgunStore,
  domain: string,
  address: string,
): { kind: "bounce" | "unsubscribe" | "complaint" } | null {
  const suppressions = ms.suppressions.findBy("domain", domain);
  const lowered = address.toLowerCase();
  const whitelisted = suppressions.some(
    (item) =>
      item.kind === "whitelist" &&
      (item.type === "domain"
        ? lowered.endsWith(`@${item.address.toLowerCase()}`)
        : item.address.toLowerCase() === lowered),
  );
  if (whitelisted) return null;
  for (const kind of ["bounce", "unsubscribe", "complaint"] as const) {
    if (suppressions.some((item) => item.kind === kind && item.address.toLowerCase() === lowered)) return { kind };
  }
  return null;
}

export interface EventInput {
  event: EventType;
  domain: string;
  recipient: string;
  message: MailgunMessage | null;
  severity?: "permanent" | "temporary" | null;
  reason?: string | null;
  code?: number | null;
  description?: string | null;
  url?: string | null;
  ip?: string | null;
  clientInfo?: Record<string, string> | null;
  timestamp?: number;
  deliverWebhooks?: boolean;
}

export async function recordEvent(ctx: MailgunCtx, input: EventInput): Promise<MailgunEvent> {
  const { ms } = ctx;
  const message = input.message;
  const now = input.timestamp ?? Date.now() / 1000;
  const event = ms.events.insert({
    event_id: eventId(),
    event: input.event,
    timestamp: Math.round(now * 1000) / 1000,
    domain: input.domain,
    recipient: input.recipient.toLowerCase(),
    message_key: message?.key ?? null,
    message_id: message?.message_id ?? "",
    from: message?.from ?? "",
    to: message?.to.join(", ") ?? input.recipient,
    subject: message?.subject ?? "",
    tags: message?.tags ?? [],
    severity: input.severity ?? null,
    reason: input.reason ?? null,
    code: input.code ?? null,
    description: input.description ?? null,
    log_level:
      input.event === "failed" || input.event === "rejected"
        ? input.severity === "temporary"
          ? "warn"
          : "error"
        : input.event === "complained"
          ? "warn"
          : "info",
    user_variables: message?.variables ?? {},
    url: input.url ?? null,
    ip: input.ip ?? null,
    client_info: input.clientInfo ?? null,
    test_mode: message?.test_mode ?? false,
    size: message?.size ?? 0,
  });
  for (const tag of event.tags) {
    const existing = ms.tags.findBy("domain", event.domain).find((candidate) => candidate.tag === tag);
    const seen = new Date(event.timestamp * 1000).toUTCString();
    if (existing) ms.tags.update(existing.id, { last_seen: seen });
    else ms.tags.insert({ domain: event.domain, tag, description: "", first_seen: seen, last_seen: seen });
  }
  if (input.deliverWebhooks !== false) await deliverEventWebhooks(ctx, event);
  return event;
}

export interface SendResult {
  message: MailgunMessage;
  accepted: string[];
  rejected: Array<{ address: string; reason: string }>;
}

export async function sendMessage(ctx: MailgunCtx, input: SendInput): Promise<SendResult> {
  const { ms } = ctx;
  const domain = input.domain;
  if (domain.is_disabled || domain.state === "disabled") throw badRequest("Domain is disabled");
  const recipients = expandRecipients(ms, [...input.to, ...input.cc, ...input.bcc]);
  if (recipients.length === 0) throw badRequest("'to' parameter is missing");
  if (recipients.length > MAX_RECIPIENTS) throw badRequest("Too many recipients specified. Max: 1000");
  if (domain.type === "sandbox") {
    const authorized = new Set(domain.authorized_recipients.map((address) => address.toLowerCase()));
    const unauthorized = recipients.find((recipient) => !authorized.has(recipient.address));
    if (unauthorized) {
      throw badRequest(
        "Sandbox subdomains are for test purposes only. Please add your own domain or add the address to authorized recipients in Account Settings.",
      );
    }
  }

  let text = input.text;
  let html = input.html;
  if (input.template) {
    const template = ms.templates.findBy("domain", domain.name).find((candidate) => candidate.name === input.template);
    if (!template) throw badRequest(`template '${input.template}' not found`);
    const versions = ms.templateVersions
      .findBy("domain", domain.name)
      .filter((candidate) => candidate.template_name === template.name);
    const version = input.templateVersion
      ? versions.find((candidate) => candidate.tag === input.templateVersion)
      : (versions.find((candidate) => candidate.active) ?? versions[0]);
    if (!version)
      throw badRequest(
        `template '${input.template}' has no ${input.templateVersion ? `version '${input.templateVersion}'` : "active version"}`,
      );
    const rendered = renderTemplate(version.content, input.variables);
    if (/<[a-z][\s\S]*>/i.test(rendered)) html = rendered;
    else text = rendered;
    for (const [key, value] of Object.entries(version.headers)) {
      if (key.toLowerCase() === "subject" && !input.subject) input.subject = renderTemplate(value, input.variables);
    }
  }

  const size =
    Buffer.byteLength(`${input.subject}${text ?? ""}${html ?? ""}${JSON.stringify(input.headers)}`) +
    input.attachments.reduce((sum, item) => sum + item.size, 0) +
    512;
  const message = ms.messages.insert({
    key: storageKey(),
    message_id: messageId(domain.name),
    domain: domain.name,
    from: input.from,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    recipients: recipients.map((recipient) => recipient.address),
    subject: input.subject,
    text,
    html,
    amp_html: input.ampHtml,
    headers: input.headers,
    variables: input.variables,
    recipient_variables: input.recipientVariables,
    tags: input.tags,
    template: input.template,
    test_mode: input.testMode,
    scheduled_for: input.deliveryTime,
    attachments: input.attachments,
    size,
    direction: input.direction,
    raw_mime: input.rawMime,
  });

  const accepted: string[] = [];
  const rejected: Array<{ address: string; reason: string }> = [];
  for (const recipient of recipients) {
    const address = recipient.address;
    const local = address.split("@")[0].toLowerCase();
    if (!emailValid(address)) {
      rejected.push({ address, reason: "invalid" });
      await recordEvent(ctx, {
        event: "rejected",
        domain: domain.name,
        recipient: address,
        message,
        reason: "invalid",
        description: "Not a valid email address",
      });
      continue;
    }
    await recordEvent(ctx, {
      event: "accepted",
      domain: domain.name,
      recipient: address,
      message,
      code: 0,
      description: "",
    });
    accepted.push(address);
    if (input.testMode) continue;
    const suppressed = isSuppressed(ms, domain.name, address);
    if (suppressed) {
      await recordEvent(ctx, {
        event: "failed",
        domain: domain.name,
        recipient: address,
        message,
        severity: "permanent",
        reason: `suppress-${suppressed.kind}`,
        code: 605,
        description: `Not delivering to previously ${suppressed.kind === "bounce" ? "bounced" : suppressed.kind === "unsubscribe" ? "unsubscribed" : "complained"} address ${address}`,
      });
      continue;
    }
    if (local === "bounce" || local.startsWith("bounce+") || domainOf(address) === "bounce.test") {
      await recordEvent(ctx, {
        event: "failed",
        domain: domain.name,
        recipient: address,
        message,
        severity: "permanent",
        reason: "bounce",
        code: 550,
        description: `5.1.1 The email account that you tried to reach does not exist: ${address}`,
      });
      if (
        !ms.suppressions
          .findBy("domain", domain.name)
          .some((item) => item.kind === "bounce" && item.address === address)
      ) {
        ms.suppressions.insert({
          domain: domain.name,
          kind: "bounce",
          address,
          code: "550",
          error: `5.1.1 The email account that you tried to reach does not exist: ${address}`,
          tags: [],
          reason: null,
          type: "address",
        });
      }
      continue;
    }
    if (local === "fail" || local === "temp-fail" || local.startsWith("fail+")) {
      await recordEvent(ctx, {
        event: "failed",
        domain: domain.name,
        recipient: address,
        message,
        severity: "temporary",
        reason: "generic",
        code: 452,
        description: "4.2.2 The recipient's inbox is out of storage space. Please retry later.",
      });
      continue;
    }
    await recordEvent(ctx, {
      event: "delivered",
      domain: domain.name,
      recipient: address,
      message,
      code: 250,
      description: "OK",
    });
    if (local === "complaint" || local.startsWith("complaint+")) {
      await recordEvent(ctx, { event: "complained", domain: domain.name, recipient: address, message });
      if (
        !ms.suppressions
          .findBy("domain", domain.name)
          .some((item) => item.kind === "complaint" && item.address === address)
      ) {
        ms.suppressions.insert({
          domain: domain.name,
          kind: "complaint",
          address,
          code: null,
          error: null,
          tags: [],
          reason: null,
          type: "address",
        });
      }
    }
  }
  return { message, accepted, rejected };
}

export function personalize(
  message: MailgunMessage,
  recipient: string,
): { subject: string; text: string | null; html: string | null } {
  const vars = message.recipient_variables?.[recipient] ?? message.recipient_variables?.[recipient.toLowerCase()] ?? {};
  return {
    subject: substituteRecipientVariables(message.subject, vars),
    text: message.text === null ? null : substituteRecipientVariables(message.text, vars),
    html: message.html === null ? null : substituteRecipientVariables(message.html, vars),
  };
}
