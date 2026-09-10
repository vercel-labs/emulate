# @emulators/scaleway

Stateful Scaleway Transactional Email (TEM) emulator plugin for [emulate](https://github.com/vercel-labs/emulate).

## Features

- `X-Auth-Token` authentication with Scaleway error bodies (`denied_authentication`, `invalid_arguments` with per-argument `details`, `not_found`, `permissions_denied`, `precondition_failed`)
- `POST /transactional-email/v1alpha1/regions/{region}/emails` that validates `from`, `to`/`cc`/`bcc`, `subject`, `text`/`html`, `project_id`, `attachments`, `additional_headers`, and `send_before`, then returns one `Email` object per recipient sharing a `message_id`
- Emails move from `new` to `sending` to `sent` on a configurable delay; blocklisted recipients fail immediately; simulators produce bounces, spam, deferrals, and failures with the matching `flags`, `last_tries`, and webhook events
- `GET /emails` with every list filter (`project_id`, `domain_id`, `message_id`, `since`, `until`, `mail_from`, `mail_rcpt`, `statuses`, `flags`, `subject`, `search`, `order_by`, paging), `GET /emails/{id}`, `POST /emails/{id}/cancel`, `GET /statistics`
- Domains (create, list, get, check, revoke, verification, update) with SPF, DKIM, DMARC, and MX records, webhooks with recorded events, blocklists, and project settings
- Stored bodies at `/_scaleway/emails/{id}` (JSON) and `/_scaleway/emails/{id}/html`, an event log, and a tabbed inspector

## Usage

```typescript
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { scalewayPlugin, seedFromConfig } from "@emulators/scaleway";

const app = new Hono();
const store = new Store();
const baseUrl = "http://localhost:4024";

scalewayPlugin.register(app, store, new WebhookDispatcher(), baseUrl);
scalewayPlugin.seed?.(store, baseUrl);
seedFromConfig(store, baseUrl, {
  domains: [{ name: "cyna-it.fr", status: "checked" }],
  settings: { strict_domains: true, delivery_delay_ms: 0 },
});
```

## Defaults

- Secret key `00000000-0000-4000-8000-00000000ca1e` (access key `SCWEMULATE0000000000`), project `00000000-0000-4000-8000-00000000c0fe`, organization `00000000-0000-4000-8000-00000000c0ff`
- Domains `emulate.example` (checked, id `00000000-0000-4000-8000-00000000d0ac`) and `pending.example` (unchecked), one webhook on `emulate.example`, one blocklisted recipient `bounce@blocked.example`, and three historical emails

See the main [emulate README](https://github.com/vercel-labs/emulate#scaleway-transactional-email) for the full route list.
