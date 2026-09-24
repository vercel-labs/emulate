# @emulators/resend

Resend email API emulation with email sending, domain management, API keys, audiences, contacts, and a local inbox for captured messages.

Part of [emulate](https://github.com/vercel-labs/emulate) — local drop-in replacement services for CI and no-network sandboxes.

## Install

```bash
npm install @emulators/resend
```

## Endpoints

### Emails
- `POST /emails` — send single email
- `POST /emails/batch` — send up to 100 emails
- `GET /emails` — list sent emails
- `GET /emails/:id` — get email
- `POST /emails/:id/cancel` — cancel scheduled email

### Idempotency

`POST /emails` and `POST /emails/batch` accept the case-insensitive `Idempotency-Key` header. Keys must be 1 to 256 characters and are retained for 24 hours. Repeating a request with the same key and validated payload returns the original response without creating another email or dispatching duplicate webhooks. Reusing a key with a different payload or endpoint returns `409 invalid_idempotent_request`. Invalid key lengths return `400 invalid_idempotency_key`. Requests without the header keep the normal non-idempotent behavior.

### Domains
- `POST /domains` — create domain
- `GET /domains` — list domains
- `GET /domains/:id` — get domain
- `DELETE /domains/:id` — remove domain
- `POST /domains/:id/verify` — trigger domain verification

### API Keys
- `POST /api-keys` — create API key
- `GET /api-keys` — list API keys
- `DELETE /api-keys/:id` — delete API key

### Audiences & Contacts
- `POST /audiences` — create audience
- `GET /audiences` — list audiences
- `DELETE /audiences/:id` — delete audience
- `POST /audiences/:audience_id/contacts` — add contact
- `GET /audiences/:audience_id/contacts` — list contacts
- `DELETE /audiences/:audience_id/contacts/:id` — delete contact

### Inbox
- `GET /inbox` — list captured emails
- `GET /inbox/:id` — view captured email

## Seed Configuration

```yaml
resend:
  domains:
    - name: example.com
  api_keys:
    - name: default
  allowlist:
    - alex@acme.example.test
```

When `allowlist` is set, every `to`, `cc`, and `bcc` address must be listed. A missing address returns `403` `validation_error`, stores no email, and still records a row in `resend.send_attempts`. Omit `allowlist` to accept every recipient. Attempts are emulator state, not a Resend API route.

## Links

- [Full documentation](https://emulate.dev)
- [GitHub](https://github.com/vercel-labs/emulate)
