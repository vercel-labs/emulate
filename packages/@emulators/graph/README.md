# @emulators/graph

Stateful Microsoft Graph emulator plugin for [emulate](https://github.com/vercel-labs/emulate), focused on application permission flows.

## Features

- Entra client_credentials tokens at `/{tenantId}/oauth2/v2.0/token`, scoped to one tenant, with per-app `permissions` enforced as `Authorization_RequestDenied`
- Users with OData `$filter` (including `in`, `startsWith`, `contains`), `$select`, `$top`, `$orderby`, `$count`, `$search`, and `$skiptoken` paging
- Guest invitations that create `#EXT#` users with redeemable links and acceptance simulation
- Directory role definitions with real template ids, role assignments with duplicate and not-found semantics, directory roles and members
- Groups with membership, organization, service principals, deleted items and restore
- JSON `$batch` with up to 20 ordered requests and `dependsOn`
- Event log, simulator, and a tabbed inspector

## Usage

```typescript
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { graphPlugin, seedFromConfig } from "@emulators/graph";

const app = new Hono();
const store = new Store();
const baseUrl = "http://localhost:4021";

graphPlugin.register(app, store, new WebhookDispatcher(), baseUrl);
graphPlugin.seed?.(store, baseUrl);
seedFromConfig(store, baseUrl, {
  tenants: [{ id: "11111111-1111-4111-8111-111111111111", displayName: "Customer A", users: [{ displayName: "Analyst", mail: "analyst@soc.example", userType: "Guest", roles: ["Security Administrator"] }] }],
});
```

Request a token with `grant_type=client_credentials` at `${baseUrl}/{tenantId}/oauth2/v2.0/token`, then call `${baseUrl}/v1.0/users?$filter=mail in ('analyst@soc.example')`. The default app is `00000000-0000-4000-8000-0000000000a9` with secret `test_emulate_graph_client_secret`.

## Defaults

The default seed creates tenant Contoso with five users, one group, one pending invitation, and role assignments, plus tenant Fabrikam with one administrator.

See the [Graph skill](../../../skills/graph/SKILL.md) for the complete route list and seed schema.
