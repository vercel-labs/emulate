import type { InspectorTab, RouteContext } from "@emulators/core";
import { escapeHtml, renderInspectorPage } from "@emulators/core";
import { getPostHogStore } from "../store.js";

const SERVICE_LABEL = "PostHog";

const TABS: InspectorTab[] = [
  { id: "events", label: "Events", href: "/_inspector?tab=events" },
  { id: "flags", label: "Feature Flags", href: "/_inspector?tab=flags" },
];

function summarizeProperties(properties: Record<string, unknown>): string {
  const text = JSON.stringify(properties);
  if (text.length <= 80) return text;
  return `${text.slice(0, 77)}...`;
}

export function inspectorRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ph = () => getPostHogStore(store);

  app.get("/_inspector", (c) => {
    const tab = c.req.query("tab") ?? "events";
    const projectIdParam = c.req.query("project_id");
    const projectId = projectIdParam ? Number(projectIdParam) : null;

    let contentHtml = "";

    if (tab === "flags") {
      const flags = ph()
        .featureFlags.all()
        .filter((flag) => projectId === null || flag.project_id === projectId);
      const rows = flags
        .map(
          (flag) => `<tr>
            <td>${escapeHtml(flag.key)}</td>
            <td>${flag.project_id}</td>
            <td>${escapeHtml(String(flag.default))}</td>
            <td>${Object.keys(flag.overrides).length}</td>
            <td>${flag.conditions.length}</td>
          </tr>`,
        )
        .join("\n");

      contentHtml = `
        <div class="inspector-section">
          <h2>Feature Flags (${flags.length})</h2>
          <table class="inspector-table">
            <thead><tr><th>Key</th><th>Project</th><th>Default</th><th>Overrides</th><th>Conditions</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="5"><div class="inspector-empty">No feature flags</div></td></tr>`}</tbody>
          </table>
        </div>`;
    } else {
      const events = ph()
        .events.all()
        .filter((event) => projectId === null || event.project_id === projectId)
        .reverse();
      const rows = events
        .map(
          (event) => `<tr>
            <td>${escapeHtml(event.distinct_id ?? "")}</td>
            <td>${escapeHtml(event.event)}</td>
            <td>${escapeHtml(event.timestamp)}</td>
            <td>${event.project_id}</td>
            <td>${escapeHtml(summarizeProperties(event.properties))}</td>
          </tr>`,
        )
        .join("\n");

      contentHtml = `
        <div class="inspector-section">
          <h2>Events (${events.length})</h2>
          <table class="inspector-table">
            <thead><tr><th>Distinct ID</th><th>Event</th><th>Timestamp</th><th>Project</th><th>Properties</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="5"><div class="inspector-empty">No events</div></td></tr>`}</tbody>
          </table>
        </div>`;
    }

    return c.html(renderInspectorPage("Inspector", TABS, tab, contentHtml, SERVICE_LABEL));
  });
}
