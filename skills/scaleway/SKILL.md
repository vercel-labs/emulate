---
name: scaleway
description: Emulated Scaleway Transactional Email (TEM) API for local development and testing. Use when the user needs to send email through the Scaleway regions/{region}/emails endpoint with X-Auth-Token, inspect sent messages and their HTML, simulate bounces or spam, or manage TEM domains, webhooks, and blocklists without a Scaleway account. Triggers include "Scaleway", "transactional email", "TEM", "X-Auth-Token", "api.scaleway.com", "EMAIL_ENDPOINT", "bounce", or any task requiring a local transactional email API.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(curl:*)
---

# Scaleway Transactional Email Emulator

Fully stateful emulation of the Scaleway TEM API. Sends return one `Email` object per recipient sharing a `message_id`, statuses move from `new` to `sending` to `sent` on a timer, bodies are stored for inspection, and validation errors use the real `invalid_arguments` shape with per-argument `details`.

Nothing leaves the machine. No email is ever delivered.

## Start

```bash
# Scaleway only
npx emulate --service scaleway

# Default port (when run alone)
# http://localhost:4000
```

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const scaleway = await createEmulator({ service: 'scaleway', port: 4000 })
// scaleway.url === 'http://localhost:4000'
```

## Configure Your App

```bash
EMAIL_ENDPOINT=http://localhost:4000/transactional-email/v1alpha1/regions/fr-par
EMAIL_SECRET_KEY=00000000-0000-4000-8000-00000000ca1e
EMAIL_ACCESS_KEY=SCWEMULATE0000000000
EMAIL_PROJECT_ID=00000000-0000-4000-8000-00000000c0fe
EMAIL_DOMAIN=emulate.example
```

## Seeded Data

| Item | Value |
|------|-------|
| Secret key (`X-Auth-Token`) | `00000000-0000-4000-8000-00000000ca1e` |
| Project | `00000000-0000-4000-8000-00000000c0fe` (organization `...c0ff`) |
| Checked domain | `emulate.example` (`00000000-0000-4000-8000-00000000d0ac`) |
| Unchecked domain | `pending.example` |
| Webhook | `delivery-events` on `emulate.example` (`00000000-0000-4000-8000-00000000eb00`) |
| Blocklisted recipient | `bounce@blocked.example` (`mailbox_not_found`) |
| Historical emails | two sent, one hard bounce |

## Common Tasks

### Send an email

```bash
curl -X POST http://localhost:4000/transactional-email/v1alpha1/regions/fr-par/emails \
  -H "X-Auth-Token: 00000000-0000-4000-8000-00000000ca1e" -H "Content-Type: application/json" \
  -d '{"from":{"name":"Cyna Platform","email":"noreply@emulate.example"},"to":[{"name":"alice@customer.example","email":"alice@customer.example"}],"subject":"Hello","project_id":"00000000-0000-4000-8000-00000000c0fe","text":"Hello","html":"<p>Hello</p>"}'
```

The response is `{ "emails": [ { id, message_id, status: "new", ... } ] }`. Fetch the stored body with `GET /_scaleway/emails/{id}` or preview it at `/_scaleway/emails/{id}/html`.

### Provoke each error the client must handle

```bash
# 401 denied_authentication
curl -X POST http://localhost:4000/transactional-email/v1alpha1/regions/fr-par/emails -d '{}'
# 400 invalid_arguments (missing recipients, subject, body)
curl -X POST http://localhost:4000/transactional-email/v1alpha1/regions/fr-par/emails -H "X-Auth-Token: 00000000-0000-4000-8000-00000000ca1e" -H "Content-Type: application/json" -d '{"from":{"email":"noreply@emulate.example"},"project_id":"00000000-0000-4000-8000-00000000c0fe"}'
# 403 permissions_denied (unknown project)
curl -X POST http://localhost:4000/transactional-email/v1alpha1/regions/fr-par/emails -H "X-Auth-Token: 00000000-0000-4000-8000-00000000ca1e" -H "Content-Type: application/json" -d '{"from":{"email":"a@emulate.example"},"to":[{"email":"b@example.com"}],"subject":"x","text":"x","project_id":"99999999-9999-4999-8999-999999999999"}'
```

### Simulate delivery outcomes

```bash
curl -X POST http://localhost:4000/_scaleway/simulate/deliver -H "Content-Type: application/json" -d '{"mail_rcpt":"alice@customer.example"}'
curl -X POST http://localhost:4000/_scaleway/simulate/bounce -H "Content-Type: application/json" -d '{"mail_rcpt":"alice@customer.example"}'
curl -X POST http://localhost:4000/_scaleway/simulate/bounce -H "Content-Type: application/json" -d '{"email_id":"<id>","soft":true}'
curl -X POST http://localhost:4000/_scaleway/simulate/spam -H "Content-Type: application/json" -d '{"email_id":"<id>"}'
curl -X POST http://localhost:4000/_scaleway/simulate/defer -H "Content-Type: application/json" -d '{"email_id":"<id>"}'
```

Sending to `bounce@blocked.example` fails immediately with the `blocklisted` flag.

### List and count

```bash
curl "http://localhost:4000/transactional-email/v1alpha1/regions/fr-par/emails?statuses=failed&flags=hard_bounce" -H "X-Auth-Token: 00000000-0000-4000-8000-00000000ca1e"
curl "http://localhost:4000/transactional-email/v1alpha1/regions/fr-par/statistics?project_id=00000000-0000-4000-8000-00000000c0fe" -H "X-Auth-Token: 00000000-0000-4000-8000-00000000ca1e"
```

### Domains, webhooks, blocklists

```bash
BASE=http://localhost:4000/transactional-email/v1alpha1/regions/fr-par
curl -X POST $BASE/domains -H "X-Auth-Token: 00000000-0000-4000-8000-00000000ca1e" -H "Content-Type: application/json" -d '{"project_id":"00000000-0000-4000-8000-00000000c0fe","domain_name":"cyna-it.fr","accept_tos":true}'
curl -X POST $BASE/domains/<domain_id>/check -H "X-Auth-Token: 00000000-0000-4000-8000-00000000ca1e"
curl "$BASE/webhooks/00000000-0000-4000-8000-00000000eb00/events" -H "X-Auth-Token: 00000000-0000-4000-8000-00000000ca1e"
curl -X POST $BASE/blocklists -H "X-Auth-Token: 00000000-0000-4000-8000-00000000ca1e" -H "Content-Type: application/json" -d '{"domain_id":"00000000-0000-4000-8000-00000000d0ac","emails":["full@example.com"],"type":"mailbox_full"}'
```

## Seed Options

`settings.delivery_delay_ms` (default 1500; 0 makes sends return `sent` immediately), `settings.strict_domains` (reject senders whose domain is not `checked`), `settings.max_recipients`, `settings.max_attachment_bytes`, plus `projects`, `api_keys` (optionally scoped with `project_ids`), `domains`, `webhooks`, `blocklists`, and historical `emails`.

## Inspector

Open `http://localhost:4000/` for emails (with HTML previews), domains, webhooks, blocklists, events, and auth tabs.

## Limits

No SMTP relay, no DKIM signing, no SNS push of webhooks, no offers or pools, no IAM API.
