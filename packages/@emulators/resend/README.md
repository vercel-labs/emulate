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
