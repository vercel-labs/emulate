import type { AppEnv, Hono, InspectorTab } from "@emulators/core";
import { escapeHtml, renderInspectorPage } from "@emulators/core";
import { cluster, type EsStore } from "../store.js";

const SERVICE_LABEL = "Elastic";
const TABS: InspectorTab[] = [
  { id: "policies", label: "Agent Policies", href: "/_elastic?tab=policies" },
  { id: "integrations", label: "Integrations", href: "/_elastic?tab=integrations" },
  { id: "agents", label: "Agents", href: "/_elastic?tab=agents" },
  { id: "indices", label: "Indices", href: "/_elastic?tab=indices" },
  { id: "events", label: "Events", href: "/_elastic?tab=events" },
  { id: "auth", label: "Auth", href: "/_elastic?tab=auth" },
];

type TabId = (typeof TABS)[number]["id"];

function maskSecret(value: string): string {
  return value.length <= 8 ? "****" : `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function inspectorRoutes(app: Hono<AppEnv>, es: EsStore, baseUrl: string): void {
  const policyName = (id: string) => es.agentPolicies.findOneBy("policy_id", id)?.name ?? id;

  const render = (requested: string | undefined) => {
    const active = TABS.some((tab) => tab.id === requested) ? (requested as TabId) : "policies";
    const views: Record<TabId, () => string> = {
      policies: policiesView,
      integrations: integrationsView,
      agents: agentsView,
      indices: indicesView,
      events: eventsView,
      auth: authView,
    };
    return renderInspectorPage("Elastic Inspector", TABS, active, views[active](), SERVICE_LABEL);
  };
  app.get("/_elastic", (c) => c.html(render(c.req.query("tab"))));
  app.get("/_elastic/inspector", (c) => c.html(render(c.req.query("tab"))));

  function policiesView(): string {
    const rows = [...es.agentPolicies.all()]
      .sort((a, b) => a.id - b.id)
      .map((policy) => [
        escapeHtml(policy.name),
        code(policy.policy_id),
        escapeHtml(policy.namespace),
        badge(policy.deleted ? "deleted" : policy.status),
        escapeHtml(String(policy.revision)),
        escapeHtml(String(es.packagePolicies.findBy("policy_id", policy.policy_id).length)),
        escapeHtml(String(es.agents.findBy("policy_id", policy.policy_id).filter((agent) => agent.active).length)),
        escapeHtml(policy.global_data_tags.map((tag) => `${tag.name}=${tag.value}`).join(", ")),
        escapeHtml(
          es.enrollmentKeys
            .findBy("policy_id", policy.policy_id)
            .filter((key) => key.active)
            .map((key) => maskSecret(key.api_key))
            .join(", "),
        ),
      ]);
    return section(
      "Agent policies",
      `<p>Fleet API at <code>${escapeHtml(baseUrl)}/api/fleet</code>. The root <code>${escapeHtml(baseUrl)}/</code> answers as Elasticsearch, so this inspector lives at <code>/_elastic</code>.</p>` +
        table(
          [
            "Name",
            "Id",
            "Namespace",
            "State",
            "Revision",
            "Integrations",
            "Agents",
            "Global data tags",
            "Enrollment tokens",
          ],
          rows,
          "No agent policies.",
        ),
    );
  }

  function integrationsView(): string {
    const rows = [...es.packagePolicies.all()]
      .sort((a, b) => a.id - b.id)
      .map((packagePolicy) => [
        escapeHtml(packagePolicy.name),
        code(packagePolicy.package_policy_id),
        badge(packagePolicy.package_name),
        escapeHtml(packagePolicy.package_version),
        escapeHtml(packagePolicy.policy_ids.map(policyName).join(", ")),
        badge(packagePolicy.enabled ? "enabled" : "disabled"),
        escapeHtml(String(packagePolicy.inputs.filter((input) => input.enabled !== false).length)),
        escapeHtml(packagePolicy.updated_at),
      ]);
    return section(
      "Package policies (integrations)",
      table(
        ["Name", "Id", "Package", "Version", "Agent policies", "State", "Inputs", "Updated"],
        rows,
        "No package policies.",
      ),
    );
  }

  function agentsView(): string {
    const rows = [...es.agents.all()]
      .sort((a, b) => a.id - b.id)
      .map((agent) => [
        escapeHtml(agent.hostname),
        code(agent.agent_id),
        escapeHtml(policyName(agent.policy_id)),
        badge(agent.status),
        escapeHtml(agent.version),
        escapeHtml(agent.os_full),
        escapeHtml(agent.ip.join(", ")),
        escapeHtml(agent.last_checkin),
      ]);
    return section(
      "Agents",
      `<p>Enroll with <code>POST /_elastic/simulate/enroll</code> and check in with <code>POST /_elastic/simulate/checkin</code>.</p>` +
        table(["Host", "Id", "Policy", "Status", "Version", "OS", "IP", "Last check-in"], rows, "No agents."),
    );
  }

  function indicesView(): string {
    const rows = [...es.indices.all()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((index) => [
        escapeHtml(index.name),
        escapeHtml(index.aliases.join(", ")),
        escapeHtml(String(es.documents.findBy("index", index.name).length)),
        escapeHtml(
          Object.keys((index.mappings as { properties?: Record<string, unknown> }).properties ?? {})
            .slice(0, 8)
            .join(", "),
        ),
      ]);
    return section(
      "Indices",
      `<p>Search with <code>POST ${escapeHtml(baseUrl)}/{index}/_search</code>; add documents with <code>POST /_elastic/simulate/documents</code>.</p>` +
        table(["Index", "Aliases", "Documents", "Mapped fields"], rows, "No indices."),
    );
  }

  function eventsView(): string {
    const rows = [...es.events.all()]
      .sort((a, b) => b.id - a.id)
      .slice(0, 300)
      .map((event) => [
        badge(event.type),
        code(event.subject),
        `<code>${escapeHtml(JSON.stringify(event.detail))}</code>`,
        escapeHtml(event.created_at),
      ]);
    return section(
      "Events",
      `<p>Also available as JSON at <code>${escapeHtml(baseUrl)}/_elastic/events</code>.</p>` +
        table(["Type", "Subject", "Detail", "Created"], rows, "No events yet."),
    );
  }

  function authView(): string {
    const rows = es.apiKeys
      .all()
      .map((key) => [
        escapeHtml(key.name),
        code(key.key_id),
        `<code>${escapeHtml(maskSecret(key.api_key))}</code>`,
        `<code>${escapeHtml(maskSecret(Buffer.from(`${key.key_id}:${key.api_key}`).toString("base64")))}</code>`,
      ]);
    return section(
      "API keys",
      `<p>Kibana calls use <code>Authorization: ApiKey &lt;api_key&gt;</code> plus a <code>kbn-xsrf</code> header on writes. The Elasticsearch client sends <code>ApiKey base64(id:api_key)</code>; both forms are accepted, as is <code>Basic name:api_key</code>. Cluster ${escapeHtml(cluster(es).name)} reports version ${escapeHtml(cluster(es).version)}.</p>` +
        table(["Name", "Id", "API key", "Encoded id:api_key"], rows, "No API keys configured."),
    );
  }
}

function code(value: string): string {
  return `<code>${escapeHtml(value)}</code>`;
}

function badge(value: string): string {
  return `<span class="badge">${escapeHtml(value)}</span>`;
}

function section(title: string, body: string): string {
  return `<section class="inspector-section">
  <h2>${escapeHtml(title)}</h2>
  ${body}
</section>`;
}

function table(headers: string[], rows: string[][], empty: string): string {
  if (rows.length === 0) return `<p class="inspector-empty">${escapeHtml(empty)}</p>`;
  const headerHtml = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("");
  const rowHtml = rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("\n");
  return `<table class="inspector-table">
  <thead><tr>${headerHtml}</tr></thead>
  <tbody>
${rowHtml}
  </tbody>
</table>`;
}
