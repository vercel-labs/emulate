# @emulators/mailgun

Mailgun API emulation: message sending with stored copies and events, mailing lists and members, domains and SMTP credentials, suppressions, templates, tags, stats, signed webhooks, the analytics logs API, address validation, inbound routes with a simulator, and an inspector.

Part of [emulate](https://github.com/vercel-labs/emulate) — local drop-in replacement services for CI and no-network sandboxes.

## Install

```bash
npm install @emulators/mailgun
```

## Defaults

```text
MAILGUN_URL=http://localhost:4000
MAILGUN_API_KEY=key-emulate-mailgun-test
MAILGUN_DOMAIN=mail.example.com
MAILGUN_WEBHOOK_SIGNING_KEY=emulate-mailgun-webhook-key
```

Authenticate with HTTP Basic using any username and the API key as password. Point `mailgun.js` at the emulator with the `url` client option.

## Endpoints

- Messages: `POST /v3/{domain}/messages`, `POST /v3/{domain}/messages.mime`, stored messages at `GET|POST|DELETE /v3/domains/{domain}/messages/{key}`, attachments, `GET /_mailgun/messages/{key}` HTML preview
- Events and logs: `GET /v3/{domain}/events`, `GET /v3/{domain}/events/{token}`, `POST /v1/analytics/logs`
- Domains: `GET|POST /v4/domains`, `GET|PUT|DELETE /v4/domains/{name}`, `verify`, `connection`, `tracking`, `credentials`, `sending_queues`, `ips`, sandbox authorized recipients
- Mailing lists: `GET /v3/lists/pages`, `GET|POST /v3/lists`, `GET|PUT|DELETE /v3/lists/{address}`, members (`pages`, list, create, `members.json`, get, update, delete), validation jobs
- Suppressions: `bounces`, `unsubscribes`, `complaints`, `whitelists` with list, create (single or JSON array), get, delete, clear, and unsubscribe import
- Templates: CRUD plus versions
- Tags and stats: `GET /v3/{domain}/tags`, tag CRUD, tag stats, `GET /v3/{domain}/stats/total`, `GET /v3/stats/total`
- Webhooks: `GET|POST /v3/domains/{domain}/webhooks`, `GET|PUT|DELETE /v3/domains/{domain}/webhooks/{type}`
- Address validation: `GET|POST /v4/address/validate`, `GET /v3/address/validate`
- Inbound routes: `GET|POST /v3/routes`, `GET|PUT|DELETE /v3/routes/{id}`, `GET /v3/routes/match`
- Simulator: `POST /_mailgun/simulate/inbound`, `POST /_mailgun/simulate/event`, `GET /_mailgun/simulate/summary`
- Inspector: `GET /`

## Test Recipients

`bounce@...` bounces permanently and lands in the bounces list, `fail@...` fails temporarily, `complaint@...` complains, suppressed addresses fail with `suppress-*` reasons, and sandbox domains reject unauthorized recipients.

## Webhooks

Payloads are `{ signature: { timestamp, token, signature }, "event-data": {...} }` where `signature` is the hex HMAC-SHA256 of `timestamp + token` with the webhook signing key. Inbound route forwards and store notifications post Mailgun's parsed form fields with the same signature fields.

## Seed Configuration

```yaml
mailgun:
  api_keys:
    - key: key-emulate-mailgun-test
  webhook_signing_key: emulate-mailgun-webhook-key
  domains:
    - name: mail.example.com
  lists:
    - address: team@mail.example.com
      name: Team
      members:
        - address: alice@example.com
          name: Alice
  templates:
    - domain: mail.example.com
      name: welcome
      template: "<p>Hello {{name}}</p>"
  webhooks:
    - domain: mail.example.com
      types: [delivered, permanent_fail]
      url: http://localhost:3000/api/webhooks/mailgun
  routes:
    - expression: match_recipient("support@mail.example.com")
      actions: ['forward("http://localhost:3000/api/webhooks/mailgun/inbound")', "stop()"]
```

## Links

- [Full documentation](https://emulate.dev)
- [GitHub](https://github.com/vercel-labs/emulate)
