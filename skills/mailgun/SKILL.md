---
name: mailgun
description: Emulated Mailgun email API for local development and testing. Use when the user needs to send email through Mailgun locally, inspect delivered messages and events, manage mailing lists and members, test suppressions, templates, tags, or stats, verify Mailgun webhook signatures, or test inbound routes without a real Mailgun account. Triggers include "Mailgun API", "emulate Mailgun", "test email sending locally", "mailing list", "mailgun.js", "MAILGUN_API_KEY", "MAILGUN_DOMAIN", "Mailgun webhook", "inbound route", or any task requiring a local Mailgun API.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(curl:*)
---

# Mailgun API Emulator

Fully stateful Mailgun API emulation. Messages are stored with their events (accepted, delivered, failed, opened, clicked, unsubscribed, complained, stored), mailing lists expand to their members, suppressions block delivery, templates render Handlebars-style variables, and webhooks fire with Mailgun signatures. Inbound routes can be exercised with a simulator.

No email leaves the machine. Every Mailgun API or `mailgun.js` call hits the emulator and produces Mailgun-shaped responses.

## Start

```bash
# Mailgun only
npx emulate --service mailgun

# Default port (when run alone)
# http://localhost:4000
```

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const mailgun = await createEmulator({ service: 'mailgun', port: 4000 })
// mailgun.url === 'http://localhost:4000'
```

## Defaults

```text
MAILGUN_URL=http://localhost:4000
MAILGUN_API_KEY=key-emulate-mailgun-test
MAILGUN_DOMAIN=mail.example.com
MAILGUN_WEBHOOK_SIGNING_KEY=emulate-mailgun-webhook-key
```

Seeded data:

| Kind | Value |
|------|-------|
| Domain | `mail.example.com` (active, open and click tracking on) |
| Sandbox domain | `sandbox0000000000000000000000000000.mailgun.org` with authorized recipient `test@example.com` |
| Mailing list | `team@mail.example.com` with members `alice@example.com` and `bob@example.com` |
| Template | `welcome`, `<p>Hello {{name}}, welcome to {{company}}.</p>` with subject `Welcome to {{company}}` |

## Pointing Your App at the Emulator

### mailgun.js

```typescript
import FormData from 'form-data'
import Mailgun from 'mailgun.js'

const mailgun = new Mailgun(FormData).client({
  username: 'api',
  key: process.env.MAILGUN_API_KEY!,
  url: process.env.MAILGUN_URL, // http://localhost:4000
})

await mailgun.messages.create('mail.example.com', {
  from: 'Support <noreply@mail.example.com>',
  to: ['jane@example.com'],
  subject: 'Hello',
  text: 'Sent locally',
})
```

The `url` option replaces `https://api.mailgun.net` (or the EU endpoint). Everything else in the client stays the same.

### Direct HTTP

```bash
curl -s --user "api:$MAILGUN_API_KEY" http://localhost:4000/v3/mail.example.com/messages \
  -F from='Support <noreply@mail.example.com>' -F to=jane@example.com \
  -F subject='Hello' -F text='Sent locally' -F o:tag=welcome
```

Authentication is HTTP Basic with any username and the API key as password. Domain sending keys (`domains[].sending_key` in seed config) only work for their domain. Unauthenticated requests receive `401 {"message":"Forbidden"}`.

## Test Recipients

| Recipient | Outcome |
|-----------|---------|
| any normal address | `accepted` then `delivered` |
| `bounce@...` or `*@bounce.test` | `accepted` then permanent `failed` (reason `bounce`), added to bounces |
| `fail@...` or `temp-fail@...` | `accepted` then temporary `failed` (reason `generic`) |
| `complaint@...` | `delivered` then `complained`, added to complaints |
| suppressed address | `accepted` then permanent `failed` with reason `suppress-bounce`, `suppress-unsubscribe`, or `suppress-complaint` |
| sandbox domain, unauthorized recipient | `400` with the Mailgun sandbox error |

`o:testmode=yes` records `accepted` only, with `flags.is-test-mode` set.

## Seed Config

