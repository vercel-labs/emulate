---
name: sentinelone
description: Emulated SentinelOne management console API for local development and testing. Use when the user needs to create SentinelOne accounts, sites, groups, or filters, list agents per site, count licenses, provision users with scope roles, mitigate threats, read application risks and CVEs, manage exclusions, blocklists, or device control, or run agent actions without a real SentinelOne console. Triggers include "SentinelOne API", "S1", "emulate SentinelOne", "web/api/v2.1", "ApiToken", "SENTINELONE_API_KEY", "S1 site", "scopeRoles", "application-management/risks", or any task requiring a local SentinelOne API.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(curl:*)
---

# SentinelOne API Emulator

Fully stateful SentinelOne management console emulation. Accounts own sites, sites own groups and agents, filters drive dynamic groups, users carry scope roles referencing RBAC roles, threats move through mitigation and incident workflows, application risks track CVEs per endpoint, and exclusions, blocklists, and device control rules attach to any scope. Policies inherit global, account, site, then group.

Nothing leaves the machine. Every console API call hits the emulator and produces SentinelOne-shaped `{ data, pagination }` responses.

## Start

```bash
# SentinelOne only
npx emulate --service sentinelone

# Default port (when run alone)
# http://localhost:4000
```

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const sentinelone = await createEmulator({ service: 'sentinelone', port: 4000 })
// sentinelone.url === 'http://localhost:4000'
```

## Defaults

```text
SENTINELONE_URL=http://localhost:4000
SENTINELONE_BASE_API_ENDPOINT=/web/api
SENTINELONE_VERSION=v2.1
SENTINELONE_API_KEY=test_emulate_sentinelone_api_token
SENTINELONE_ACCOUNT_ID=2250000000000000001
SENTINELONE_SITE_ID=2250000000000000101
```

Seeded data:

- Account "EMULATE MSSP" (`2250000000000000001`, mssp, complete bundle)
- Site "ACME CORP" (`2250000000000000101`, external id `11111111-1111-4111-8111-111111111111`) with dynamic groups `Windows-Workstations`, `Windows-Servers`, `Linux-Workstations`, `Linux-Servers`, `MacOS-Workstations` and agents `ACME-WS-001` (Windows 11 laptop), `ACME-SRV-FILES` (Windows Server 2022, unmitigated `mimikatz.exe`), `ACME-MBP-CAROL` (macOS, resolved `eicar.com`), `acme-ubuntu-01` (Ubuntu server), `ACME-OLD-KIOSK` (offline, migration pending)
- Trial site "GLOBEX #TRIAL" (`2250000000000000102`, 25 licenses) with one agent
- Five CVEs across Chrome, 7-Zip, Windows Server 2022, and OpenSSL
- Sixteen RBAC roles: predefined Admin, Viewer, IT, SOC, IR Team, C-Level, plus MSP Admin, MSP Tech, MSP Viewer, EDR Admin (account scope) and Customer Admin, Customer Tech, Customer Viewer, SOC N1, SOC N2, SOC N3 (site scope)
- Users `admin@example.com` (tenant, owns the default API token), `msp.admin@example.com`, `analyst@example.com` (SOC N1 on ACME CORP), `customer.admin@acme.example`

## Authentication and Conventions

```bash
curl -H "Authorization: ApiToken test_emulate_sentinelone_api_token" \
  http://localhost:4000/web/api/v2.1/system/info
```

Routes live under `/web/api/v2.1` and `/web/api/v2.0`. Lists return `{ data, pagination: { nextCursor, totalItems } }`; page with `limit` (default 10, max 1000), `cursor`, or `skip`, use `countOnly=true` for totals only, `skipCount=true` to skip counting, and `sortBy` plus `sortOrder`. Id filters take comma separated values. Writes take `{ data }`, bulk actions take `{ filter, data }` and return `{ data: { affected } }`. Errors are `{ errors: [{ code, detail, title }] }` with codes 4000010 (validation), 4000030 (already exists), 4010010 (unauthorized), 4040010 (not found).

## Agents

```bash
# All agents of a site (paginate with pagination.nextCursor)
curl -H "Authorization: ApiToken test_emulate_sentinelone_api_token" \
  "http://localhost:4000/web/api/v2.1/agents?siteIds=2250000000000000101&limit=1000"

# License count
curl -H "Authorization: ApiToken test_emulate_sentinelone_api_token" \
  "http://localhost:4000/web/api/v2.1/agents?siteIds=2250000000000000101&countOnly=true"

# Decommission
curl -X POST -H "Authorization: ApiToken test_emulate_sentinelone_api_token" -H "Content-Type: application/json" \
  http://localhost:4000/web/api/v2.1/agents/actions/decommission \
  -d '{ "filter": { "ids": ["2250000000000002001"], "siteIds": ["2250000000000000101"], "migrationStatus": "N/A" } }'
