# @emulators/sentinelone

Stateful SentinelOne management console API emulator plugin for [emulate](https://github.com/vercel-labs/emulate).

## Features

- `ApiToken` authentication, routes under `/web/api/v2.1` and `/web/api/v2.0`, `{ data, pagination: { nextCursor, totalItems } }` lists with `limit`, `cursor`, `skip`, `countOnly`, `skipCount`, `sortBy`, and SentinelOne error codes
- Accounts, sites (with `allSites` totals, registration tokens, default groups), groups, and filters that place agents into dynamic groups by machine type and OS
- Agents with the console fields, license counting, and response actions (decommission, scan, disconnect, move, uninstall, and more) driven by `{ filter }` selectors
- Users with `scope` and `scopeRoles`, RBAC roles with seedable ids, onboarding and password emails, 2FA actions, and API token generation
- Threats with mitigation, incident, verdict, and note workflows that update agent counters
- Application risks and CVEs per endpoint with severity counts and analyst verdicts
- Legacy and unified exclusions, blocklist restrictions, and device control rules attached to tenant, account, site, or group scope
- Policies inherited global, account, site, group with `inheritedFrom`, activities, a simulator, an event log, and a tabbed inspector

## Usage

```typescript
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { sentinelonePlugin, seedFromConfig } from "@emulators/sentinelone";

const app = new Hono();
const store = new Store();
const baseUrl = "http://localhost:4020";

sentinelonePlugin.register(app, store, new WebhookDispatcher(), baseUrl);
sentinelonePlugin.seed?.(store, baseUrl);
seedFromConfig(store, baseUrl, {
  roles: [{ id: "2153718167648641127", name: "MSP Admin", scope: "account" }],
  accounts: [{ name: "CYNA PRO", sites: [{ name: "CUSTOMER ONE", agents: [{ computerName: "c1-srv-01", osType: "windows", machineType: "server" }] }] }],
});
```

Call `GET /web/api/v2.1/agents?siteIds=<siteId>` with `Authorization: ApiToken test_emulate_sentinelone_api_token`.

## Defaults

The default seed creates account "EMULATE MSSP" with site "ACME CORP" (five agents in dynamic groups, two threats, five CVEs) and trial site "GLOBEX #TRIAL", sixteen RBAC roles, and four users.

See the [SentinelOne skill](../../../skills/sentinelone/SKILL.md) for the complete route list and seed schema.