```yaml
mailgun:
  api_keys:
    - key: key-emulate-mailgun-test
  webhook_signing_key: emulate-mailgun-webhook-key
  domains:
    - name: mail.cyna.test
      sending_key: key-cyna-sending
      tracking:
        open: true
        click: true
    - name: sandbox0000000000000000000000000000.mailgun.org
      type: sandbox
      authorized_recipients: [dev@cyna.test]
  lists:
    - address: soc-acme@mail.cyna.test
      name: "SOC · Provider · Acme"
      access_level: everyone
      members:
        - address: soc@cyna.test
          name: "CYNA · cybersecurity"
          vars: { role: analyst }
  templates:
    - domain: mail.cyna.test
      name: alert
      template: "<h1>{{title}}</h1><p>{{body}}</p>"
      subject: "[Alert] {{title}}"
  webhooks:
    - domain: mail.cyna.test
      types: [delivered, permanent_fail, complained]
      url: http://localhost:3000/api/webhooks/mailgun
  routes:
    - priority: 0
      description: Inbound support
      expression: match_recipient("support@mail.cyna.test")
      actions:
        - forward("http://localhost:3000/api/webhooks/mailgun/inbound")
        - stop()
  suppressions:
    bounces:
      - domain: mail.cyna.test
        address: dead@example.com
        code: "550"
        error: mailbox unavailable
    unsubscribes:
      - domain: mail.cyna.test
        address: quiet@example.com
  credentials:
    - domain: mail.cyna.test
      login: postmaster
      password: smtp-secret
```

## API Endpoints

### Messages

```bash
# Send (form-urlencoded or multipart; attachments via -F attachment=@file)
curl -s --user "api:$MAILGUN_API_KEY" http://localhost:4000/v3/mail.example.com/messages \
  -F from=noreply@mail.example.com -F to=jane@example.com -F to=john@example.com \
  -F subject='Hi %recipient.name%' -F html='<p>Your role: %recipient.role%</p>' \
  -F recipient-variables='{"jane@example.com":{"name":"Jane","role":"admin"},"john@example.com":{"name":"John","role":"member"}}' \
  -F o:tag=onboarding -F v:user-id=42 -F h:Reply-To=help@mail.example.com

# Send with a stored template
curl -s --user "api:$MAILGUN_API_KEY" http://localhost:4000/v3/mail.example.com/messages \
  -F from=noreply@mail.example.com -F to=jane@example.com -F template=welcome \
  -F t:variables='{"name":"Jane","company":"Cyna"}'

# Send raw MIME
curl -s --user "api:$MAILGUN_API_KEY" http://localhost:4000/v3/mail.example.com/messages.mime \
  -F to=jane@example.com -F message=@message.mime

# Stored message (URL comes from event storage.url), resend, list
curl -s --user "api:$MAILGUN_API_KEY" http://localhost:4000/v3/domains/mail.example.com/messages/<key>
curl -s --user "api:$MAILGUN_API_KEY" -X POST http://localhost:4000/v3/domains/mail.example.com/messages/<key> -F to=other@example.com
curl -s --user "api:$MAILGUN_API_KEY" http://localhost:4000/v3/mail.example.com/messages
```

Responses are `{"id":"<...@mail.example.com>","message":"Queued. Thank you."}`. Sending to a mailing list address delivers to every subscribed member with `%recipient.*%` substitutions from member `vars`. Missing `from`, `to`, or body return Mailgun's exact `400` messages. Every stored message has an HTML preview at `/_mailgun/messages/<key>`.

### Events And Logs

```bash
curl -s --user "api:$MAILGUN_API_KEY" "http://localhost:4000/v3/mail.example.com/events?event=delivered&recipient=jane%40example.com&limit=50"
curl -s --user "api:$MAILGUN_API_KEY" -X POST http://localhost:4000/v1/analytics/logs \
  -H 'Content-Type: application/json' \
  -d '{"start":"Mon, 01 Sep 2026 00:00:00 GMT","end":"Tue, 30 Sep 2026 00:00:00 GMT","events":["delivered"],"filter":{"AND":[{"attribute":"tag","comparator":"=","values":[{"label":"onboarding","value":"onboarding"}]}]},"pagination":{"sort":"timestamp:desc","limit":50}}'
```

Events carry Mailgun's shape: `event`, `id`, `timestamp`, `recipient`, `tags`, `user-variables`, `message.headers`, `envelope`, `flags`, `storage`, `delivery-status`, `severity`, and `reason`. Filters accept `event`, `recipient`, `from`, `subject`, `tags`, `message-id`, `severity`, `begin`, `end`, `ascending`, and `limit`; `paging` links point at `/v3/{domain}/events/<token>`.

### Mailing Lists

