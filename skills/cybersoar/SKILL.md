---
name: cybersoar
description: Emulated CyberSOAR incident API for local development and testing. Use when the user needs SOC alerts for a customer namespace, closed alerts with TP or FP verdicts in a date range, paged incident alert feeds with nextPage, or wants to simulate alert creation and closure without the real CyberSOAR backend. Triggers include "CyberSOAR", "incidents/alerts", "SOC alerts", "security report alerts", "MAIL_SENT", "verdict", "ingestAt", or any task requiring a local incident alert API.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(curl:*)
---

# CyberSOAR API Emulator

Fully stateful emulation of the CyberSOAR incident alert feed. Alerts belong to customers under an MSP, carry a service, criticity, status, verdict, and tags, and are filtered and paged exactly like the real `GET /incidents/alerts` endpoint. Cases are derived from shared `caseId` values.

Nothing leaves the machine.

## Start

```bash
# CyberSOAR only
npx emulate --service cybersoar

# Default port (when run alone)
# http://localhost:4000
```

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const cybersoar = await createEmulator({ service: 'cybersoar', port: 4000 })
// cybersoar.url === 'http://localhost:4000'
```

## Configure Your App

```bash
CYBERSOAR_URL=http://localhost:4000
CYBERSOAR_API_KEY=test_emulate_cybersoar_api_key
```

## Seeded Data

| Item | Value |
|------|-------|
| API key | `test_emulate_cybersoar_api_key` |
| Customers | Acme Corp and Globex Industries (MSP Nimbus MSP), Initech (MSP Direct) |
| Namespaces | `Nimbus MSP:Acme Corp` and `nimbus-msp:acme-corp` both match Acme Corp |
| Generated alerts | 60 for Acme Corp over 120 days, 25 for Globex, 15 for Initech, deterministic ids `aNNN0000-0000-4000-8000-...` |
| Fixed alerts | `a0000000-0000-4000-8000-00000000f101` closed TP with `MAIL_SENT`, `...f102` closed FP, `...f103` waiting analyst |

## Common Tasks

### Fetch closed alerts for a report window

```bash
curl -G http://localhost:4000/incidents/alerts \
  -H "Authorization: ApiKey test_emulate_cybersoar_api_key" \
  --data-urlencode 'name="Nimbus MSP:Acme Corp"' \
  --data-urlencode 'status=CLOSED' \
  --data-urlencode 'ingestAt.gt=2026-06-01T00:00:00.000Z' \
  --data-urlencode 'ingestAt.lt=2026-09-01T00:00:00.000Z' \
  --data-urlencode 'pageSize=100'
```

Follow `meta.nextPage` by passing it as `pageIndex` until it disappears. `meta.count` is the total across pages.

### Filter by service or verdict

```bash
curl -G http://localhost:4000/incidents/alerts -H "Authorization: ApiKey test_emulate_cybersoar_api_key" \
  --data-urlencode 'service=FIREWALL' --data-urlencode 'verdict=TP,FP'
```

### Create alerts

```bash
curl -X POST http://localhost:4000/_cybersoar/simulate/alert -H "Content-Type: application/json" \
  -d '{"customer":"Acme Corp","msp":"Nimbus MSP","service":"ACTIVE_DIRECTORY","ruleName":"Account added to Domain Admins","criticity":4,"count":3}'
```

Or through the API with `POST /incidents/alerts` and an `ApiKey` header.

### Close an alert with a verdict

```bash
curl -X POST http://localhost:4000/_cybersoar/simulate/close -H "Content-Type: application/json" \
  -d '{"id":"a0000000-0000-4000-8000-00000000f103","verdict":"TP","notify":true}'
```

`notify: true` adds the `MAIL_SENT` tag, which report code uses to compute the share of silently handled alerts.

### Cases and stats

```bash
curl "http://localhost:4000/incidents/cases?name=nimbus-msp:acme-corp" -H "Authorization: ApiKey test_emulate_cybersoar_api_key"
curl "http://localhost:4000/incidents/alerts/stats?name=nimbus-msp:acme-corp" -H "Authorization: ApiKey test_emulate_cybersoar_api_key"
```

## Inspector

Open `http://localhost:4000/` for alerts, cases, customers, events, and auth tabs.

## Limits

No analyst workflows (assignments, comments, playbooks), no case creation endpoints, and API key authentication only.
