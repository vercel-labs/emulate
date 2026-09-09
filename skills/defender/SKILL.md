---
name: defender
description: Emulated Microsoft Defender for Endpoint (WDATP) API for local development and testing. Use when the user needs to list Defender machines per tenant, count onboarded devices, query alerts, vulnerabilities, software, or recommendations, run response actions, manage indicators, run advanced hunting KQL, or obtain Entra client_credentials tokens without a real Microsoft tenant. Triggers include "Defender for Endpoint", "MDE API", "api.securitycenter.microsoft.com", "WDATP", "emulate Defender", "onboardingStatus eq 'Onboarded'", "client_credentials token", "MS365_DEFENDER", "advanced hunting", or any task requiring a local Defender API.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(curl:*)
---

# Microsoft Defender for Endpoint API Emulator

Fully stateful Defender for Endpoint emulation. Tokens are issued per tenant with the Entra client_credentials flow, machines answer OData queries, response actions progress from Pending to Succeeded, alerts carry evidence, TVM data links machines to CVEs and software, indicators upsert by value, and a KQL subset runs advanced hunting over the same data. Everything is scoped to the token's tenant so one emulator can play many customer tenants.

Nothing leaves the machine. Every Defender API call hits the emulator and produces WDATP-shaped responses.

## Start

```bash
# Defender only
npx emulate --service defender

# Default port (when run alone)
# http://localhost:4000
```

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const defender = await createEmulator({ service: 'defender', port: 4000 })
// defender.url === 'http://localhost:4000'
```

## Defaults

```text
MS365_DEFENDER_LOGIN_URL=http://localhost:4000
MS365_DEFENDER_URL=http://localhost:4000/api
MS365_DEFENDER_SECURITY_CENTER_SCOPE=https://api.securitycenter.microsoft.com
MS365_DEFENDER_CLIENT_ID=00000000-0000-4000-8000-00000000c1e0
MS365_DEFENDER_CLIENT_SECRET=test_emulate_defender_client_secret
MS365_DEFENDER_TENANT_ID=00000000-0000-4000-8000-0000000000de
```

Seeded data:

- Tenant Contoso: `desktop-01.contoso.local` (Windows 11, tags finance and laptop), `srv-files-01.contoso.local` (Windows Server 2022, high risk), `mbp-carol.contoso.local` (macOS), and `old-kiosk-07.contoso.local` (CanBeOnboarded)
- Two alerts (a high severity PowerShell alert on the server, a resolved malware alert on the desktop) with file, IP, and URL evidence
- CVE-2024-38063, CVE-2024-4947, CVE-2023-36049 linked to Windows 10, Chrome, and Edge software, three recommendations, one blocked domain indicator
- Tenant Fabrikam (`00000000-0000-4000-8000-0000000001de`) with a Windows 11 workstation and an Ubuntu server

## Authentication

```bash
TOKEN=$(curl -s -X POST http://localhost:4000/00000000-0000-4000-8000-0000000000de/oauth2/v2.0/token \
  -d grant_type=client_credentials \
  -d scope=https://api.securitycenter.microsoft.com/.default \
  -d client_id=00000000-0000-4000-8000-00000000c1e0 \
  -d client_secret=test_emulate_defender_client_secret | jq -r .access_token)
```

The response matches Entra: `{ token_type, expires_in, ext_expires_in, access_token }`. The token is a JWT with `tid`, `appid`, `roles`, and `aud: https://api.securitycenter.microsoft.com`; the `tid` decides which tenant's data every request sees. Also accepted: `/oauth2/v2.0/token` (common), v1 `/{tenantId}/oauth2/token` with `resource`, JSON bodies, and HTTP Basic client authentication. Errors mirror Entra (`invalid_client`, `AADSTS90002` for unknown tenants, `unauthorized_client` when an app is not consented in a tenant).

## Machines

```bash
# Count onboarded devices for billing or reports
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:4000/api/machines?\$filter=onboardingStatus%20eq%20'Onboarded'"

# Paging and projection
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:4000/api/machines?\$top=50&\$orderby=lastSeen%20desc&\$select=id,computerDnsName,osPlatform,version,osBuild,lastSeen&\$count=true"
```

Responses: `{ "@odata.context", "@odata.count"?, value: [...], "@odata.nextLink"? }`. Filters support `eq ne gt ge lt le and or not in`, `contains()`, `startswith()`, `endswith()`, datetime literals (`lastSeen gt 2026-01-01T00:00:00Z`), and lambdas (`machineTags/any(t: t eq 'laptop')`). Invalid filters return 400 `InvalidQuery`.

Also: `GET /api/machines/{id}`, `findbyip?ip=&timestamp=`, `findbytag?tag=`, and per machine `alerts`, `logonusers`, `machineactions`, `activeactions`, `vulnerabilities`, `software`, `recommendations`, `exposurescore`. `POST /api/machines/{id}/tags` with `{ "Value": "vip", "Action": "Add" }` and `POST .../setDeviceValue` with `{ "DeviceValue": "High" }` mutate the machine.

## Response Actions

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://localhost:4000/api/machines/4899036531e374137f63289c3267bad772c13fef/isolate \
  -d '{ "Comment": "Containment", "IsolationType": "Full" }'