```

Filters: `siteIds`, `accountIds`, `groupIds`, `ids`, `uuids`, `consoleMigrationStatuses`, `computerName__contains`, `query`, `osTypes`, `machineTypes`, `isActive`, `infected`, `isDecommissioned`, `networkStatuses`, `scanStatuses`, `activeThreats__gt`, `lastActiveDate__gt`, `agentVersion__gte`. Also `GET /agents/count`, `GET /agents/passphrases?ids=`, `GET /agents/{id}`, and actions `recommission`, `initiate-scan`, `abort-scan`, `disconnect`, `connect`, `fetch-logs`, `restart-machine`, `shutdown`, `uninstall`, `approve-uninstall`, `update-software`, `set-external-id`, `move-to-site` (`data.targetSiteId`), `move-to-group`. Agents expose `osType`, `osName`, `osRevision`, `machineType`, `agentVersion`, `lastActiveDate`, `consoleMigrationStatus`, `siteName`, `accountName`, `uuid`, and the other console fields.

## Accounts, Sites, Groups, Filters

```bash
# Create an MSSP account (duplicate names return code 4000030)
curl -X POST -H "Authorization: ApiToken test_emulate_sentinelone_api_token" -H "Content-Type: application/json" \
  http://localhost:4000/web/api/v2.1/accounts -d '{ "data": {
    "name": "EDR-NIMBUS", "accountType": "Trial", "usageType": "mssp", "billingMode": "consumption",
    "unlimitedExpiration": true, "inherits": false,
    "licenses": { "bundles": [{ "name": "complete", "surfaces": [{ "name": "Total Agents", "count": -1 }] }], "modules": [{ "name": "rogues" }], "settings": [] },
    "policy": { "mitigationMode": "protect", "engines": { "penetration": "on" } } } }'

# Create a site under it, then its filters and dynamic groups
curl -X POST -H "Authorization: ApiToken test_emulate_sentinelone_api_token" -H "Content-Type: application/json" \
  http://localhost:4000/web/api/v2.1/sites -d '{ "data": { "name": "NIMBUS CLIENT #REF42", "siteType": "Trial", "accountId": "<accountId>", "externalId": "<customer id>", "unlimitedExpiration": false, "expiration": "2027-01-01T00:00:00.000Z", "unlimitedLicenses": true, "inherits": true } }'
curl -X POST -H "Authorization: ApiToken test_emulate_sentinelone_api_token" -H "Content-Type: application/json" \
  http://localhost:4000/web/api/v2.1/filters -d '{ "data": { "name": "Windows-Servers", "filterFields": { "machineTypes": ["server"], "osTypes": ["windows"] } }, "filter": { "siteIds": "<siteId>" } }'
curl -X POST -H "Authorization: ApiToken test_emulate_sentinelone_api_token" -H "Content-Type: application/json" \
  http://localhost:4000/web/api/v2.1/groups -d '{ "data": { "inherits": true, "name": "Windows-Servers", "siteId": "<siteId>", "filterId": "<filterId>" } }'
```

- `GET /accounts`, `GET|PUT|DELETE /accounts/{id}`, `GET|PUT /accounts/{id}/policy`, `PUT .../revert-policy`
- `GET /sites` returns `{ data: { allSites, sites }, pagination }` with filters `accountId`, `siteIds`, `states`, `name`, `name__contains`, `siteType`, `externalId`; `GET|PUT|DELETE /sites/{id}`, `PUT /sites/{id}/reactivate`, `GET|PUT /sites/{id}/policy`, `PUT .../revert-policy`
- `GET|POST /groups`, `GET|PUT|DELETE /groups/{id}`, `GET|PUT /groups/{id}/policy`, `PUT .../revert-policy`, `PUT .../move-agents`, `GET .../agents`; `GET|POST /filters`, `GET|PUT|DELETE /filters/{id}`

Sites get a default group and a registration token on creation. Agents land in the first dynamic group whose filter matches their `machineType` and `osType`. Policies inherit global, account, site, group and report `inheritedFrom`.

## Users and Roles

```bash
curl -H "Authorization: ApiToken test_emulate_sentinelone_api_token" \
  "http://localhost:4000/web/api/v2.1/users?email=analyst%40example.com"
curl -X POST -H "Authorization: ApiToken test_emulate_sentinelone_api_token" -H "Content-Type: application/json" \
  http://localhost:4000/web/api/v2.1/users -d '{ "data": { "email": "bob@acme.example", "fullName": "Bob Builder", "scope": "site", "scopeRoles": [{ "id": "2250000000000000101", "roleId": "2250000000000009202" }] } }'
```

- `GET /users` (`email`, `email__contains`, `siteIds`, `accountIds`, `roleIds`, `query`), `GET|PUT|DELETE /users/{id}`; `PUT` replaces `scope` and `scopeRoles`
- `POST /users/onboarding/send-verification-email`, `POST /users/login/send-reset-password-email` (`{ filter: { ids } }`), `POST /users/reset-2fa`, `POST /users/enroll-2fa` (`{ data: { ids } }`), `POST /users/generate-api-token` (returns `{ data: { token } }` bound to the caller), `GET /user`
- `GET /rbac/roles?siteIds=` (raise `limit`, the default page is 10), `POST /rbac/role`, `GET|DELETE /rbac/role/{id}`

Seed `roles` with explicit `id` values when your application hard codes SentinelOne role ids.

## Threats and Application Risks

```bash
# Per severity vulnerability counts for a report
for s in CRITICAL HIGH MEDIUM LOW; do
  curl -s -H "Authorization: ApiToken test_emulate_sentinelone_api_token" \
    "http://localhost:4000/web/api/v2.1/application-management/risks/applications?siteIds=2250000000000000101&countOnly=true&highestSeverities=$s"