```bash
curl -s --user "api:$MAILGUN_API_KEY" http://localhost:4000/v3/lists/soc-acme@mail.example.com          # 404 {"message":"Mailing list not found"} when missing
curl -s --user "api:$MAILGUN_API_KEY" http://localhost:4000/v3/lists -F address=soc-acme@mail.example.com -F name='SOC · Acme' -F access_level=everyone
curl -s --user "api:$MAILGUN_API_KEY" http://localhost:4000/v3/lists/soc-acme@mail.example.com/members -F address=soc@cyna.test -F name='CYNA' -F upsert=yes
curl -s --user "api:$MAILGUN_API_KEY" http://localhost:4000/v3/lists/soc-acme@mail.example.com/members/soc%40cyna.test
curl -s --user "api:$MAILGUN_API_KEY" -X PUT http://localhost:4000/v3/lists/soc-acme@mail.example.com -F access_level=members -F address=soc-acme@mail.example.com
curl -s --user "api:$MAILGUN_API_KEY" -X DELETE http://localhost:4000/v3/lists/soc-acme@mail.example.com/members/soc%40cyna.test
curl -s --user "api:$MAILGUN_API_KEY" "http://localhost:4000/v3/lists/pages?limit=100"
curl -s --user "api:$MAILGUN_API_KEY" http://localhost:4000/v3/lists/soc-acme@mail.example.com/members.json -F upsert=yes \
  -F members='[{"address":"a@example.com","name":"A"},{"address":"b@example.com","subscribed":false}]'
```

Responses wrap objects as `{"list": ...}` and `{"member": ...}` with Mailgun's messages. Adding an existing member without `upsert=yes` returns `400 {"message":"Address already exists"}`.

### Suppressions

```bash
curl -s --user "api:$MAILGUN_API_KEY" http://localhost:4000/v3/mail.example.com/bounces -F address=dead@example.com -F code=550 -F error='mailbox unavailable'
curl -s --user "api:$MAILGUN_API_KEY" http://localhost:4000/v3/mail.example.com/unsubscribes -F address=quiet@example.com -F tag='*'
curl -s --user "api:$MAILGUN_API_KEY" http://localhost:4000/v3/mail.example.com/complaints -F address=angry@example.com
curl -s --user "api:$MAILGUN_API_KEY" http://localhost:4000/v3/mail.example.com/whitelists -F address=vip@example.com
curl -s --user "api:$MAILGUN_API_KEY" "http://localhost:4000/v3/mail.example.com/bounces?limit=100"
curl -s --user "api:$MAILGUN_API_KEY" -X DELETE http://localhost:4000/v3/mail.example.com/bounces/dead%40example.com
```

Bulk JSON arrays are accepted on the collection endpoints. Whitelisted addresses and domains bypass the other suppression lists.

### Domains

```bash
curl -s --user "api:$MAILGUN_API_KEY" http://localhost:4000/v4/domains
curl -s --user "api:$MAILGUN_API_KEY" http://localhost:4000/v4/domains -F name=mail.acme.test -F web_scheme=https
curl -s --user "api:$MAILGUN_API_KEY" http://localhost:4000/v4/domains/mail.acme.test
curl -s --user "api:$MAILGUN_API_KEY" -X PUT http://localhost:4000/v4/domains/mail.acme.test/verify
curl -s --user "api:$MAILGUN_API_KEY" -X PUT http://localhost:4000/v3/domains/mail.acme.test/tracking/open -F active=yes
curl -s --user "api:$MAILGUN_API_KEY" http://localhost:4000/v3/domains/mail.acme.test/credentials -F login=postmaster -F password=smtp-secret
curl -s --user "api:$MAILGUN_API_KEY" -X DELETE http://localhost:4000/v3/domains/mail.acme.test
curl -s --user "api:$MAILGUN_API_KEY" -X POST "http://localhost:4000/v5/sandbox/auth_recipients?email=dev%40example.com"
```

Domain responses include `sending_dns_records` and `receiving_dns_records` that are always `valid`.

### Templates, Tags, Stats, Validation