```

Actions: `isolate`, `unisolate`, `restrictCodeExecution`, `unrestrictCodeExecution`, `runAntiVirusScan` (`ScanType`), `collectInvestigationPackage`, `offboard`, `StopAndQuarantineFile` (`Sha1`), `runliveresponse` (`Commands`), `startInvestigation`. Every action needs a `Comment`; a second active action of the same type returns 400 `ActiveRequestAlreadyExists`. Track them with `GET /api/machineactions`, `GET /api/machineactions/{id}`, cancel with `POST .../cancel`, and download packages via `GET .../getPackageUri`. Status moves Pending (0 s), InProgress (1 s), Succeeded (3 s); set `POST /_defender/simulate/action-delays` to `{ "in_progress_after_ms": 0, "succeeded_after_ms": 0 }` in tests.

## Alerts

- `GET /api/alerts?$filter=severity eq 'High' and status ne 'Resolved'`
- `PATCH /api/alerts/{id}` with `status`, `assignedTo`, `classification`, `determination`, `comment`
- `POST /api/alerts/CreateAlertByReference` with `machineId`, `severity`, `title`, `description`, `recommendedAction`, `eventTime`, `reportId`, `category`
- `POST /api/alerts/batchUpdate` with `alertIds` plus update fields
- `GET /api/alerts/{id}/machine`, `user`, `files`, `ips`, `domains`

## Threat and Vulnerability Management

- `GET /api/vulnerabilities`, `/{cve}`, `/{cve}/machineReferences`, `/machinesVulnerabilities`
- `GET /api/software`, `/{id}`, `/{id}/machineReferences`, `vulnerabilities`, `distributions`
- `GET /api/recommendations`, `/{id}`, `/{id}/machineReferences`, `software`, `vulnerabilities`
- `GET /api/exposureScore`, `/exposureScore/ByMachineGroups`, `GET /api/configurationScore`

## Indicators

`POST /api/indicators` with `indicatorValue`, `indicatorType`, `action`, `title`, `description` (optional `severity`, `expirationTime`, `generateAlert`, `rbacGroupNames`). Posting the same value and type again updates in place (200 instead of 201). Hashes are validated by type. `POST /api/indicators/import` takes `{ Indicators: [...] }`, `DELETE /api/indicators/{id}` removes one, `DELETE /api/indicators` with `{ IndicatorIds }` removes many.

## Advanced Hunting

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://localhost:4000/api/advancedqueries/run \
  -d '{ "Query": "DeviceInfo | where OnboardingStatus == \"Onboarded\" | summarize count() by OSPlatform" }'
```

Returns `{ Stats, Schema, Results }`. Operators: `where`, `project`, `project-away`, `extend`, `summarize` (`count dcount sum avg min max make_set make_list arg_max arg_min`), `distinct`, `sort by`, `top N by`, `take`, `limit`, `count`. Tables: `DeviceInfo`, `DeviceNetworkInfo`, `AlertInfo`, `AlertEvidence`, `DeviceAlertEvents`, `DeviceTvmSoftwareInventory`, `DeviceTvmSoftwareVulnerabilities`, `DeviceTvmSecureConfigurationAssessment`, `DeviceLogonEvents`, `MachineActions`.

## Entities

`GET /api/domains/{host}/alerts|machines|stats`, `GET /api/files/{sha1}` and `/alerts|machines|stats`, `GET /api/ips/{ip}/alerts|machines|stats`, `GET /api/users/{DOMAIN\user}/alerts|machines`, `GET /api/investigations`, `GET /api/machinegroups`.

## Simulator, Events, and Inspector

- `POST /_defender/simulate/alert` `{ machineId, title, severity, category, evidence, relatedUser }` creates a detection on a machine (id or DNS name)
- `POST /_defender/simulate/machine` `{ machineId, lastSeen, healthStatus, onboardingStatus, lastIpAddress, agentVersion, version, osBuild }` simulates a sensor check-in or onboarding
- `GET /_defender/events?type=machine_action.created` lists events (`token.issued`, `alert.*`, `machine.*`, `machine_action.*`, `indicator.*`, `hunting.query`); `DELETE` clears them
- `GET /api` returns the calling token's tenant, counts, and roles
- `GET /` inspector tabs: machines, alerts, actions, vulnerabilities, indicators, tenants, events, auth

## Seed Configuration

```json
{
  "defender": {
    "apps": [{ "client_id": "acb57369-de24-4642-8890-5f09746d18d7", "client_secret": "secret", "tenant_ids": ["11111111-1111-4111-8111-111111111111"] }],
    "action_delays": { "in_progress_after_ms": 0, "succeeded_after_ms": 0 },
    "tenants": [
      {
        "id": "11111111-1111-4111-8111-111111111111",
        "name": "Customer A",
        "machines": [
          { "computerDnsName": "ws-01.customer-a.local", "osPlatform": "Windows11", "version": "24H2", "osBuild": 26100, "machineTags": ["vip"], "logonUsers": [{ "accountName": "erin", "accountDomain": "CUSTOMERA" }] },
          { "computerDnsName": "ubuntu-01.customer-a.local", "osPlatform": "Ubuntu", "version": "24.4", "osBuild": null },
          { "computerDnsName": "retired.customer-a.local", "onboardingStatus": "CanBeOnboarded", "healthStatus": "Inactive" }
        ],
        "alerts": [{ "machine": "ws-01.customer-a.local", "title": "Suspicious login", "severity": "Medium" }]
      }
    ]
  }
}
```

Tenants also accept `software`, `vulnerabilities`, `recommendations`, and `indicators`; machines accept `software` and `vulnerabilities` links that drive exposure counts. Machines default to `Onboarded`, `Active`, `x64`, `version: "Other"`, and a generated 40 character id. Seeding is idempotent by id or name.

## Limits

Incidents, the unified `security.microsoft.com` Graph API, automated investigation details, live response library files, the streaming API, device group and RBAC role management, and Defender Vulnerability Management remediation tasks are not implemented.
