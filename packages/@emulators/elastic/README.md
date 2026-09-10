# @emulators/elastic

Stateful Kibana Fleet and Elasticsearch emulator plugin for [emulate](https://github.com/vercel-labs/emulate).

## Features

- Kibana Fleet API under `/api/fleet`: agent policies (with `sys_monitoring` default package policy and `global_data_tags`), package policies (409 on duplicate names, object and array `inputs`), agents with kuery filtering and status summary, enrollment API keys, fleet server hosts, EPM package lookup, and setup
- Elasticsearch REST API at the root: product check with `X-Elastic-Product`, `_search` with bool queries (`term`, `terms`, `range` with date math, `wildcard`, `prefix`, `exists`, `match`, `query_string`, and more), sort, paging, `_source` filtering, and aggregations (`terms`, `cardinality`, `missing`, `filter`, `filters`, metrics, `date_histogram`, `top_hits`), `_count`, `_doc`, `_create`, `_update`, `_bulk`, index CRUD with aliases and wildcards, `_cat/indices`, `_cluster/health`, `_security/_authenticate`
- `ApiKey` (raw or base64 `id:key`) and `Basic` authentication, `kbn-xsrf` enforcement on Fleet writes, Kibana and Elasticsearch error shapes
- Simulator for enrolling agents, check-ins, indexing documents, and integration status changes; event log; tabbed inspector at `/_elastic`

## Usage

```typescript
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { elasticPlugin, seedFromConfig } from "@emulators/elastic";

const app = new Hono();
const store = new Store();
const baseUrl = "http://localhost:4022";

elasticPlugin.register(app, store, new WebhookDispatcher(), baseUrl);
elasticPlugin.seed?.(store, baseUrl);
seedFromConfig(store, baseUrl, {
  agent_policies: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Customer A",
      package_policies: [{ name: "O365_CUSTOMER-A", package: "o365", version: "3.8.1" }],
    },
  ],
  indices: [
    {
      name: "services-monitoring",
      documents: [
        { "@timestamp": "2026-09-01T00:00:00Z", integration_id: "abc", service: "o365", status: "operational" },
      ],
    },
  ],
});
```

## Defaults

- API key `test_emulate_elastic_api_key` (id `emulate-elastic-key`); the Elasticsearch client form is `base64("emulate-elastic-key:test_emulate_elastic_api_key")`
- Five pooled agent policies `00000000-0000-4000-8000-00000000e001` to `...e005`, an Active Directory policy with two Windows agents, fleet server host `fleet-default-fleet-server-host`
- Indices `services-monitoring`, `logs-o365.audit-default` (alias `logs-o365.audit`), and `logs-firewall.log-default` (alias `logs-firewall.log`)

See the main [emulate README](https://github.com/vercel-labs/emulate#elastic-fleet-and-elasticsearch) for the full route list.
