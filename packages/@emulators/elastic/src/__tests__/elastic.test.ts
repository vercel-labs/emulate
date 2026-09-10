import { Hono, Store, WebhookDispatcher, type AppEnv } from "@emulators/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_API_KEY,
  DEFAULT_CUSTOMER_NAMESPACE,
  DEFAULT_DEFENDER_INTEGRATION_ID,
  DEFAULT_ENCODED_API_KEY,
  DEFAULT_ENROLLMENT_TOKEN,
  DEFAULT_FIREWALL_INDEX,
  DEFAULT_FLEET_SERVER_HOST_ID,
  DEFAULT_O365_INDEX,
  DEFAULT_O365_INTEGRATION_ID,
  DEFAULT_POLICY_IDS,
  DEFAULT_STATUS_INDEX,
  elasticPlugin,
  getEsStore,
  seedFromConfig,
  type ElasticSeedConfig,
} from "../index.js";

const baseUrl = "http://localhost:4322";

function createApp(seed?: ElasticSeedConfig, withDefaults = true) {
  const store = new Store();
  const app = new Hono<AppEnv>();
  elasticPlugin.register(app, store, new WebhookDispatcher(), baseUrl);
  if (withDefaults) elasticPlugin.seed?.(store, baseUrl);
  if (seed) seedFromConfig(store, baseUrl, seed);
  return { app, store };
}

