import { renderInspectorPage, type InspectorTab, escapeHtml } from "@emulators/core";
import type { RouteContext } from "@emulators/core";
import { getTwilioStore } from "../store.js";

const SERVICE_LABEL = "Twilio";

const TABS: InspectorTab[] = [
  { id: "messages", label: "Messages", href: "/?tab=messages" },
  { id: "verifications", label: "Verify", href: "/?tab=verifications" },
  { id: "calls", label: "Calls", href: "/?tab=calls" },
];

export function inboxRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ts = () => getTwilioStore(store);

  app.get("/", (c) => {
    const tab = c.req.query("tab") ?? "messages";
    let contentHtml = "";

    if (tab === "messages") {
      const messages = ts()
        .messages.all()
        .sort((a, b) => b.id - a.id);
      const rows = messages
        .map(
          (m) =>
            `<tr>
              <td>${escapeHtml(m.sid)}</td>
              <td>${escapeHtml(m.to)}</td>
              <td>${escapeHtml(m.from)}</td>
              <td>${escapeHtml(m.body)}</td>
              <td><span class="badge">${m.status}</span></td>
              <td>${escapeHtml(m.date_sent)}</td>
            </tr>`,
        )
        .join("");

      contentHtml = `
        <div class="inspector-section">
          <h2>Messages (${messages.length})</h2>
          <table class="inspector-table">
            <thead><tr><th>SID</th><th>To</th><th>From</th><th>Body</th><th>Status</th><th>Sent</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="6"><div class="inspector-empty">No messages sent yet</div></td></tr>'}</tbody>
          </table>
        </div>`;
    } else if (tab === "verifications") {
      const verifications = ts()
        .verifications.all()
        .sort((a, b) => b.id - a.id);
      const rows = verifications
        .map(
          (v) =>
            `<tr>
              <td>${escapeHtml(v.sid)}</td>
              <td>${escapeHtml(v.to)}</td>
              <td>${v.channel}</td>
              <td><code>${escapeHtml(v.code)}</code></td>
              <td><span class="badge">${v.status}</span></td>
              <td>${escapeHtml(v.expires_at)}</td>
            </tr>`,
        )
        .join("");

      contentHtml = `
        <div class="inspector-section">
          <h2>Verifications (${verifications.length})</h2>
          <table class="inspector-table">
            <thead><tr><th>SID</th><th>To</th><th>Channel</th><th>Code</th><th>Status</th><th>Expires</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="6"><div class="inspector-empty">No verifications sent yet</div></td></tr>'}</tbody>
          </table>
        </div>`;
    } else if (tab === "calls") {
      const calls = ts()
        .calls.all()
        .sort((a, b) => b.id - a.id);
      const rows = calls
        .map(
          (call) =>
            `<tr>
              <td>${escapeHtml(call.sid)}</td>
              <td>${escapeHtml(call.to)}</td>
              <td>${escapeHtml(call.from)}</td>
              <td><span class="badge">${call.status}</span></td>
              <td>${call.duration ?? 0}s</td>
            </tr>`,
        )
        .join("");

      contentHtml = `
        <div class="inspector-section">
          <h2>Calls (${calls.length})</h2>
          <table class="inspector-table">
            <thead><tr><th>SID</th><th>To</th><th>From</th><th>Status</th><th>Duration</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="5"><div class="inspector-empty">No calls made yet</div></td></tr>'}</tbody>
          </table>
        </div>`;
    }

    return c.html(renderInspectorPage("Inspector", TABS, tab, contentHtml, SERVICE_LABEL));
  });
}