done

# CVE feed the way a vulnerabilities cron reads it
curl -H "Authorization: ApiToken test_emulate_sentinelone_api_token" \
  "http://localhost:4000/web/api/v2.1/application-management/risks?analystVerdict=Added%20CVE,Default&siteIds=2250000000000000101&limit=1000&skipCount=true&sortBy=detectionDate&sortOrder=asc"
```

- `GET /threats` (`siteIds`, `resolved`, `incidentStatuses`, `mitigationStatuses`, `countOnly`), `GET /threats/{id}`, `GET .../timeline`, `POST /threats/mitigate/{kill|quarantine|remediate|rollback-remediation|un-quarantine|network-quarantine}`, `POST /threats/incident`, `analyst-verdict`, `mark-as-benign`, `mark-as-threat`, `notes`
- `GET /application-management/risks/applications`, `GET /application-management/risks`, `GET .../risks/{id}`, `POST .../risks/analyst-verdict`, `GET .../inventory/endpoints`

## Exclusions, Blocklist, Device Control

- `GET|POST|DELETE /exclusions`, `DELETE /exclusions/{id}`, `GET|POST|DELETE /unified-exclusions` (`data.exclusionName`, `threatType`, `interactionLevel`, `reason`, `modeType`; delete with `{ data: { data: { exclusions: [{ id, type }] } } }`)
- `GET|POST|DELETE /restrictions` (`black_hash` needs a SHA1 `value` or `sha256Value`)
- `GET|POST|DELETE /device-control`, `PUT /device-control/{id}`, `PUT /device-control/enable|disable`

Scope with `filter.siteIds`, `filter.accountIds`, `filter.groupIds`, or `filter.scopeLevel` and `filter.scopeLevelId`. Duplicates in a scope return 4000030.

## Simulator, Activities, Inspector

- `POST /_sentinelone/simulate/agent` `{ registrationToken | siteId | siteName, computerName, osType, machineType, ... }` registers an agent (license limits apply)
- `POST /_sentinelone/simulate/agent-checkin` `{ agentId | computerName, lastActiveDate, agentVersion, isActive }`
- `POST /_sentinelone/simulate/threat` `{ agentId | computerName, threatName, confidenceLevel, mitigationStatus }`
- `POST /_sentinelone/simulate/vulnerability` `{ agentId | computerName, cveId, application, applicationVersion, baseScore }`
- `GET /activities?siteIds=`, `GET /system/info`, `GET /_sentinelone/events?type=site.created`, `DELETE /_sentinelone/events`
- `GET /` inspector tabs: accounts and sites, agents, threats, vulnerabilities, users and roles, exclusions, activities, events, auth

## Seed Configuration

```json
{
  "sentinelone": {
    "api_tokens": [{ "token": "test_emulate_sentinelone_api_token", "user": "admin@example.com" }],
    "roles": [{ "id": "2153718167648641127", "name": "MSP Admin", "scope": "account" }, { "id": "2143855039033122024", "name": "SOC N1", "scope": "site" }],
    "accounts": [
      {
        "id": "2000000000000000001", "name": "CYNA PRO", "usageType": "mssp",
        "sites": [
          {
            "id": "2000000000000000101", "name": "CUSTOMER ONE #C1", "externalId": "customer-uuid",
            "filters": [{ "name": "Windows-Servers", "machineTypes": ["server"], "osTypes": ["windows"] }],
            "groups": [{ "name": "Windows-Servers", "filter": "Windows-Servers" }],
            "agents": [{ "computerName": "c1-srv-01", "osType": "windows", "machineType": "server", "threats": [{ "threatName": "mimikatz.exe" }], "applications": [{ "name": "Google Chrome", "version": "124.0.6367.60", "cves": [{ "cveId": "CVE-2024-4947", "baseScore": 8.8 }] }] }]
          }
        ]
      }
    ],
    "users": [{ "email": "pro.admin@example.com", "fullName": "Pro Admin", "scope": "account", "scopeRoles": [{ "account": "CYNA PRO", "roleId": "2153718167648641127" }] }]
  }
}
```

Also supported: `tenant`, `global_policy`, per account `licenses` and `policy`, per site `registrationToken`, `expiration`, `unlimitedLicenses`, `totalLicenses`, `policy`, and per agent `osName`, `osRevision`, `agentVersion`, `isActive`, `lastActiveDate`, `consoleMigrationStatus`, `group`, `tags`. Seeding is idempotent by id, name, or email.

## Limits

Deep Visibility and Power Query, remote shell sessions, remote scripts, the Ranger network inventory, Singularity Identity, firewall control rules, agent package downloads, notifications and webhook syslog, and the Graph API are not implemented.
