import type {
  MailgunCredential,
  MailgunDomain,
  MailgunEvent,
  MailgunList,
  MailgunMember,
  MailgunMessage,
  MailgunRoute,
  MailgunSuppression,
  MailgunTag,
  MailgunTemplate,
  MailgunTemplateVersion,
  MailgunWebhook,
  WebhookType,
} from "./entities.js";
import { epochSeconds, extractEmail, rfc2822 } from "./helpers.js";
import { accountId, type MailgunStore } from "./store.js";

type Json = Record<string, unknown>;

export interface Fmt {
  ms: MailgunStore;
  baseUrl: string;
}

export const WEBHOOK_TYPES: WebhookType[] = [
  "accepted",
  "delivered",
  "opened",
  "clicked",
  "unsubscribed",
  "complained",
  "permanent_fail",
  "temporary_fail",
];

export function formatDomain(d: MailgunDomain, includePassword = false): Json {
  return {
    id: `dom_${d.id}`,
    name: d.name,
    created_at: rfc2822(d.created_at),
    smtp_login: `postmaster@${d.name}`,
    ...(includePassword ? { smtp_password: d.smtp_password } : {}),
    spam_action: d.spam_action,
    state: d.state,
    type: d.type,
    wildcard: d.wildcard,
    web_prefix: d.web_prefix,
    web_scheme: d.web_scheme,
    is_disabled: d.is_disabled,
    require_tls: d.require_tls,
    skip_verification: d.skip_verification,
    use_automatic_sender_security: false,
    dkim_key_size: d.dkim_key_size,
    tracking: {
      open: { active: d.tracking.open },
      click: { active: d.tracking.click },
      unsubscribe: { active: d.tracking.unsubscribe, html_footer: "", text_footer: "" },
    },
  };
}

export function sendingDnsRecords(d: MailgunDomain): Json[] {
  return [
    { record_type: "TXT", valid: "valid", cached: [], name: d.name, value: "v=spf1 include:mailgun.org ~all" },
    {
      record_type: "TXT",
      valid: "valid",
      cached: [],
      name: `mailo._domainkey.${d.name}`,
      value: "k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDEmulate",
    },
    { record_type: "CNAME", valid: "valid", cached: [], name: `${d.web_prefix}.${d.name}`, value: "mailgun.org" },
  ];
}

export function receivingDnsRecords(): Json[] {
  return [
    { priority: "10", record_type: "MX", valid: "valid", cached: [], value: "mxa.mailgun.org" },
    { priority: "10", record_type: "MX", valid: "valid", cached: [], value: "mxb.mailgun.org" },
  ];
}

export function formatDomainResponse(d: MailgunDomain, includePassword = false): Json {
  return {
    domain: formatDomain(d, includePassword),
    receiving_dns_records: receivingDnsRecords(),
    sending_dns_records: sendingDnsRecords(d),
  };
}

export function storageUrl(f: Fmt, message: MailgunMessage): string {
  return `${f.baseUrl}/v3/domains/${message.domain}/messages/${message.key}`;
}