async function call(
  app: Hono<AppEnv>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  auth: string | null = `ApiKey ${DEFAULT_API_KEY}`,
) {
  const requestHeaders: Record<string, string> = { ...headers };
  if (auth) requestHeaders.Authorization = auth;
  if (body !== undefined && !requestHeaders["Content-Type"]) requestHeaders["Content-Type"] = "application/json";
  const response = await app.request(`${baseUrl}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

const fleet = (app: Hono<AppEnv>, method: string, path: string, body?: unknown) =>
  call(app, method, `/api/fleet${path}`, body, { "kbn-xsrf": "true" });

describe("Elastic plugin", () => {
  let ctx: ReturnType<typeof createApp>;

  beforeEach(() => {
    ctx = createApp();
  });

  describe("authentication", () => {
    it("accepts Kibana ApiKey, encoded id:key, and Basic forms and rejects the rest", async () => {
      expect((await fleet(ctx.app, "GET", "/agent_policies")).status).toBe(200);
      expect((await call(ctx.app, "GET", "/", undefined, {}, `ApiKey ${DEFAULT_ENCODED_API_KEY}`)).status).toBe(200);
      expect(
        (
          await call(
            ctx.app,
            "GET",
            "/",
            undefined,
            {},
            `Basic ${Buffer.from(`emulate:${DEFAULT_API_KEY}`).toString("base64")}`,
          )
        ).status,
      ).toBe(200);
      const missing = await call(ctx.app, "GET", "/api/fleet/agent_policies", undefined, {}, null);
      expect(missing.status).toBe(401);
      expect(missing.body).toEqual({ statusCode: 401, error: "Unauthorized", message: "Unauthorized" });
      const esMissing = await call(ctx.app, "GET", "/", undefined, {}, null);
      expect(esMissing.status).toBe(401);
      expect(esMissing.body.error.type).toBe("security_exception");
      const noXsrf = await call(ctx.app, "POST", "/api/fleet/agent_policies", { name: "x" });
      expect(noXsrf.status).toBe(400);
      expect(noXsrf.body.message).toContain("kbn-xsrf");
    });
  });

  describe("Fleet (CyberHub flow)", () => {
    it("lists and finds agent policies by kuery, with package policies and agent counts", async () => {
      const all = await fleet(ctx.app, "GET", "/agent_policies?perPage=100");
      expect(all.body.total).toBe(6);
      expect(all.body.items[0]).toMatchObject({
        id: DEFAULT_POLICY_IDS[0],
        name: "Cyna SOC collectors 1",
        namespace: "default",
        agents: 2,
        status: "active",
      });
      expect(all.body.items[0].package_policies.map((packagePolicy: any) => packagePolicy.name)).toEqual([
        "O365_ACME-CORP",
        "MS365_DEFENDER_ACME-CORP",
      ]);
      const byName = await fleet(
        ctx.app,
        "GET",
        `/agent_policies?${new URLSearchParams({ kuery: "ACME-CORP Active Directory" }).toString()}`,
      );
      expect(byName.body.items.map((policy: any) => policy.name)).toEqual(["ACME-CORP Active Directory"]);
      const single = await fleet(ctx.app, "GET", `/agent_policies/${DEFAULT_POLICY_IDS[0]}`);
      expect(single.body.item.package_policies).toHaveLength(2);
      expect(single.body.item.package_policies[0].package).toMatchObject({ name: "o365", version: "3.8.1" });
      expect((await fleet(ctx.app, "GET", "/agent_policies/00000000-0000-0000-0000-000000000000")).status).toBe(404);
    });

    it("creates an agent policy with sys_monitoring, deletes the default package policy, updates tags, and deletes", async () => {
      const created = await fleet(ctx.app, "POST", "/agent_policies?sys_monitoring=true", {
        name: "NEWCO Active Directory",
        description: "",
        namespace: "default",
        monitoring_enabled: ["logs", "traces"],
        inactivity_timeout: 1209600,
        is_protected: false,
        global_data_tags: [{ name: "cyna.customer", value: "Newco" }],
      });
      expect(created.status).toBe(200);
      expect(created.body.item).toMatchObject({
        name: "NEWCO Active Directory",
        namespace: "default",
        monitoring_enabled: ["logs", "traces"],
        inactivity_timeout: 1209600,
        is_protected: false,
        status: "active",
        revision: 1,
      });
      const detail = await fleet(ctx.app, "GET", `/agent_policies/${created.body.item.id}`);
      expect(detail.body.item.package_policies).toHaveLength(1);
      expect(detail.body.item.package_policies[0].package.name).toBe("system");
      expect(
        (await fleet(ctx.app, "DELETE", `/package_policies/${detail.body.item.package_policies[0].id}`)).status,
      ).toBe(200);
      expect(
        (await fleet(ctx.app, "GET", `/agent_policies/${created.body.item.id}`)).body.item.package_policies,
      ).toEqual([]);
      const duplicate = await fleet(ctx.app, "POST", "/agent_policies", {
        name: "NEWCO Active Directory",
        namespace: "default",
      });
      expect(duplicate.status).toBe(409);
      const updated = await fleet(ctx.app, "PUT", `/agent_policies/${created.body.item.id}`, {
        name: "NEWCO Active Directory",
        namespace: "default",
        description: "",
        monitoring_enabled: ["logs", "traces"],
        inactivity_timeout: 1209600,
        is_protected: false,
        global_data_tags: [{ name: "cyna.customer", value: "Newco SAS" }],
      });
      expect(updated.body.item.global_data_tags).toEqual([{ name: "cyna.customer", value: "Newco SAS" }]);
      expect(updated.body.item.revision).toBe(2);
      expect((await fleet(ctx.app, "PUT", `/agent_policies/${created.body.item.id}`, { name: "x" })).status).toBe(400);
      const keys = await fleet(
        ctx.app,
        "GET",
        `/enrollment_api_keys?${new URLSearchParams({ kuery: created.body.item.id }).toString()}`,
      );
      expect(keys.body.items).toHaveLength(1);
      expect(keys.body.items[0]).toMatchObject({ policy_id: created.body.item.id, active: true });
      const deleted = await fleet(ctx.app, "POST", "/agent_policies/delete", { agentPolicyId: created.body.item.id });
      expect(deleted.body).toEqual({ id: created.body.item.id, name: "NEWCO Active Directory" });
      expect((await fleet(ctx.app, "GET", `/agent_policies/${created.body.item.id}`)).status).toBe(404);
      const busy = await fleet(ctx.app, "POST", "/agent_policies/delete", { agentPolicyId: DEFAULT_POLICY_IDS[0] });
      expect(busy.status).toBe(400);
    });

    it("creates, reads, updates, and deletes package policies with Fleet semantics", async () => {
      const body = {
        name: "O365_NEWCO",
        description: "",
        policy_id: DEFAULT_POLICY_IDS[1],
        package: { name: "o365", version: "3.8.1" },
        inputs: {
          "o365-o365audit": { enabled: false },
          "o365-cel": {
            enabled: true,
            streams: {
              "o365.audit": {
                enabled: true,
                vars: {
                  url: "https://manage.office.com",
                  azure_tenant_id: "22222222-2222-4222-8222-222222222222",
                  interval: "3m",
                  tags: ["newco"],
                  preserve_original_event: true,
                },
              },
            },
          },
        },
      };
      const created = await fleet(ctx.app, "POST", "/package_policies", body);
      expect(created.status).toBe(200);
      expect(created.body.item).toMatchObject({
        name: "O365_NEWCO",
        policy_id: DEFAULT_POLICY_IDS[1],
        policy_ids: [DEFAULT_POLICY_IDS[1]],
        enabled: true,
        package: { name: "o365", title: "Microsoft Office 365", version: "3.8.1" },
        revision: 1,
      });
      expect(created.body.item.inputs.find((input: any) => input.type === "cel")).toMatchObject({
        policy_template: "o365",
        enabled: true,
      });
      expect(
        created.body.item.inputs.find((input: any) => input.type === "cel").streams[0].vars.azure_tenant_id.value,
      ).toBe("22222222-2222-4222-8222-222222222222");
      const conflict = await fleet(ctx.app, "POST", "/package_policies", body);
      expect(conflict.status).toBe(409);
      expect(conflict.body.message).toContain("already exists");
      expect(
        (
          await fleet(ctx.app, "POST", "/package_policies", {
            ...body,
            name: "orphan",
            policy_id: "00000000-0000-0000-0000-000000000000",
          })
        ).status,
      ).toBe(404);
      const fetched = await fleet(ctx.app, "GET", `/package_policies/${created.body.item.id}`);
      expect(fetched.body.item.name).toBe("O365_NEWCO");
      const updated = await fleet(ctx.app, "PUT", `/package_policies/${created.body.item.id}`, {
        ...body,
        package: { name: "o365", version: "3.9.0" },
      });
      expect(updated.body.item).toMatchObject({ revision: 2, package: { version: "3.9.0" } });
      const arrayForm = await fleet(ctx.app, "POST", "/package_policies", {
        name: "system-event-log-NEWCO",
        description: "",
        policy_id: DEFAULT_POLICY_IDS[2],
        policy_ids: [DEFAULT_POLICY_IDS[2]],
        enabled: true,
        force: false,
        package: { name: "system", title: "System", version: "2.9.1" },
        inputs: [
          {
            type: "winlog",
            policy_template: "system",
            enabled: true,
            streams: [
              {
                enabled: true,
                data_stream: { type: "logs", dataset: "system.security" },
                vars: { event_id: { type: "text", value: "-4662" } },
              },
            ],
          },
        ],
      });
      expect(arrayForm.status).toBe(200);
      expect(arrayForm.body.item.inputs[0].streams[0].data_stream.dataset).toBe("system.security");
      expect((await fleet(ctx.app, "DELETE", `/package_policies/${created.body.item.id}`)).body).toMatchObject({
        id: created.body.item.id,
        success: true,
      });
      expect((await fleet(ctx.app, "GET", `/package_policies/${created.body.item.id}`)).status).toBe(404);
    });

    it("provides what the Active Directory enrollment command needs", async () => {
      const versions = await fleet(ctx.app, "GET", "/agents/available_versions");
      expect(versions.body.items[0]).toMatch(/^\d+\.\d+\.\d+$/);
      const host = await fleet(ctx.app, "GET", `/fleet_server_hosts/${DEFAULT_FLEET_SERVER_HOST_ID}`);
      expect(host.body.item).toMatchObject({
        id: DEFAULT_FLEET_SERVER_HOST_ID,
        is_default: true,
        host_urls: ["https://fleet.emulate.local:8220"],
      });
      const keys = await fleet(
        ctx.app,
        "GET",
        `/enrollment_api_keys?${new URLSearchParams({ kuery: DEFAULT_POLICY_IDS[0] }).toString()}`,
      );
      expect(keys.body.items[0].api_key).toBe(DEFAULT_ENROLLMENT_TOKEN);
      const agents = await fleet(
        ctx.app,
        "GET",
        `/agents?${new URLSearchParams({ kuery: `policy_id:${DEFAULT_POLICY_IDS[0]}` }).toString()}`,
      );
      expect(agents.body.items.map((agent: any) => agent.local_metadata.host.hostname)).toEqual([
        "soc-collector-01",
        "soc-collector-02",
      ]);
      expect(agents.body.items[0]).toMatchObject({ active: true, status: "online", policy_id: DEFAULT_POLICY_IDS[0] });
      const degraded = await fleet(
        ctx.app,
        "GET",
        `/agents?${new URLSearchParams({ kuery: "status:degraded" }).toString()}`,
      );
      expect(degraded.body.items.map((agent: any) => agent.local_metadata.host.hostname)).toEqual(["ACME-DC-02"]);
      const status = await fleet(ctx.app, "GET", "/agent_status?policyId=00000000-0000-4000-8000-00000000e101");
      expect(status.body.results).toMatchObject({ total: 2, online: 1, error: 1 });
    });

    it("enrolls agents through the simulator and unenrolls them", async () => {
      const enrolled = await call(
        ctx.app,
        "POST",
        "/_elastic/simulate/enroll",
        { enrollmentToken: DEFAULT_ENROLLMENT_TOKEN, hostname: "soc-collector-03", os: "linux" },
        {},
        null,
      );
      expect(enrolled.status).toBe(201);
      expect(enrolled.body.item).toMatchObject({ policy_id: DEFAULT_POLICY_IDS[0], status: "online" });
      const checkin = await call(
        ctx.app,
        "POST",
        "/_elastic/simulate/checkin",
        { hostname: "soc-collector-03", status: "degraded" },
        {},
        null,
      );
      expect(checkin.body.item.status).toBe("degraded");
      expect((await fleet(ctx.app, "GET", `/agent_policies/${DEFAULT_POLICY_IDS[0]}`)).body.item.agents).toBe(3);
      expect((await fleet(ctx.app, "POST", `/agents/${enrolled.body.item.id}/unenroll`, { revoke: true })).status).toBe(
        200,
      );
      expect((await fleet(ctx.app, "GET", `/agents/${enrolled.body.item.id}`)).body.item.status).toBe("unenrolled");
      expect((await fleet(ctx.app, "GET", `/agent_policies/${DEFAULT_POLICY_IDS[0]}`)).body.item.agents).toBe(2);
      expect(
        (await call(ctx.app, "POST", "/_elastic/simulate/enroll", { enrollmentToken: "nope", hostname: "x" }, {}, null))
          .status,
      ).toBe(404);
    });
  });

  describe("Elasticsearch (CyberHub queries)", () => {
    it("answers the product check and the status monitoring query", async () => {
      const root = await call(ctx.app, "GET", "/");
      expect(root.headers.get("x-elastic-product")).toBe("Elasticsearch");
      expect(root.body).toMatchObject({ cluster_name: "emulate-cluster", tagline: "You Know, for Search" });
      expect(root.body.version.number).toMatch(/^9\./);
      const status = await call(ctx.app, "POST", `/${DEFAULT_STATUS_INDEX}/_search`, {
        size: 1,
        query: {
          bool: { filter: [{ term: { service: "o365" } }, { term: { integration_id: DEFAULT_O365_INTEGRATION_ID } }] },
        },
        sort: [{ "@timestamp": { order: "desc" } }],
      });
      expect(status.status).toBe(200);
      expect(status.headers.get("x-elastic-product")).toBe("Elasticsearch");
      expect(status.body.hits.total).toEqual({ value: 2, relation: "eq" });
      expect(status.body.hits.hits).toHaveLength(1);
      expect(status.body.hits.hits[0]._source).toMatchObject({
        status: "operational",
        service: "o365",
        integration_id: DEFAULT_O365_INTEGRATION_ID,
        namespace: DEFAULT_CUSTOMER_NAMESPACE,
      });
      const defender = await call(ctx.app, "POST", `/${DEFAULT_STATUS_INDEX}/_search`, {
        size: 1,
        query: {
          bool: {
            filter: [
              { term: { service: "m365_defender" } },
              { term: { integration_id: DEFAULT_DEFENDER_INTEGRATION_ID } },
            ],
          },
        },
      });
      expect(defender.body.hits.hits[0]._source.status).toBe("consent_required");
      const none = await call(ctx.app, "POST", `/${DEFAULT_STATUS_INDEX}/_search`, {
        size: 1,
        query: { bool: { filter: [{ term: { integration_id: "missing" } }] } },
      });
      expect(none.body.hits.hits).toEqual([]);
      const missingIndex = await call(ctx.app, "POST", "/no-such-index/_search", { query: { match_all: {} } });
      expect(missingIndex.status).toBe(404);
      expect(missingIndex.body.error.type).toBe("index_not_found_exception");
    });

    it("runs the Office 365 report aggregations", async () => {
      const range = { gte: new Date(Date.now() - 30 * 86400000).toISOString(), lte: new Date().toISOString() };
      const topDomain = await call(ctx.app, "POST", `/${DEFAULT_O365_INDEX}/_search`, {
        size: 0,
        query: {
          bool: {
            filter: [
              { terms: { "cyna.msp__customer": [DEFAULT_CUSTOMER_NAMESPACE] } },
              { range: { "@timestamp": range } },
            ],
            must_not: [{ wildcard: { "user.domain": "*onmicrosoft.com*" } }],
          },
        },
        aggs: { top_domain: { terms: { field: "user.domain", size: 1 } } },
      });
      expect(topDomain.status).toBe(200);
      expect(topDomain.body.hits.hits).toEqual([]);
      expect(topDomain.body.hits.total.value).toBeGreaterThan(0);
      expect(topDomain.body.aggregations.top_domain.buckets[0].key).toBe("acme-corp.example");
      const unique = await call(ctx.app, "POST", `/${DEFAULT_O365_INDEX}/_search`, {
        size: 0,
        query: {
          bool: {
            filter: [
              { terms: { "cyna.msp__customer": [DEFAULT_CUSTOMER_NAMESPACE] } },
              { range: { "@timestamp": range } },
              { wildcard: { "user.email": "*@acme-corp.example" } },
            ],
          },
        },
        aggs: { unique_count: { cardinality: { field: "user.email" } } },
      });
      expect(unique.body.aggregations.unique_count.value).toBe(4);
      const otherTenant = await call(ctx.app, "POST", `/${DEFAULT_O365_INDEX}/_search`, {
        size: 0,
        query: { bool: { filter: [{ terms: { "cyna.msp__customer": ["other"] } }] } },
        aggs: { unique_count: { cardinality: { field: "user.email" } } },
      });
      expect(otherTenant.body.aggregations.unique_count.value).toBe(0);
      const alias = await call(ctx.app, "GET", "/logs-o365.audit/_count");
      expect(alias.body.count).toBeGreaterThan(0);
    });

    it("runs the firewall report aggregations with missing buckets and nested cardinality", async () => {
      const response = await call(ctx.app, "POST", `/${DEFAULT_FIREWALL_INDEX}/_search`, {
        size: 0,
        query: {
          bool: {
            filter: [
              { terms: { "cyna.msp__customer": [DEFAULT_CUSTOMER_NAMESPACE] } },
              { range: { "@timestamp": { gte: "now-30d", lte: "now" } } },
            ],
            must_not: [{ exists: { field: "cyna.parse_error" } }],
          },
        },
        aggs: {
          firewalls_by_tech: {
            terms: { field: "cyna.firewall_tech", size: 50 },
            aggs: { identifiers: { cardinality: { field: "cyna.firewall_identifier" } } },
          },
          firewalls_without_tech: {
            missing: { field: "cyna.firewall_tech" },
            aggs: { identifiers: { cardinality: { field: "cyna.firewall_identifier" } } },
          },
        },
      });
      expect(response.status).toBe(200);
      expect(response.body.hits.total.value).toBe(12);
      expect(response.body.aggregations.firewalls_by_tech.buckets).toEqual([
        { key: "fortinet", doc_count: 8, identifiers: { value: 2 } },
        { key: "stormshield", doc_count: 4, identifiers: { value: 1 } },
      ]);
      expect(response.body.aggregations.firewalls_without_tech).toEqual({ doc_count: 0, identifiers: { value: 0 } });
      const withErrors = await call(ctx.app, "POST", `/${DEFAULT_FIREWALL_INDEX}/_search`, {
        size: 0,
        query: { match_all: {} },
        aggs: { firewalls_without_tech: { missing: { field: "cyna.firewall_tech" } } },
      });
      expect(withErrors.body.aggregations.firewalls_without_tech.doc_count).toBe(1);
    });

    it("indexes, bulk loads, updates, deletes, and paginates documents", async () => {
      const created = await call(ctx.app, "PUT", "/custom-index/_doc/1", {
        name: "one",
        value: 10,
        "@timestamp": "2026-09-01T00:00:00Z",
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ _index: "custom-index", _id: "1", result: "created" });
      expect((await call(ctx.app, "PUT", "/custom-index/_doc/1", { name: "one", value: 11 })).body.result).toBe(
        "updated",
      );
      expect((await call(ctx.app, "PUT", "/custom-index/_create/1", { name: "dup" })).status).toBe(409);
      const bulk = await call(
        ctx.app,
        "POST",
        "/_bulk",
        [
          '{"index":{"_index":"custom-index","_id":"2"}}',
          '{"name":"two","value":20}',
          '{"create":{"_index":"custom-index","_id":"3"}}',
          '{"name":"three","value":30}',
          '{"update":{"_index":"custom-index","_id":"2"}}',
          '{"doc":{"value":21}}',
          '{"delete":{"_index":"custom-index","_id":"3"}}',
          "",
        ].join("\n"),
        { "Content-Type": "application/x-ndjson" },
      );
      expect(bulk.status).toBe(200);
      expect(bulk.body.errors).toBe(false);
      expect(bulk.body.items.map((item: any) => Object.keys(item)[0])).toEqual(["index", "create", "update", "delete"]);
      const search = await call(ctx.app, "POST", "/custom-index/_search", {
        query: { range: { value: { gte: 11 } } },
        sort: [{ value: "desc" }],
        _source: ["name"],
      });
      expect(search.body.hits.hits.map((hit: any) => hit._source)).toEqual([{ name: "two" }, { name: "one" }]);
      const paged = await call(ctx.app, "GET", "/custom-index/_search?size=1&from=1&sort=value:asc");
      expect(paged.body.hits.hits[0]._id).toBe("2");
      expect((await call(ctx.app, "GET", "/custom-index/_doc/1")).body._source.value).toBe(11);
      expect((await call(ctx.app, "GET", "/custom-index/_doc/404")).status).toBe(404);
      expect((await call(ctx.app, "POST", "/custom-index/_update/1", { doc: { value: 12 } })).body.result).toBe(
        "updated",
      );
      expect((await call(ctx.app, "DELETE", "/custom-index/_doc/1")).body.result).toBe("deleted");
      expect((await call(ctx.app, "GET", "/custom-index/_count")).body.count).toBe(1);
      const cat = await call(ctx.app, "GET", "/_cat/indices?format=json");
      expect(cat.body.find((row: any) => row.index === "custom-index")["docs.count"]).toBe("1");
      expect((await call(ctx.app, "GET", "/_cluster/health")).body.status).toBe("green");
      expect((await call(ctx.app, "DELETE", "/custom-index")).body.acknowledged).toBe(true);
      expect((await call(ctx.app, "GET", "/custom-index/_search")).status).toBe(404);
      const badQuery = await call(ctx.app, "POST", `/${DEFAULT_STATUS_INDEX}/_search`, { query: { nope: {} } });
      expect(badQuery.status).toBe(400);
    });

    it("supports match, prefix, should, and date histogram queries plus the simulators", async () => {
      const match = await call(ctx.app, "POST", `/${DEFAULT_O365_INDEX}/_search`, {
        size: 50,
        query: {
          bool: {
            should: [{ match: { "event.action": "UserLoggedIn" } }, { prefix: { "user.name": "bo" } }],
            minimum_should_match: 1,
          },
        },
      });
      expect(match.body.hits.total.value).toBeGreaterThan(1);
      const histogram = await call(ctx.app, "POST", `/${DEFAULT_O365_INDEX}/_search`, {
        size: 0,
        aggs: {
          per_day: {
            date_histogram: { field: "@timestamp", calendar_interval: "1d" },
            aggs: { failures: { filter: { term: { "event.outcome": "failure" } } } },
          },
        },
      });
      expect(histogram.body.aggregations.per_day.buckets.length).toBeGreaterThan(1);
      const simulated = await call(
        ctx.app,
        "POST",
        "/_elastic/simulate/service-status",
        { integrationId: DEFAULT_O365_INTEGRATION_ID, service: "o365", status: "errors_only" },
        {},
        null,
      );
      expect(simulated.status).toBe(201);
      const latest = await call(ctx.app, "POST", `/${DEFAULT_STATUS_INDEX}/_search`, {
        size: 1,
        query: {
          bool: { filter: [{ term: { service: "o365" } }, { term: { integration_id: DEFAULT_O365_INTEGRATION_ID } }] },
        },
        sort: [{ "@timestamp": { order: "desc" } }],
      });
      expect(latest.body.hits.hits[0]._source.status).toBe("errors_only");
      const documents = await call(
        ctx.app,
        "POST",
        "/_elastic/simulate/documents",
        {
          index: "logs-custom-default",
          documents: [{ message: "hello", "cyna.msp__customer": "x" }, { message: "world" }],
        },
        {},
        null,
      );
      expect(documents.body.indexed).toBe(2);
      expect((await call(ctx.app, "GET", "/logs-custom-default/_count")).body.count).toBe(2);
      for (const tab of ["policies", "integrations", "agents", "indices", "events", "auth"]) {
        const page = await ctx.app.request(`${baseUrl}/_elastic?tab=${tab}`);
        expect(page.status).toBe(200);
        expect(await page.text()).toContain("Elastic");
      }
      expect((await ctx.app.request(`${baseUrl}/_elastic/events`, { method: "DELETE" })).status).toBe(200);
    });

    it("seeds custom policies and indices without defaults", async () => {
      const custom = createApp(
        {
          api_keys: [{ id: "k", api_key: "secret" }],
          agent_policies: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              name: "Pool 1",
              enrollment_token: "tok-1",
              agents: [{ hostname: "c1" }],
            },
          ],
          indices: [
            {
              name: "services-monitoring",
              documents: [
                {
                  "@timestamp": "2026-09-01T00:00:00Z",
                  integration_id: "abc",
                  service: "system",
                  status: "operational",
                },
              ],
            },
          ],
        },
        false,
      );
      expect(getEsStore(custom.store).agentPolicies.count()).toBe(1);
      const policies = await call(custom.app, "GET", "/api/fleet/agent_policies", undefined, {}, "ApiKey secret");
      expect(policies.body.items[0]).toMatchObject({ id: "11111111-1111-4111-8111-111111111111", agents: 1 });
      const status = await call(
        custom.app,
        "POST",
        "/services-monitoring/_search",
        { query: { term: { integration_id: "abc" } } },
        {},
        "ApiKey secret",
      );
      expect(status.body.hits.hits[0]._source.status).toBe("operational");
      expect(
        (await call(custom.app, "GET", "/api/fleet/agent_policies", undefined, {}, `ApiKey ${DEFAULT_API_KEY}`)).status,
      ).toBe(401);
    });
  });
});
