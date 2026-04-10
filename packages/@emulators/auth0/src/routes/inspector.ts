import type { RouteContext, InspectorTab, Store } from "@emulators/core";
import { renderInspectorPage, escapeHtml } from "@emulators/core";
import { getAuth0Store } from "../store.js";

const SERVICE_LABEL = "Auth0";

const TABS: InspectorTab[] = [
  { id: "users", label: "Users", href: "/?tab=users" },
  { id: "events", label: "Log Events", href: "/?tab=events" },
  { id: "clients", label: "OAuth Clients", href: "/?tab=clients" },
  { id: "connections", label: "Connections", href: "/?tab=connections" },
];

interface StoredLogEvent {
  received_at: string;
  payload: Record<string, unknown>;
}

function getLogEventSink(store: Store): StoredLogEvent[] {
  let events = store.getData<StoredLogEvent[]>("auth0.inspector.events");
  if (!events) {
    events = [];
    store.setData("auth0.inspector.events", events);
  }
  return events;
}

const MAX_EVENTS = 200;

function metadataSummary(metadata: Record<string, unknown>): string {
  const keys = Object.keys(metadata);
  if (keys.length === 0) return '<span class="inspector-empty">none</span>';
  return keys.map((k) => `${escapeHtml(k)}=${escapeHtml(String(metadata[k]))}`).join(", ");
}

function statusBadge(verified: boolean, blocked: boolean): string {
  if (blocked) return '<span class="badge badge-denied">blocked</span>';
  if (verified) return '<span class="badge badge-granted">verified</span>';
  return '<span class="badge badge-requested">unverified</span>';
}

function eventTypeBadge(type: string): string {
  const success = ["ss", "sv", "scp", "s"].includes(type);
  const cls = success ? "badge-granted" : "badge-denied";
  return `<span class="badge ${cls}">${escapeHtml(type)}</span>`;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso;
  }
}

export function inspectorRoutes({ app, store, baseUrl, webhooks }: RouteContext): void {
  const auth0 = () => getAuth0Store(store);

  // Internal hook sink for log event capture
  app.post("/_emulate/hook-sink", async (c) => {
    const events = getLogEventSink(store);
    try {
      const payload = await c.req.json();
      events.push({ received_at: new Date().toISOString(), payload });
      if (events.length > MAX_EVENTS) {
        events.splice(0, events.length - MAX_EVENTS);
      }
    } catch {
      // ignore malformed payloads
    }
    return c.text("ok", 200);
  });

  // JSON API for log events (used by external tools)
  app.get("/_emulate/events", (c) => {
    const events = getLogEventSink(store);
    const since = c.req.query("since") ?? "";
    if (since) {
      return c.json(events.filter((e) => e.received_at > since));
    }
    return c.json(events);
  });

  // Auto-register the hook sink as a log stream subscriber
  webhooks.register({
    url: `${baseUrl}/_emulate/hook-sink`,
    events: ["*"],
    active: true,
    owner: "auth0",
  });

  // Inspector UI
  app.get("/", (c) => {
    const tab = c.req.query("tab") ?? "users";
    const s = auth0();
    let contentHtml = "";

    if (tab === "users") {
      const users = s.users.all();
      const rows = users
        .map(
          (u) => `<tr>
            <td>${escapeHtml(u.email)}</td>
            <td style="font-size:11px;opacity:0.7">${escapeHtml(u.user_id)}</td>
            <td>${escapeHtml(u.connection)}</td>
            <td>${statusBadge(u.email_verified, u.blocked)}</td>
            <td style="font-size:11px">${metadataSummary(u.app_metadata)}</td>
          </tr>`,
        )
        .join("\n");

      contentHtml = `
        <div class="inspector-section">
          <h2>Users (${users.length})</h2>
          <table class="inspector-table">
            <thead><tr><th>Email</th><th>User ID</th><th>Connection</th><th>Status</th><th>App Metadata</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="5"><div class="inspector-empty">No users</div></td></tr>'}</tbody>
          </table>
        </div>`;
    } else if (tab === "events") {
      const events = getLogEventSink(store).slice().reverse();
      const rows = events
        .map((e) => {
          const p = e.payload;
          return `<tr>
            <td>${eventTypeBadge(String(p.type ?? ""))}</td>
            <td>${formatTime(e.received_at)}</td>
            <td>${escapeHtml(String(p.user_name ?? p.user_id ?? ""))}</td>
            <td>${escapeHtml(String(p.description ?? ""))}</td>
            <td style="font-size:11px;opacity:0.7">${escapeHtml(String(p.connection ?? ""))}</td>
          </tr>`;
        })
        .join("\n");

      contentHtml = `
        <div class="inspector-section">
          <h2>Log Events (${events.length})</h2>
          <p style="font-size:12px;opacity:0.5;margin-bottom:12px">Auth0 log stream events dispatched via webhook. Refresh to update.</p>
          <table class="inspector-table">
            <thead><tr><th>Type</th><th>Time</th><th>User</th><th>Description</th><th>Connection</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="5"><div class="inspector-empty">No events yet. Create or update users to generate log events.</div></td></tr>'}</tbody>
          </table>
        </div>`;
    } else if (tab === "clients") {
      const clients = s.oauthClients.all();
      const rows = clients
        .map(
          (cl) => `<tr>
            <td>${escapeHtml(cl.client_id)}</td>
            <td>${escapeHtml(cl.name)}</td>
            <td style="font-size:11px">${escapeHtml(cl.grant_types.join(", "))}</td>
            <td>${escapeHtml(cl.audience || "default")}</td>
          </tr>`,
        )
        .join("\n");

      contentHtml = `
        <div class="inspector-section">
          <h2>OAuth Clients (${clients.length})</h2>
          <table class="inspector-table">
            <thead><tr><th>Client ID</th><th>Name</th><th>Grant Types</th><th>Audience</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="4"><div class="inspector-empty">No clients</div></td></tr>'}</tbody>
          </table>
        </div>`;
    } else if (tab === "connections") {
      const connections = s.connections.all();
      const rows = connections
        .map(
          (conn) => `<tr>
            <td>${escapeHtml(conn.name)}</td>
            <td>${escapeHtml(conn.strategy)}</td>
          </tr>`,
        )
        .join("\n");

      contentHtml = `
        <div class="inspector-section">
          <h2>Connections (${connections.length})</h2>
          <table class="inspector-table">
            <thead><tr><th>Name</th><th>Strategy</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="2"><div class="inspector-empty">No connections</div></td></tr>'}</tbody>
          </table>
        </div>`;
    }

    return c.html(renderInspectorPage("Inspector", TABS, tab, contentHtml, SERVICE_LABEL));
  });
}