export function formatEvent(f: Fmt, e: MailgunEvent): Json {
  const message = e.message_key ? f.ms.messages.findOneBy("key", e.message_key) : undefined;
  const base: Json = {
    event: e.event,
    id: e.event_id,
    timestamp: e.timestamp,
    "log-level": e.log_level,
    method: "HTTP",
    recipient: e.recipient,
    "recipient-domain": e.recipient.split("@")[1] ?? "",
    "user-variables": e.user_variables,
    tags: e.tags,
    campaigns: [],
    message: {
      headers: { to: e.to, "message-id": e.message_id.replace(/^<|>$/g, ""), from: e.from, subject: e.subject },
      attachments:
        message?.attachments.map((attachment) => ({
          filename: attachment.name,
          "content-type": attachment.content_type,
          size: attachment.size,
        })) ?? [],
      size: e.size,
    },
    envelope: {
      transport: "smtp",
      sender: message ? `postmaster@${message.domain}` : `postmaster@${e.domain}`,
      targets: e.recipient,
      "sending-ip": "127.0.0.1",
    },
    flags: {
      "is-routed": false,
      "is-authenticated": true,
      "is-system-test": false,
      "is-test-mode": e.test_mode,
    },
    ...(message ? { storage: { url: storageUrl(f, message), key: message.key, region: "us", env: "emulate" } } : {}),
  };
  if (e.event === "accepted" || e.event === "delivered" || e.event === "failed" || e.event === "rejected") {
    base["delivery-status"] = {
      "attempt-no": 1,
      message: e.description ?? "",
      code: e.code ?? (e.event === "delivered" ? 250 : e.event === "accepted" ? 0 : 550),
      description: e.description ?? "",
      "session-seconds": 0.12,
      tls: true,
      "mx-host": e.event === "delivered" ? `mx.${e.recipient.split("@")[1] ?? "example.com"}` : "",
      "certificate-verified": true,
      utf8: true,
      "enhanced-code": e.event === "failed" ? "5.1.1" : "",
      "retry-seconds": e.severity === "temporary" ? 600 : 0,
    };
  }
  if (e.severity) base.severity = e.severity;
  if (e.reason) base.reason = e.reason;
  if (e.event === "rejected") base.reject = { reason: e.reason ?? "", description: e.description ?? "" };
  if (e.url) base.url = e.url;
  if (e.ip) base.ip = e.ip;
  if (e.client_info) base["client-info"] = e.client_info;
  if (e.event === "opened" || e.event === "clicked" || e.event === "unsubscribed" || e.event === "complained") {
    base.geolocation = { country: "FR", region: "IDF", city: "Paris" };
  }
  return base;
}

export function formatLogItem(f: Fmt, e: MailgunEvent): Json {
  const event = formatEvent(f, e);
  return {
    id: e.event_id,
    event: e.event,
    "@timestamp": new Date(e.timestamp * 1000).toISOString(),
    account: { id: accountId(f.ms) },
    domain: { name: e.domain },
    recipient: e.recipient,
    "recipient-domain": e.recipient.split("@")[1] ?? "",
    "recipient-provider": e.recipient.split("@")[1] ?? "",
    message: event.message,
    envelope: event.envelope,
    flags: event.flags,
    tags: e.tags,
    "user-variables": e.user_variables,
    "log-level": e.log_level,
    method: "HTTP",
    ...(event["delivery-status"] ? { "delivery-status": event["delivery-status"] } : {}),
    ...(event.storage ? { storage: event.storage } : {}),
    ...(e.severity ? { severity: e.severity } : {}),
    ...(e.reason ? { reason: e.reason } : {}),
    ...(e.url ? { url: e.url } : {}),
  };
}

export function messageHeaders(message: MailgunMessage): Array<[string, string]> {
  const headers: Array<[string, string]> = [
    ["Received", `by mail.emulate.local with HTTP; ${rfc2822(message.created_at)}`],
    ["Content-Type", message.html ? 'multipart/alternative; boundary="emulate"' : 'text/plain; charset="utf-8"'],
    ["Mime-Version", "1.0"],
    ["Subject", message.subject],
    ["From", message.from],
    ["To", message.to.join(", ")],
    ["Message-Id", message.message_id],
    ["Date", rfc2822(message.created_at)],
  ];
  if (message.cc.length > 0) headers.push(["Cc", message.cc.join(", ")]);
  if (Object.keys(message.variables).length > 0)
    headers.push(["X-Mailgun-Variables", JSON.stringify(message.variables)]);
  if (message.tags.length > 0) headers.push(["X-Mailgun-Tag", message.tags.join(", ")]);
  for (const [key, value] of Object.entries(message.headers)) headers.push([key, value]);
  return headers;
}

