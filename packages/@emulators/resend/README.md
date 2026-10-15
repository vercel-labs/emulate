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

### Recipient restrictions and send attempts

Set `resend.allowlist` in seed config to test recipient rejection:

```yaml
resend:
  allowlist:
    - allowed@example.com
    - copy@example.com
```

Omitting `allowlist` accepts every recipient; `allowlist: []` rejects every recipient. Every address in `to`, `cc`, and `bcc` must be listed. Matching ignores surrounding whitespace and letter case; entries are individual addresses, with no wildcard or domain matching. This is a local testing control, independent of Resend's domain verification and account restrictions.

A rejected send returns `403 validation_error` naming the rejected addresses and configured allowlist. No email ID, email record, idempotency record, or webhook is created. A batch is rejected as a whole if any recipient is disallowed. Retrying a rejected request, even with the same idempotency key, creates a new attempt. Replaying an accepted idempotent request returns its original response even if the allowlist has since changed.

Validated sends append one record per email to the `resend.send_attempts` store collection, including emails in a rejected batch. Each record contains `from`, `to`, `cc`, `bcc`, `subject`, `idempotency_key` (or `null`), and the store's `id`, `created_at`, and `updated_at`. Message bodies are not copied into attempts. Malformed requests, invalid or conflicting idempotency keys, and idempotency replays do not append attempts.

Read attempts with `getResendStore(store).sendAttempts.all()` from `@emulators/resend`, or inspect the persisted state. Shared adapter snapshots use the key `resend:resend.send_attempts`. Attempts and recipient restrictions survive saved-state restoration, including rejected sends. There is no additional Resend API endpoint for attempts. A rejected send has an attempt without an email; a send that never happened has neither.

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
```

## Links

- [Full documentation](https://emulate.dev)
- [GitHub](https://github.com/vercel-labs/emulate)
