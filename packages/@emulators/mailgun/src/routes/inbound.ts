import type { EventType, MailgunMessage, MailgunRoute } from "../entities.js";
import { formatEvent, formatRoute, messageHeaders } from "../formatters.js";
import {
  api,
  all,
  badRequest,
  emailValid,
  extractEmail,
  first,
  limitParam,
  notFound,
  parseBody,
  parseJson,
  route,
  skipParam,
  type ParsedBody,
} from "../helpers.js";
import { messageId, routeId, storageKey } from "../ids.js";
import { recordEvent, sendMessage } from "../sending.js";
import { postForm, signature } from "../webhooks.js";
import type { MailgunRouteContext } from "../route-utils.js";

interface InboundMail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string | null;
  headers: Record<string, string>;
}

function matchesExpression(expression: string, mail: InboundMail): boolean {
  const clauses = expression.split(/\s+and\s+/i).map((clause) => clause.trim());
  return clauses.every((clause) => {
    if (/^catch_all\(\s*\)$/i.test(clause)) return true;
    const recipient = clause.match(/^match_recipient\(\s*["'](.+)["']\s*\)$/i);
    if (recipient) {
      try {
        return new RegExp(recipient[1], "i").test(extractEmail(mail.to));
      } catch {
        return false;
      }
    }
    const header = clause.match(/^match_header\(\s*["']([^"']+)["']\s*,\s*["'](.+)["']\s*\)$/i);
    if (header) {
      const value =
        header[1].toLowerCase() === "subject"
          ? mail.subject
          : header[1].toLowerCase() === "from"
            ? mail.from
            : (mail.headers[header[1]] ?? mail.headers[header[1].toLowerCase()] ?? "");
      try {
        return new RegExp(header[2], "i").test(value);
      } catch {
        return false;
      }
    }
    return false;
  });
}

function validateExpression(expression: string): void {
  const clauses = expression.split(/\s+and\s+/i).map((clause) => clause.trim());
  for (const clause of clauses) {
    if (/^catch_all\(\s*\)$/i.test(clause)) continue;
    if (/^match_recipient\(\s*["'].+["']\s*\)$/i.test(clause)) continue;
    if (/^match_header\(\s*["'][^"']+["']\s*,\s*["'].+["']\s*\)$/i.test(clause)) continue;
    throw badRequest(`'expression' parameter is invalid: unsupported filter ${clause}`);
  }
}

function validateActions(actions: string[]): void {
  if (actions.length === 0) throw badRequest("'action' parameter is missing");
  for (const action of actions) {
    if (/^forward\(\s*["'].+["']\s*\)$/i.test(action)) continue;
    if (/^store\(\s*(notify\s*=\s*["'].+["'])?\s*\)$/i.test(action)) continue;
    if (/^stop\(\s*\)$/i.test(action)) continue;
    throw badRequest(`'action' parameter is invalid: unsupported action ${action}`);
  }
}

export function inboundRoutes(rc: MailgunRouteContext): void {
  const { app, ms, ctx, fmt, baseUrl } = rc;
  const sortedRoutes = () => [...ms.routes.all()].sort((a, b) => a.priority - b.priority || a.id - b.id);

  route(
    app,
    "get",
    "/v3/routes",
    api(ms, (c) => {
      const routes = sortedRoutes();
      const limit = limitParam(c, 100);
      const skip = skipParam(c);
      return c.json({ items: routes.slice(skip, skip + limit).map(formatRoute), total_count: routes.length });
    }),
  );

  route(
    app,
    "post",
    "/v3/routes",
    api(ms, async (c) => {
      const body = await parseBody(c);
      const expression = first(body, "expression");
      if (!expression) throw badRequest("'expression' parameter is missing");
      validateExpression(expression);
      const actions = all(body, "action");
      validateActions(actions);
      const created = ms.routes.insert({
        route_id: routeId(),
        priority: Number(first(body, "priority") ?? 0),
        description: first(body, "description") ?? "",
        expression,
        actions,
      });
      return c.json({ message: "Route has been created", route: formatRoute(created) });
    }),
  );

  route(
    app,
    "get",
    "/v3/routes/match",
    api(ms, (c) => {
      const address = c.req.query("address");
      if (!address) throw badRequest("'address' parameter is missing");
      const matched = sortedRoutes().find((candidate) =>
        matchesExpression(candidate.expression, {
          from: "",
          to: address,
          subject: "",
          text: "",
          html: null,
          headers: {},
        }),
      );
      if (!matched) throw notFound("No route matches the address");
      return c.json({ route: formatRoute(matched) });
    }),
  );

  function findRoute(id: string): MailgunRoute {
    const found = ms.routes.findOneBy("route_id", id);
    if (!found) throw notFound("Route not found");
    return found;
  }

  route(
    app,
    "get",
    "/v3/routes/:id",
    api(ms, (c) => c.json({ route: formatRoute(findRoute(c.req.param("id"))) })),
  );

  route(
    app,
    "put",
    "/v3/routes/:id",
    api(ms, async (c) => {
      const existing = findRoute(c.req.param("id"));
      const body = await parseBody(c);
      const expression = first(body, "expression") ?? existing.expression;
      validateExpression(expression);
      const actions = all(body, "action");
      if (actions.length > 0) validateActions(actions);
      const updated = ms.routes.update(existing.id, {
        priority: first(body, "priority") !== undefined ? Number(first(body, "priority")) : existing.priority,
        description: first(body, "description") ?? existing.description,
        expression,
        actions: actions.length > 0 ? actions : existing.actions,
      })!;
      return c.json({ message: "Route has been updated", ...formatRoute(updated) });
    }),
  );

  route(
    app,
    "delete",
    "/v3/routes/:id",
    api(ms, (c) => {
      const existing = findRoute(c.req.param("id"));
      ms.routes.delete(existing.id);
      return c.json({ message: "Route has been deleted", id: existing.route_id });
    }),
  );

  function inboundFields(mail: InboundMail, message: MailgunMessage, includeStorage: boolean): Record<string, string> {
    const sig = signature(ms);
    const fields: Record<string, string> = {
      recipient: extractEmail(mail.to),
      sender: extractEmail(mail.from),
      from: mail.from,
      To: mail.to,
      From: mail.from,
      subject: mail.subject,
      Subject: mail.subject,
      "body-plain": mail.text,
      "stripped-text": mail.text,
      "stripped-signature": "",
      "body-html": mail.html ?? "",
      "stripped-html": mail.html ?? "",
      "attachment-count": "0",
      timestamp: sig.timestamp,
      token: sig.token,
      signature: sig.signature,
      "message-headers": JSON.stringify(messageHeaders(message)),
      "Message-Id": message.message_id,
      Date: new Date(message.created_at).toUTCString(),
      "content-id-map": "{}",
      "X-Envelope-From": `<${extractEmail(mail.from)}>`,
    };
    for (const [key, value] of Object.entries(mail.headers)) fields[key] = value;
    if (includeStorage) {
      fields["message-url"] = `${baseUrl}/v3/domains/${message.domain}/messages/${message.key}`;
    }
    return fields;
  }

  function parseInbound(body: ParsedBody): InboundMail {
    const from = first(body, "from") ?? first(body, "sender");
    const to = first(body, "to") ?? first(body, "recipient");
    if (!from) throw badRequest("'from' parameter is missing");
    if (!to || !emailValid(extractEmail(to))) throw badRequest("'to' parameter is missing or invalid");
    const headers = parseJson<Record<string, string>>(first(body, "headers")) ?? {};
    for (const [key, values] of Object.entries(body.fields))
      if (key.startsWith("h:")) headers[key.slice(2)] = values[values.length - 1];
    return {
      from,
      to,
      subject: first(body, "subject") ?? "",
      text: first(body, "text") ?? first(body, "body-plain") ?? "",
      html: first(body, "html") ?? first(body, "body-html") ?? null,
      headers,
    };
  }

  route(
    app,
    "post",
    "/_mailgun/simulate/inbound",
    api(ms, async (c) => {
      const body = await parseBody(c);
      const mail = parseInbound(body);
      const recipientDomain = extractEmail(mail.to).split("@")[1] ?? "";
      const domain =
        ms.domains.findOneBy("name", recipientDomain) ??
        ms.domains.all().find((candidate) => candidate.type === "custom") ??
        ms.domains.all()[0];
      if (!domain) throw badRequest("No domain is configured");
      const message = ms.messages.insert({
        key: storageKey(),
        message_id: messageId(domain.name),
        domain: domain.name,
        from: mail.from,
        to: [mail.to],
        cc: [],
        bcc: [],
        recipients: [extractEmail(mail.to)],
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        amp_html: null,
        headers: mail.headers,
        variables: {},
        recipient_variables: null,
        tags: [],
        template: null,
        test_mode: false,
        scheduled_for: null,
        attachments: [],
        size: Buffer.byteLength(`${mail.subject}${mail.text}${mail.html ?? ""}`) + 512,
        direction: "inbound",
        raw_mime: null,
      });
      const matched: Array<Record<string, unknown>> = [];
      let stopped = false;
      for (const candidate of sortedRoutes()) {
        if (stopped) break;
        if (!matchesExpression(candidate.expression, mail)) continue;
        const deliveries: Array<Record<string, unknown>> = [];
        for (const action of candidate.actions) {
          const forward = action.match(/^forward\(\s*["'](.+)["']\s*\)$/i);
          const store = action.match(/^store\(\s*(?:notify\s*=\s*["'](.+)["'])?\s*\)$/i);
          if (forward) {
            const target = forward[1];
            if (/^https?:\/\//i.test(target)) {
              const result = await postForm(target, inboundFields(mail, message, false));
              ms.routeDeliveries.insert({
                route_id: candidate.route_id,
                action,
                url: target,
                status_code: result.status,
                success: result.ok,
                error: result.error,
                recipient: extractEmail(mail.to),
                message_key: message.key,
              });
              deliveries.push({
                action,
                url: target,
                status_code: result.status,
                success: result.ok,
                error: result.error,
              });
            } else {
              const result = await sendMessage(ctx, {
                domain,
                from: mail.from,
                to: [target],
                cc: [],
                bcc: [],
                subject: mail.subject,
                text: mail.text,
                html: mail.html,
                ampHtml: null,
                headers: { "X-Mailgun-Forwarded-For": extractEmail(mail.to) },
                variables: {},
                recipientVariables: null,
                tags: [],
                template: null,
                templateVersion: null,
                testMode: false,
                deliveryTime: null,
                attachments: [],
                rawMime: null,
                direction: "outbound",
              });
              deliveries.push({ action, forwarded_message_id: result.message.message_id, success: true });
            }
          } else if (store) {
            await recordEvent(ctx, { event: "stored", domain: domain.name, recipient: extractEmail(mail.to), message });
            if (store[1]) {
              const result = await postForm(store[1], inboundFields(mail, message, true));
              ms.routeDeliveries.insert({
                route_id: candidate.route_id,
                action,
                url: store[1],
                status_code: result.status,
                success: result.ok,
                error: result.error,
                recipient: extractEmail(mail.to),
                message_key: message.key,
              });
              deliveries.push({
                action,
                url: store[1],
                status_code: result.status,
                success: result.ok,
                error: result.error,
              });
            } else {
              deliveries.push({ action, success: true });
            }
          } else if (/^stop\(\s*\)$/i.test(action)) {
            stopped = true;
            deliveries.push({ action, success: true });
          }
        }
        matched.push({ route: formatRoute(candidate), deliveries });
      }
      return c.json(
        {
          message: {
            key: message.key,
            "message-id": message.message_id,
            storage_url: `${baseUrl}/v3/domains/${domain.name}/messages/${message.key}`,
          },
          matched,
        },
        201,
      );
    }),
  );

  route(
    app,
    "post",
    "/_mailgun/simulate/event",
    api(ms, async (c) => {
      const body = await parseBody(c);
      const eventName = first(body, "event") as EventType | undefined;
      const allowed: EventType[] = ["opened", "clicked", "unsubscribed", "complained", "delivered", "failed"];
      if (!eventName || !allowed.includes(eventName))
        throw badRequest(`'event' parameter must be one of ${allowed.join(", ")}`);
      const key = first(body, "key");
      const rawMessageId = first(body, "message-id") ?? first(body, "message_id");
      const message = key
        ? ms.messages.findOneBy("key", key)
        : rawMessageId
          ? ms.messages
              .all()
              .find((candidate) => candidate.message_id.replace(/^<|>$/g, "") === rawMessageId.replace(/^<|>$/g, ""))
          : undefined;
      if (!message) throw notFound("Message not found");
      const recipient = (first(body, "recipient") ?? message.recipients[0] ?? "").toLowerCase();
      if (!recipient) throw badRequest("'recipient' parameter is missing");
      const severity =
        (first(body, "severity") as "permanent" | "temporary" | undefined) ??
        (eventName === "failed" ? "permanent" : undefined);
      const event = await recordEvent(ctx, {
        event: eventName,
        domain: message.domain,
        recipient,
        message,
        severity: severity ?? null,
        reason:
          first(body, "reason") ?? (eventName === "failed" ? "bounce" : eventName === "unsubscribed" ? null : null),
        code: eventName === "failed" ? Number(first(body, "code") ?? 550) : eventName === "delivered" ? 250 : null,
        description: first(body, "description") ?? null,
        url: first(body, "url") ?? null,
        ip: first(body, "ip") ?? "127.0.0.1",
        clientInfo:
          eventName === "opened" || eventName === "clicked"
            ? {
                "client-name": "Chrome",
                "client-os": "macOS",
                "client-type": "browser",
                "device-type": "desktop",
                "user-agent": "Mozilla/5.0 emulate",
              }
            : null,
      });
      if (
        eventName === "unsubscribed" &&
        !ms.suppressions
          .findBy("domain", message.domain)
          .some((item) => item.kind === "unsubscribe" && item.address === recipient)
      ) {
        ms.suppressions.insert({
          domain: message.domain,
          kind: "unsubscribe",
          address: recipient,
          code: null,
          error: null,
          tags: message.tags.length > 0 ? message.tags : ["*"],
          reason: null,
          type: "address",
        });
      }
      if (
        eventName === "complained" &&
        !ms.suppressions
          .findBy("domain", message.domain)
          .some((item) => item.kind === "complaint" && item.address === recipient)
      ) {
        ms.suppressions.insert({
          domain: message.domain,
          kind: "complaint",
          address: recipient,
          code: null,
          error: null,
          tags: [],
          reason: null,
          type: "address",
        });
      }
      if (
        eventName === "failed" &&
        severity !== "temporary" &&
        !ms.suppressions
          .findBy("domain", message.domain)
          .some((item) => item.kind === "bounce" && item.address === recipient)
      ) {
        ms.suppressions.insert({
          domain: message.domain,
          kind: "bounce",
          address: recipient,
          code: String(first(body, "code") ?? 550),
          error: first(body, "description") ?? "",
          tags: [],
          reason: null,
          type: "address",
        });
      }
      return c.json({ event: formatEvent(fmt, event) }, 201);
    }),
  );

  route(
    app,
    "get",
    "/_mailgun/simulate/summary",
    api(ms, (c) => {
      const counts: Record<string, number> = {};
      for (const event of ms.events.all()) counts[event.event] = (counts[event.event] ?? 0) + 1;
      return c.json({
        domains: ms.domains.all().map((domain) => domain.name),
        messages: ms.messages.count(),
        events: counts,
        lists: ms.lists.count(),
        webhook_deliveries: ms.webhookDeliveries.count(),
      });
    }),
  );
}
