import type { RouteContext } from "@emulators/core";
import { renderCardPage, escapeHtml } from "@emulators/core";
import { getExpoPushStore } from "../store.js";

const SERVICE_LABEL = "Expo Push";

export function inboxRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;

  app.get("/inbox", (c) => {
    const messages = getExpoPushStore(store).messages.all().reverse();
    let body = "";
    if (messages.length === 0) {
      body = `<div class="empty">No notifications sent yet. Use POST /--/api/v2/push/send to send one.</div>`;
    }
    for (const record of messages) {
      const title = typeof record.message.title === "string" ? record.message.title : "(no title)";
      const text = typeof record.message.body === "string" ? record.message.body : "";
      const status = record.ticket.status === "error" ? record.ticket.details.error : (record.receipt?.status ?? "ok");
      const badge = status === "ok" ? "badge-granted" : "badge-denied";
      body += `<div class="app-link">
  <span class="user-text">
    <span class="org-name">${escapeHtml(title)}</span>
    <span class="user-meta">${escapeHtml(record.token)}${text ? ` &middot; ${escapeHtml(text)}` : ""}</span>
  </span>
  <span class="badge ${badge}">${escapeHtml(status)}</span>
</div>`;
    }
    return c.html(
      renderCardPage(
        "Inbox",
        `${messages.length} notification${messages.length !== 1 ? "s" : ""} sent`,
        body,
        SERVICE_LABEL,
      ),
    );
  });
}
