import type { InspectorTab, RouteContext } from "@emulators/core";
import { escapeHtml, renderInspectorPage } from "@emulators/core";
import { getAirtableStore } from "../store.js";
import { tableFields } from "../schema.js";

const SERVICE_LABEL = "Airtable";

const TABS: InspectorTab[] = [
  { id: "bases", label: "Bases", href: "/?tab=bases" },
  { id: "tables", label: "Tables", href: "/?tab=tables" },
  { id: "records", label: "Records", href: "/?tab=records" },
  { id: "auth", label: "Auth", href: "/?tab=auth" },
];

export function inspectorRoutes({ app, store }: RouteContext): void {
  const s = () => getAirtableStore(store);

  app.get("/", (c) => {
    const requested = c.req.query("tab") ?? "bases";
    const active = TABS.some((t) => t.id === requested) ? requested : "bases";
    const body =
      active === "tables"
        ? tablesView()
        : active === "records"
          ? recordsView(c.req.query("table"))
          : active === "auth"
            ? authView()
            : basesView();
    return c.html(renderInspectorPage("Airtable Inspector", TABS, active, body, SERVICE_LABEL));
  });

  function basesView(): string {
    const rows = s()
      .bases.all()
      .map((b) => [
        escapeHtml(b.base_id),
        escapeHtml(b.name),
        escapeHtml(b.permission_level),
        escapeHtml(String(s().tables.count((t) => t.base_id === b.base_id))),
      ]);
    return section("Bases", table(["Base ID", "Name", "Permission", "Tables"], rows, "No bases seeded."));
  }

  function tablesView(): string {
    const rows = s()
      .tables.all()
      .map((t) => [
        escapeHtml(s().bases.findOneBy("base_id", t.base_id)?.name ?? t.base_id),
        escapeHtml(t.name),
        escapeHtml(t.table_id),
        escapeHtml(String(tableFields(store, t.table_id).length)),
        escapeHtml(String(s().views.count((v) => v.table_id === t.table_id))),
        escapeHtml(String(s().records.count((r) => r.table_id === t.table_id))),
      ]);
    return section(
      "Tables",
      table(["Base", "Name", "Table ID", "Fields", "Views", "Records"], rows, "No tables seeded."),
    );
  }

  function recordsView(tableParam?: string): string {
    const tables = s().tables.all();
    if (tables.length === 0) return section("Records", table(["Record"], [], "No tables seeded."));
    const selected = (tableParam && tables.find((t) => t.table_id === tableParam)) || tables[0];
    const fields = tableFields(store, selected.table_id).slice(0, 6);

    const tabs = tables
      .map((t) => {
        const label = escapeHtml(t.name);
        return t.table_id === selected.table_id
          ? `<strong>${label}</strong>`
          : `<a href="/?tab=records&table=${escapeHtml(t.table_id)}">${label}</a>`;
      })
      .join(" · ");

    const rows = s()
      .records.findBy("table_id", selected.table_id)
      .slice(0, 50)
      .map((rec) => [escapeHtml(rec.record_id), ...fields.map((f) => escapeHtml(cellText(rec.cells[f.name])))]);

    return section(
      `Records — ${escapeHtml(selected.name)}`,
      `<p class="empty">${tabs}</p>` + table(["Record ID", ...fields.map((f) => f.name)], rows, "No records."),
    );
  }

  function authView(): string {
    const rows = s()
      .users.all()
      .map((u) => [
        escapeHtml(u.user_id),
        escapeHtml(u.email),
        escapeHtml(u.name ?? ""),
        escapeHtml(u.scopes.join(", ")),
      ]);
    return section("Tokens / Identity", table(["User ID", "Email", "Name", "Scopes"], rows, "No users seeded."));
  }
}

function cellText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map((v) => String(v)).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function section(title: string, body: string): string {
  return `<main class="inspector-main"><h2>${escapeHtml(title)}</h2>${body}</main>`;
}

function table(headers: string[], rows: string[][], empty: string): string {
  if (rows.length === 0) return `<p class="empty">${escapeHtml(empty)}</p>`;
  const head = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  const body = rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("");
  return `<table class="inspector-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}