```bash
curl -s --user "api:$MAILGUN_API_KEY" http://localhost:4000/v3/mail.example.com/templates -F name=alert -F template='<h1>{{title}}</h1>' -F tag=v1
curl -s --user "api:$MAILGUN_API_KEY" http://localhost:4000/v3/mail.example.com/templates/alert/versions -F template='<h2>{{title}}</h2>' -F tag=v2 -F active=yes
curl -s --user "api:$MAILGUN_API_KEY" "http://localhost:4000/v3/mail.example.com/templates/alert?active=yes"
curl -s --user "api:$MAILGUN_API_KEY" http://localhost:4000/v3/mail.example.com/tags
curl -s --user "api:$MAILGUN_API_KEY" "http://localhost:4000/v3/mail.example.com/stats/total?event=accepted&event=delivered&event=failed&resolution=day&duration=7d"
curl -s --user "api:$MAILGUN_API_KEY" "http://localhost:4000/v4/address/validate?address=jane%40gmial.com"
```

Templates render `{{var}}`, `{{var.path}}`, `{{#if var}}...{{else}}...{{/if}}`, and `{{#each list}}...{{/each}}` from `t:variables`, `v:` variables, and `X-Mailgun-Variables`. Validation flags typos (`did_you_mean`), disposable domains, role addresses, and malformed input.

### Webhooks

```bash
curl -s --user "api:$MAILGUN_API_KEY" http://localhost:4000/v3/domains/mail.example.com/webhooks -F id=delivered -F url=http://localhost:3000/api/webhooks/mailgun
curl -s --user "api:$MAILGUN_API_KEY" -X PUT http://localhost:4000/v3/domains/mail.example.com/webhooks/permanent_fail -F url=http://localhost:3000/api/webhooks/mailgun
curl -s --user "api:$MAILGUN_API_KEY" http://localhost:4000/v3/domains/mail.example.com/webhooks
```

Types: `accepted`, `delivered`, `opened`, `clicked`, `unsubscribed`, `complained`, `permanent_fail`, `temporary_fail`. Payloads are `{"signature":{"timestamp","token","signature"},"event-data":{...}}` where `signature = HMAC-SHA256(webhook_signing_key, timestamp + token)` in hex.

```typescript
import { createHmac, timingSafeEqual } from 'node:crypto'

export function verifyMailgun(signingKey: string, body: { signature: { timestamp: string; token: string; signature: string } }): boolean {
  const { timestamp, token, signature } = body.signature
  const expected = createHmac('sha256', signingKey).update(timestamp + token).digest('hex')
  return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
}
```

### Inbound Routes And Simulator

```bash
curl -s --user "api:$MAILGUN_API_KEY" http://localhost:4000/v3/routes -F priority=0 -F description='Support' \
  -F expression='match_recipient("support@mail.example.com")' \
  -F action='forward("http://localhost:3000/api/webhooks/mailgun/inbound")' -F action='stop()'
curl -s --user "api:$MAILGUN_API_KEY" "http://localhost:4000/v3/routes/match?address=support%40mail.example.com"

# Simulate an inbound email
curl -s --user "api:$MAILGUN_API_KEY" http://localhost:4000/_mailgun/simulate/inbound \
  -H 'Content-Type: application/json' \
  -d '{"from":"Customer <cust@example.com>","to":"support@mail.example.com","subject":"Help","text":"Please help"}'

# Simulate engagement on a sent message
curl -s --user "api:$MAILGUN_API_KEY" http://localhost:4000/_mailgun/simulate/event \
  -F event=opened -F message-id='<...@mail.example.com>' -F recipient=jane@example.com
```

Expressions support `match_recipient("regex")`, `match_header("name", "regex")`, `catch_all()`, and `and`. Actions support `forward("url or email")`, `store(notify="url")`, `store()`, and `stop()`. Forwards and notifications POST Mailgun's parsed form fields (`recipient`, `sender`, `from`, `subject`, `body-plain`, `stripped-text`, `body-html`, `message-headers`, `timestamp`, `token`, `signature`, `message-url` for stores). Simulated events accept `opened`, `clicked`, `unsubscribed`, `complained`, `delivered`, and `failed`, fire the matching webhooks, and update suppressions.

## Inspector

Open `GET /` for messages (with HTML previews), events, mailing lists and members, suppressions, templates, domains and SMTP credentials, webhooks with deliveries, inbound routes with deliveries, and credentials.

## Current Limits

Scheduled delivery (`o:deliverytime`) is recorded but delivered immediately. Bulk address validation, IP pools, subaccounts, SMTP transport, inbox placement, metrics API v1 aggregates beyond totals, and dedicated IP management are not implemented. Handlebars support covers variables, `if`, and `each`.
