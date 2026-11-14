import { escapeHtml, renderInspectorPage, renderJsonDetails, type InspectorTab } from "@emulators/core";
import type { CallRecord, Rule } from "../types.js";

/** A rule with the budget left on it; `remaining` is null when the rule is unlimited. */
export interface AiRuleStatus {
  rule: Rule;
  remaining: number | null;
}

export interface AiInspectorOptions {
  tab: "calls" | "rules";
  calls: CallRecord[];
  rules: AiRuleStatus[];
  selected?: number;
}

const TABS: InspectorTab[] = [
  { id: "calls", label: "Calls", href: "/?tab=calls" },
  { id: "rules", label: "Rules", href: "/?tab=rules" },
];

/** Renders the read-only AI inspector page; request-derived values are escaped here. */
export function renderAiInspector({ tab, calls, rules, selected }: AiInspectorOptions): string {
  const body = tab === "rules" ? rulesView(rules) : callsView(calls, selected);
  return renderInspectorPage("AI Inspector", TABS, tab, body, "AI");
}

function section(title: string, body: string): string {
  return `<section class="inspector-section"><h2>${escapeHtml(title)}</h2>${body}</section>`;
}

function table(headers: string[], rows: string[][], empty: string): string {
  if (rows.length === 0) return `<div class="empty">${escapeHtml(empty)}</div>`;
  const headerHtml = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("");
  const rowHtml = rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("\n");
  return `<div class="inspector-scroll"><table class="inspector-table"><thead><tr>${headerHtml}</tr></thead><tbody>${rowHtml}</tbody></table></div>`;
}

function matchedLabel(matched: CallRecord["matched"]): string {
  if (!matched) return "none";
  if ("default" in matched) return `default: ${matched.default}`;
  return matched.id;
}

function ruleAnswer(rule: Rule): string {
  if (rule.error) return `error ${rule.error.status}`;
  return rule.fault ? `reply, ${rule.fault.kind} fault` : "reply";
}

function callsView(calls: CallRecord[], selected: number | undefined): string {
  const ordered = [...calls].sort((a, b) => b.seq - a.seq);
  const rows = ordered.map((call) => [
    `<a href="/?tab=calls&amp;call=${call.seq}">#${call.seq}</a>`,
    escapeHtml(call.time),
    escapeHtml(call.format),
    escapeHtml(call.model),
    escapeHtml(call.stream ? "stream" : "unary"),
    escapeHtml(matchedLabel(call.matched)),
    escapeHtml(String(call.status)),
    escapeHtml(call.fault),
    escapeHtml(call.delivery),
  ]);
  const list = section(
    "Calls",
    table(
      ["Seq", "Time", "Format", "Model", "Mode", "Matched", "Status", "Fault", "Delivery"],
      rows,
      "No calls recorded.",
    ),
  );
  const chosen = ordered.find((call) => call.seq === selected);
  return chosen ? list + section(`Call #${chosen.seq}`, renderJsonDetails("Record", chosen, true)) : list;
}

function rulesView(rules: AiRuleStatus[]): string {
  const rows = rules.map(({ rule, remaining }) => [
    escapeHtml(rule.id),
    escapeHtml(JSON.stringify(rule.match)),
    escapeHtml(ruleAnswer(rule)),
    escapeHtml(remaining === null ? "unlimited" : String(remaining)),
  ]);
  return section("Rules", table(["ID", "Match", "Answers with", "Remaining"], rows, "No rules loaded."));
}