export function formatStoredMessage(f: Fmt, message: MailgunMessage): Json {
  const text = message.text ?? (message.html ? message.html.replace(/<[^>]+>/g, "") : "");
  return {
    Received: `by mail.emulate.local with HTTP; ${rfc2822(message.created_at)}`,
    "Content-Type": message.html ? 'multipart/alternative; boundary="emulate"' : 'text/plain; charset="utf-8"',
    "Mime-Version": "1.0",
    Subject: message.subject,
    From: message.from,
    To: message.to.join(", "),
    ...(message.cc.length > 0 ? { Cc: message.cc.join(", ") } : {}),
    "Message-Id": message.message_id,
    Date: rfc2822(message.created_at),
    sender: extractEmail(message.from),
    recipients: message.recipients.join(", "),
    from: message.from,
    subject: message.subject,
    "body-plain": text,
    "stripped-text": text,
    "stripped-signature": "",
    "body-html": message.html ?? "",
    "stripped-html": message.html ?? "",
    "message-headers": messageHeaders(message),
    "X-Mailgun-Variables": JSON.stringify(message.variables),
    "X-Mailgun-Tag": message.tags,
    attachments: message.attachments.map((attachment, index) => ({
      url: `${f.baseUrl}/v3/domains/${message.domain}/messages/${message.key}/attachments/${index}`,
      "content-type": attachment.content_type,
      name: attachment.name,
      size: attachment.size,
    })),
    "content-id-map": {},
    storage: { url: storageUrl(f, message), key: message.key },
  };
}

export function formatList(f: Fmt, list: MailgunList): Json {
  return {
    address: list.address,
    name: list.name,
    description: list.description,
    access_level: list.access_level,
    reply_preference: list.reply_preference,
    created_at: rfc2822(list.created_at),
    members_count: f.ms.members.count((member) => member.list_address === list.address),
  };
}

export function formatMember(member: MailgunMember): Json {
  return {
    address: member.address,
    name: member.name,
    subscribed: member.subscribed,
    vars: member.vars,
  };
}

export function formatTemplateVersion(v: MailgunTemplateVersion, includeContent = true): Json {
  return {
    tag: v.tag,
    engine: v.engine,
    createdAt: rfc2822(v.created_at),
    comment: v.comment,
    active: v.active,
    id: v.version_id,
    ...(includeContent ? { template: v.content, headers: v.headers } : {}),
  };
}

export function formatTemplate(
  f: Fmt,
  t: MailgunTemplate,
  version?: MailgunTemplateVersion | null,
  includeContent = true,
): Json {
  return {
    name: t.name,
    description: t.description,
    createdAt: rfc2822(t.created_at),
    createdBy: t.created_by,
    id: `tmpl_${t.id}`,
    ...(version ? { version: formatTemplateVersion(version, includeContent) } : {}),
  };
}

export function formatTag(t: MailgunTag): Json {
  return {
    tag: t.tag,
    description: t.description,
    "first-seen": t.first_seen,
    "last-seen": t.last_seen,
  };
}

export function formatRoute(r: MailgunRoute): Json {
  return {
    id: r.route_id,
    priority: r.priority,
    description: r.description,
    expression: r.expression,
    actions: r.actions,
    created_at: rfc2822(r.created_at),
  };
}

export function formatSuppression(s: MailgunSuppression): Json {
  switch (s.kind) {
    case "bounce":
      return { address: s.address, code: s.code ?? "550", error: s.error ?? "", created_at: rfc2822(s.created_at) };
    case "unsubscribe":
      return { address: s.address, tags: s.tags.length > 0 ? s.tags : ["*"], created_at: rfc2822(s.created_at) };
    case "complaint":
      return { address: s.address, created_at: rfc2822(s.created_at) };
    case "whitelist":
      return { value: s.address, reason: s.reason ?? "", type: s.type, createdAt: rfc2822(s.created_at) };
  }
}

export function formatCredential(c: MailgunCredential): Json {
  return {
    created_at: rfc2822(c.created_at),
    login: c.login,
    mailbox: c.login,
    size_bytes: 0,
  };
}

export function formatWebhooks(webhooks: MailgunWebhook[]): Json {
  const result: Json = {};
  for (const webhook of webhooks) result[webhook.type] = { urls: webhook.urls };
  return result;
}

export function eventSeconds(e: MailgunEvent): number {
  return e.timestamp || epochSeconds(e.created_at);
}
