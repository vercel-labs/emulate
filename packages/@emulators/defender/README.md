# @emulators/defender

Stateful Microsoft Defender for Endpoint (WDATP) API emulator plugin for [emulate](https://github.com/vercel-labs/emulate).

## Features

- Entra client_credentials tokens at `/{tenantId}/oauth2/v2.0/token`; every token is scoped to one tenant
- Machines with full OData support: `$filter` (comparisons, logic, `in`, string functions, datetimes, lambdas), `$top`, `$skip`, `$orderby`, `$select`, `$count`, `@odata.nextLink`
- Response actions (isolate, scan, collect package, offboard, quarantine, live response) that progress Pending, InProgress, Succeeded on a configurable timer, with cancellation and duplicate detection
- Alerts with evidence, comments, classification, batch updates, and CreateAlertByReference
- Vulnerabilities, software, recommendations, exposure and configuration scores derived from seeded machine links
- Custom indicators with upsert semantics, hash validation, import, and bulk delete
- Advanced hunting KQL subset over device, alert, TVM, and logon tables
- Entity lookups for domains, files, IPs, and users, an event log, a simulator, and a tabbed inspector

## Usage

```typescript
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { defenderPlugin, seedFromConfig } from "@emulators/defender";

const app = new Hono();
const store = new Store();
const baseUrl = "http://localhost:4018";

defenderPlugin.register(app, store, new WebhookDispatcher(), baseUrl);
defenderPlugin.seed?.(store, baseUrl);
seedFromConfig(store, baseUrl, {
  apps: [{ client_id: "my-app", client_secret: "my-secret" }],
  tenants: [{ id: "11111111-1111-4111-8111-111111111111", name: "Customer A", machines: [{ computerDnsName: "ws-01" }] }],
});
```

Request a token with `grant_type=client_credentials` at `${baseUrl}/{tenantId}/oauth2/v2.0/token`, then call `${baseUrl}/api/machines?$filter=onboardingStatus eq 'Onboarded'` with the bearer token. The default app is `00000000-0000-4000-8000-00000000c1e0` with secret `test_emulate_defender_client_secret`.

## Defaults

The default seed creates tenant Contoso with four machines, two alerts, three CVEs, three software products, three recommendations, and one indicator, plus tenant Fabrikam with two machines.

See the [Defender skill](../../../skills/defender/SKILL.md) for the complete route list and seed schema.
