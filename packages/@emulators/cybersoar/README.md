# @emulators/cybersoar

Stateful CyberSOAR incident API emulator plugin for [emulate](https://github.com/vercel-labs/emulate). CyberSOAR is the SOC case management backend whose `GET /incidents/alerts` feed drives customer security reports.

## Features

- `Authorization: ApiKey <key>` authentication with `{ statusCode: 401 }` errors
- `GET /incidents/alerts` with `name="MSP:Customer"` namespace matching (display names or slugs), `service`, `verdict`, `status`, `ingestAt.gt`/`.lt`, `criticity`, `tags`, `caseId`, `ruleId`, `search`, and `pageIndex`/`pageSize` paging returning `{ data, meta: { count, nextPage? } }`
- Alert CRUD, cases derived from `caseId`, stats, and a customers listing
- Deterministic generated alerts per customer from a catalog of realistic SOC rules across SentinelOne, Defender, Sophos, Microsoft 365, Active Directory, and firewall services, plus three fixed alerts with known ids
- Simulator for bulk alert creation and closing with verdicts and the `MAIL_SENT` tag, an event log, and a tabbed inspector

## Usage

```typescript
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { cybersoarPlugin, seedFromConfig } from "@emulators/cybersoar";

const app = new Hono();
const store = new Store();
const baseUrl = "http://localhost:4023";

cybersoarPlugin.register(app, store, new WebhookDispatcher(), baseUrl);
cybersoarPlugin.seed?.(store, baseUrl);
seedFromConfig(store, baseUrl, {
  customers: [{ name: "Customer A", msp: "My MSP", generate_alerts: 40, generate_days: 90 }],
  alerts: [
    {
      customer: "Customer A",
      msp: "My MSP",
      service: "MS365",
      ruleName: "Impossible travel sign-in",
      status: "CLOSED",
      verdict: "TP",
      tags: ["MAIL_SENT"],
    },
  ],
});
```

## Defaults

- API key `test_emulate_cybersoar_api_key`
- Customers Acme Corp and Globex Industries under Nimbus MSP (namespaces `Nimbus MSP:Acme Corp` and `nimbus-msp:acme-corp`), Initech under Direct
- Fixed alert ids `a0000000-0000-4000-8000-00000000f101` (closed TP, MAIL_SENT), `...f102` (closed FP), `...f103` (waiting analyst)

See the main [emulate README](https://github.com/vercel-labs/emulate#cybersoar-api) for the full route list.
