# @emulators/zendesk

Zendesk Support API v2 emulation: tickets with comments, audits, and metrics, requests, users, organizations and memberships, groups, ticket fields and custom fields, tags, search, views, macros, triggers, signed webhooks, uploads, job statuses, incremental exports, an inbound-email simulator, and an inspector.

Part of [emulate](https://github.com/vercel-labs/emulate) — local drop-in replacement services for CI and no-network sandboxes.

## Install

```bash
npm install @emulators/zendesk
```

## Defaults

```text
ZENDESK_SUBDOMAIN=emulate-support
ZENDESK_EMAIL=admin@example.com
ZENDESK_API_TOKEN=test_emulate_zendesk_api_token
```

Authenticate with `Authorization: Basic base64(email/token:API_TOKEN)`. Every route is available with and without the `.json` suffix.

## Endpoints

- Tickets: create, list, show, update, delete, `show_many`, `recent`, `count`, `create_many`, `update_many`, `destroy_many`, `imports/tickets`, `imports/tickets/create_many`, `mark_as_spam`, `merge`, comments (`make_private`, `redact`), audits, metrics, tags, incidents, collaborators, followers, email CCs, satisfaction ratings, macro preview, deleted tickets with restore
- Requests: list, open, solved, ccd, search, create, show, update, comments, per organization and per user
- Users: create, list, `me`, show, update, delete, search, autocomplete, `show_many`, `count`, `create_or_update`, `create_many`, `update_many`, `destroy_many`, related, identities, organizations, memberships, requested and assigned tickets, tags
- Organizations: create, list, show, update, delete, `search`, autocomplete, `show_many`, `count`, `create_or_update`, `create_many`, `update_many`, `destroy_many`, tickets, users, requests, memberships, tags
- Organization memberships and group memberships: create (duplicates return `422`), list, show, delete, `create_many`, `destroy_many`, `make_default`
- Groups: create, list, show, update, delete, assignable, users, memberships
- Ticket fields, user fields, organization fields, field options, tags, custom statuses, ticket forms, brands
- Search: `search`, `search/count`, `search/export`
- Views (`tickets`, `count`, `execute`, `count_many`), macros (`apply`), triggers
- Webhooks: CRUD, `test`, `signing_secret`, `invocations`, `attempts`
- Uploads and attachments, job statuses, incremental exports (`tickets`, `tickets/cursor`, `users`, `organizations`, `ticket_events`), account settings, locales, activities
- `POST /_zendesk/simulate/inbound-email` and the inspector at `GET /`

## Webhooks

Trigger `notification_webhook` actions render Liquid-style placeholders into the request body. Event subscriptions (`zen:event-type:user.*`, `zen:event-type:organization.*`, `zen:event-type:ticket.*`) receive the Zendesk event envelope. Deliveries carry `X-Zendesk-Webhook-Signature` (base64 HMAC-SHA256 over timestamp plus body), `X-Zendesk-Webhook-Signature-Timestamp`, `X-Zendesk-Webhook-Id`, `X-Zendesk-Webhook-Invocation-Id`, and any configured Basic, Bearer, or API key header.

## Seed Configuration

```yaml
zendesk:
  subdomain: emulate-support
  api_tokens:
    - token: test_emulate_zendesk_api_token
      email: admin@example.com
  organizations:
    - name: Example Inc
      domain_names: [example.com]
  users:
    - name: Support Admin
      email: admin@example.com
      role: admin
    - name: Test Customer
      email: test@example.com
      role: end-user
  tickets:
    - subject: Welcome to the Zendesk emulator
      description: How do I test my support integration locally?
      requester: test@example.com
      status: open
  webhooks:
    - name: Local ticket notifier
      endpoint: http://localhost:3000/api/webhooks/zendesk
      signing_secret: zendesk_webhook_secret
```

## Links

- [Full documentation](https://emulate.dev)
- [GitHub](https://github.com/vercel-labs/emulate)
