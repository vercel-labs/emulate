import type { RouteContext } from "@emulators/core";
import { renderCardPage, escapeHtml, escapeAttr } from "@emulators/core";
import { getResendStore } from "../store.js";

const SERVICE_LABEL = "Resend";

export function inboxRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const rs = () => getResendStore(store);

  app.get("/inbox", (c) => {
    const emails = rs().emails.all().reverse();

    let body = "";

    if (emails.length === 0) {
      body = `<div class="empty">No emails sent yet. Use POST /emails to send one.</div>`;
    } else {
      for (const email of emails) {
        const letter = (email.from?.[0] ?? "?").toUpperCase();
        const statusClass = email.status === "delivered"
          ? "badge-granted"
          : email.status === "bounced"
            ? "badge-denied"
            : "badge-requested";

        body += `<a href="/inbox/${escapeAttr(email.uuid)}" class="app-link">
  <span class="org-icon">${escapeHtml(letter)}</span>
  <span class="user-text">
    <span class="org-name">${escapeHtml(email.subject)}</span>
    <span class="user-meta">${escapeHtml(email.from)} &rarr; ${escapeHtml(email.to.join(", "))}</span>
  </span>
  <span class="badge ${statusClass}">${escapeHtml(email.status)}</span>
</a>`;
      }
    }

    const html = renderCardPage(
      "Inbox",
      `${emails.length} email${emails.length !== 1 ? "s" : ""} sent`,
      body,
      SERVICE_LABEL,
    );

    return c.html(html);
  });

  app.get("/inbox/:id", (c) => {
    const id = c.req.param("id");
    const email = rs().emails.findOneBy("uuid", id);

    if (!email) {
      const html = renderCardPage(
        "Not Found",
        "The requested email was not found.",
        `<div class="empty">Email not found</div>`,
        SERVICE_LABEL,
      );
      return c.html(html, 404);
    }

    const statusClass = email.status === "delivered"
      ? "badge-granted"
      : email.status === "bounced"
        ? "badge-denied"
        : "badge-requested";

    let tagsHtml = "";
    if (email.tags.length > 0) {
      tagsHtml = `<div class="info-text">`;
      for (const tag of email.tags) {
        tagsHtml += `<span class="badge badge-requested">${escapeHtml(tag.name)}: ${escapeHtml(tag.value)}</span> `;
      }
      tagsHtml += `</div>`;
    }

    const recipientLines: string[] = [];
    recipientLines.push(`<strong>To:</strong> ${escapeHtml(email.to.join(", "))}`);
    if (email.cc.length > 0) {
      recipientLines.push(`<strong>Cc:</strong> ${escapeHtml(email.cc.join(", "))}`);
    }
    if (email.bcc.length > 0) {
      recipientLines.push(`<strong>Bcc:</strong> ${escapeHtml(email.bcc.join(", "))}`);
    }

    const previewContent = email.html
      ? `<iframe
  sandbox=""
  srcdoc="${escapeAttr(email.html)}"
  class="s-card"
  style="width:100%;min-height:300px;border:1px solid #0a3300;border-radius:8px;background:#fff;"
></iframe>`
      : email.text
        ? `<div class="s-card"><pre class="info-text">${escapeHtml(email.text)}</pre></div>`
        : `<div class="empty">No content</div>`;

    const body = `
<div class="org-row">
  <span class="badge ${statusClass}">${escapeHtml(email.status)}</span>
  <span class="user-meta">${escapeHtml(email.created_at)}</span>
</div>
<div class="s-card">
  <div class="perm-list">
    <li><strong>From:</strong> ${escapeHtml(email.from)}</li>
    ${recipientLines.map((line) => `<li>${line}</li>`).join("\n    ")}
  </div>
</div>
${tagsHtml}
<div class="section-heading">Preview</div>
${previewContent}
<div class="info-text">
  <strong>Last event:</strong> ${escapeHtml(email.last_event)}
  ${email.scheduled_at ? ` | <strong>Scheduled:</strong> ${escapeHtml(email.scheduled_at)}` : ""}
</div>`;

    const html = renderCardPage(
      email.subject,
      `Email ${escapeHtml(email.uuid)}`,
      body,
      SERVICE_LABEL,
    );

    return c.html(html);
  });
}
