---
name: elastic
description: Emulated Kibana Fleet API and Elasticsearch REST API for local development and testing. Use when the user needs to create or delete Fleet agent policies and package policies (integrations), read enrollment tokens and fleet server hosts, list agents, or run Elasticsearch searches with bool queries and aggregations against seeded indices without a real Elastic deployment. Triggers include "Elastic", "Elasticsearch", "Kibana", "Fleet", "agent policy", "package policy", "enrollment token", "_search", "aggregations", "services-monitoring", or any task requiring a local Elastic stack.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(curl:*)
---

# Elastic Fleet and Elasticsearch Emulator

Fully stateful emulation of the two Elastic surfaces an integration platform talks to. Kibana Fleet routes live under `/api/fleet` and behave like Fleet (409 on duplicate integration names, the default `system` package policy on `sys_monitoring=true`, `{ item }` and `{ items, total, page, perPage }` envelopes). Elasticsearch routes live at the root so the official client connects with `node` and an `apiKey` unchanged, and `_search` evaluates bool queries and aggregations against in-memory documents.

Nothing leaves the machine.

## Start

```bash
# Elastic only
npx emulate --service elastic

# Default port (when run alone)
# http://localhost:4000
```

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const elastic = await createEmulator({ service: 'elastic', port: 4000 })
// elastic.url === 'http://localhost:4000'
```

## Configure Your App

```bash
ELASTIC_KIBANA_URL=http://localhost:4000/api
ELASTIC_KIBANA_API_KEY=test_emulate_elastic_api_key
ELASTICSEARCH_NODE=http://localhost:4000
ELASTICSEARCH_API_KEY=ZW11bGF0ZS1lbGFzdGljLWtleTp0ZXN0X2VtdWxhdGVfZWxhc3RpY19hcGlfa2V5
```

```typescript
import { Client } from '@elastic/elasticsearch'

const client = new Client({ node: process.env.ELASTICSEARCH_NODE, auth: { apiKey: process.env.ELASTICSEARCH_API_KEY } })
```

## Seeded Data

| Item | Value |
|------|-------|
| Kibana API key | `test_emulate_elastic_api_key` (id `emulate-elastic-key`) |
| Pooled agent policies | `00000000-0000-4000-8000-00000000e001` to `...e005` (`Cyna SOC collectors 1..5`) |
| Package policies on pool 1 | `O365_ACME-CORP` (o365 3.8.1, id `...f001`), `MS365_DEFENDER_ACME-CORP` (m365_defender 3.5.0, id `...f002`) |
| Enrollment token for pool 1 | `emulate-enrollment-token-pool-1` |
| Active Directory policy | `00000000-0000-4000-8000-00000000e101` "ACME-CORP Active Directory", agents `ACME-DC-01` (online) and `ACME-DC-02` (degraded) |
| Fleet server host | `fleet-default-fleet-server-host` with `https://fleet.emulate.local:8220` |
| Indices | `services-monitoring`, `logs-o365.audit-default` (alias `logs-o365.audit`), `logs-firewall.log-default` (alias `logs-firewall.log`) |

## Common Tasks

### Find or create an agent policy

```bash
curl "http://localhost:4000/api/fleet/agent_policies?kuery=ACME-CORP%20Active%20Directory" \
  -H "Authorization: ApiKey test_emulate_elastic_api_key"

curl -X POST "http://localhost:4000/api/fleet/agent_policies?sys_monitoring=true" \
  -H "Authorization: ApiKey test_emulate_elastic_api_key" -H "kbn-xsrf: true" -H "Content-Type: application/json" \
  -d '{"name":"NEWCO Active Directory","namespace":"default","monitoring_enabled":["logs","traces"],"inactivity_timeout":1209600,"is_protected":false}'
```

The response `item.package_policies` includes the auto-created `system` policy; delete it with `DELETE /api/fleet/package_policies/{id}` if your flow does.

### Create an integration (package policy)

```bash
curl -X POST http://localhost:4000/api/fleet/package_policies \
  -H "Authorization: ApiKey test_emulate_elastic_api_key" -H "kbn-xsrf: true" -H "Content-Type: application/json" \
  -d '{"name":"O365_NEWCO","policy_id":"00000000-0000-4000-8000-00000000e002","package":{"name":"o365","version":"3.8.1"},"inputs":{"o365-cel":{"enabled":true,"streams":{"o365.audit":{"enabled":true,"vars":{"azure_tenant_id":"22222222-2222-4222-8222-222222222222"}}}}}}'
```

A second POST with the same `name` returns 409, so the "find by name and reuse" fallback can be exercised.

### Enrollment command inputs

```bash
curl http://localhost:4000/api/fleet/agents/available_versions -H "Authorization: ApiKey test_emulate_elastic_api_key"
curl http://localhost:4000/api/fleet/fleet_server_hosts/fleet-default-fleet-server-host -H "Authorization: ApiKey test_emulate_elastic_api_key"
curl "http://localhost:4000/api/fleet/enrollment_api_keys?kuery=00000000-0000-4000-8000-00000000e001" -H "Authorization: ApiKey test_emulate_elastic_api_key"
```

### Integration status search

```bash
curl -X POST http://localhost:4000/services-monitoring/_search \
  -H "Authorization: ApiKey test_emulate_elastic_api_key" -H "Content-Type: application/json" \
  -d '{"size":1,"query":{"bool":{"filter":[{"term":{"service":"o365"}},{"term":{"integration_id":"00000000-0000-4000-8000-00000000f001"}}]}},"sort":[{"@timestamp":{"order":"desc"}}]}'
```

Change the status with `POST /_elastic/simulate/service-status` `{ "integrationId": "...", "service": "o365", "status": "errors_only" }`.

### Report aggregations

```bash
curl -X POST http://localhost:4000/logs-firewall.log/_search \
  -H "Authorization: ApiKey test_emulate_elastic_api_key" -H "Content-Type: application/json" \
  -d '{"size":0,"query":{"bool":{"filter":[{"terms":{"cyna.msp__customer":["nimbus-msp__acme-corp"]}},{"range":{"@timestamp":{"gte":"now-30d"}}}],"must_not":[{"exists":{"field":"cyna.parse_error"}}]}},"aggs":{"by_tech":{"terms":{"field":"cyna.firewall_tech"},"aggs":{"identifiers":{"cardinality":{"field":"cyna.firewall_identifier"}}}},"without_tech":{"missing":{"field":"cyna.firewall_tech"}}}}'
```

### Enroll and degrade agents

```bash
curl -X POST http://localhost:4000/_elastic/simulate/enroll -H "Content-Type: application/json" \
  -d '{"enrollmentToken":"emulate-enrollment-token-pool-1","hostname":"soc-collector-03","os":"linux"}'
curl -X POST http://localhost:4000/_elastic/simulate/checkin -H "Content-Type: application/json" \
  -d '{"hostname":"soc-collector-03","status":"degraded"}'
```

## Inspector

Open `http://localhost:4000/_elastic` for agent policies, integrations, agents, indices, events, and auth tabs. The root path answers as Elasticsearch, so the inspector is not at `/`.

## Limits

No scoring, analyzers, scripted fields, `_msearch`, scroll or point in time, `_update_by_query`, ILM, data stream management, Kibana saved objects, alerting, or the real Fleet Server check-in protocol.
