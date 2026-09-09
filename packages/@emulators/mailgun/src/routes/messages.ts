import { renderCardPage, escapeHtml } from "@emulators/core";
import { formatStoredMessage } from "../formatters.js";
import { api, all, badRequest, notFound, parseBody, route, splitAddresses } from "../helpers.js";
import { parseMimeBody, parseSendBody, personalize, sendMessage } from "../sending.js";
import { findDomain, MESSAGE_HTML_PATH, type MailgunRouteContext } from "../route-utils.js";

const SERVICE_LABEL = "Mailgun";

export function messageRoutes(rc: MailgunRouteContext): void {
  const { app, ms, ctx, fmt } = rc;

  route(
    app,
    "post",
    "/v3/:domain/messages",
    api(
      ms,
      async (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        const body = await parseBody(c);
        const input = parseSendBody(body, domain);
        const result = await sendMessage(ctx, input);
        return c.json({ id: result.message.message_id, message: "Queued. Thank you." });
      },
      "domain",
    ),
  );

  route(
    app,
    "post",
    "/v3/:domain/messages.mime",
    api(
      ms,
      async (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        const body = await parseBody(c);
        const input = parseMimeBody(body, domain);
        const result = await sendMessage(ctx, input);
        return c.json({ id: result.message.message_id, message: "Queued. Thank you." });
      },
      "domain",
    ),
  );

  route(
    app,
    "get",
    "/v3/domains/:domain/messages/:key",
    api(
      ms,
      (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        const message = ms.messages.findOneBy("key", c.req.param("key"));
        if (!message || message.domain !== domain.name) throw notFound("Message not found");
        return c.json(formatStoredMessage(fmt, message));
      },
      "domain",
    ),
  );

  route(
    app,
    "post",
    "/v3/domains/:domain/messages/:key",
    api(
      ms,
      async (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        const message = ms.messages.findOneBy("key", c.req.param("key"));
        if (!message || message.domain !== domain.name) throw notFound("Message not found");
        const body = await parseBody(c);
        const to = all(body, "to").flatMap(splitAddresses);
        if (to.length === 0) throw badRequest("'to' parameter is missing");
        const result = await sendMessage(ctx, {
          domain,
          from: message.from,
          to,
          cc: [],
          bcc: [],
          subject: message.subject,
          text: message.text,
          html: message.html,
          ampHtml: message.amp_html,
          headers: message.headers,
          variables: message.variables,
          recipientVariables: null,
          tags: message.tags,
          template: null,
          templateVersion: null,
          testMode: false,
          deliveryTime: null,
          attachments: message.attachments,
          rawMime: message.raw_mime,
          direction: "outbound",
        });
        return c.json({ id: result.message.message_id, message: "Queued. Thank you." });
      },
      "domain",
    ),
  );

  route(
    app,
    "delete",
    "/v3/domains/:domain/messages/:key",
    api(
      ms,
      (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        const message = ms.messages.findOneBy("key", c.req.param("key"));
        if (!message || message.domain !== domain.name) throw notFound("Message not found");
        ms.messages.delete(message.id);
        return c.json({ message: "Message has been deleted" });
      },
      "domain",
    ),
  );

  route(
    app,
    "get",
    "/v3/domains/:domain/messages/:key/attachments/:index",
    api(
      ms,
      (c) => {
        const message = ms.messages.findOneBy("key", c.req.param("key"));
        const attachment = message?.attachments[Number(c.req.param("index"))];
        if (!message || !attachment) throw notFound("Attachment not found");
        return c.body(Buffer.from(attachment.content, "base64"), 200, {
          "Content-Type": attachment.content_type,
          "Content-Disposition": `${attachment.inline ? "inline" : "attachment"}; filename="${attachment.name.replace(/"/g, "")}"`,
        });
      },
      "domain",
    ),
  );

  app.get(`${MESSAGE_HTML_PATH}/:key`, (c) => {
    const message = ms.messages.findOneBy("key", c.req.param("key"));
    if (!message) {
      return c.html(
        renderCardPage(
          "Message Not Found",
          "This stored message does not exist.",
          '<p class="empty">Check the storage key.</p>',
          SERVICE_LABEL,
        ),
        404,
      );
    }
    const recipient = c.req.query("recipient") ?? message.recipients[0] ?? "";
    const rendered = personalize(message, recipient);
    const events = ms.events
      .findBy("message_key", message.key)
      .map(
        (event) =>
          `<li><span class="badge">${escapeHtml(event.event)}</span> ${escapeHtml(event.recipient)}${event.reason ? ` (${escapeHtml(event.reason)})` : ""}</li>`,
      )
      .join("");
    const bodyHtml = rendered.html
      ? `<iframe title="HTML body" style="width:100%;min-height:320px;border:1px solid #eaeaea;border-radius:8px;background:#fff" sandbox srcdoc="${escapeHtml(rendered.html)}"></iframe>`
      : `<pre style="white-space:pre-wrap">${escapeHtml(rendered.text ?? "")}</pre>`;
    return c.html(
      renderCardPage(
        rendered.subject || "(no subject)",
        `From ${escapeHtml(message.from)} to ${escapeHtml(message.to.join(", "))}`,
        `<p><strong>Message-Id</strong> ${escapeHtml(message.message_id)}</p>
<p><strong>Domain</strong> ${escapeHtml(message.domain)}${message.tags.length > 0 ? ` · <strong>Tags</strong> ${escapeHtml(message.tags.join(", "))}` : ""}</p>
${bodyHtml}
${message.attachments.length > 0 ? `<p><strong>Attachments</strong> ${message.attachments.map((attachment) => escapeHtml(`${attachment.name} (${attachment.size} bytes)`)).join(", ")}</p>` : ""}
<p><strong>Events</strong></p><ul>${events || "<li>None</li>"}</ul>`,
        SERVICE_LABEL,
      ),
    );
  });

  route(
    app,
    "get",
    "/v3/:domain/messages",
    api(
      ms,
      (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        const messages = ms.messages.findBy("domain", domain.name).sort((a, b) => b.id - a.id);
        return c.json({
          items: messages.map((message) => ({
            key: message.key,
            "message-id": message.message_id,
            from: message.from,
            to: message.to,
            subject: message.subject,
            tags: message.tags,
            recipients: message.recipients,
            "test-mode": message.test_mode,
            timestamp: Math.floor(Date.parse(message.created_at) / 1000),
            storage: { url: `${rc.baseUrl}/v3/domains/${message.domain}/messages/${message.key}`, key: message.key },
            html_url: `${rc.baseUrl}${MESSAGE_HTML_PATH}/${message.key}`,
          })),
          total_count: messages.length,
        });
      },
      "domain",
    ),
  );
}
