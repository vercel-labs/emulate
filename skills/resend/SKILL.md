---
name: resend
description: Emulated Resend email API for local development and testing. Use when the user needs to send emails locally, test transactional email flows, implement magic link or verification code auth, inspect sent emails, manage domains/contacts/API keys, or work with the Resend API without sending real emails. Triggers include "Resend API", "emulate Resend", "send email locally", "test email", "magic link", "verification email", "email inbox", "RESEND_BASE_URL", or any task requiring a local email API.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(curl:*)
---

# Resend Email API Emulator

Fully stateful Resend API emulation. Emails, domains, API keys, audiences, and contacts persist in memory. Sent emails are captured and viewable through the inbox UI or the REST API.

No real emails are sent. Every call to `POST /emails` stores the message locally so you can inspect it programmatically or in the browser.

## Start

```bash
# Resend only
npx emulate --service resend

# Default port (when run alone)
# http://localhost:4000
```

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const resend = await createEmulator({ service: 'resend', port: 4000 })
// resend.url === 'http://localhost:4000'
```

## Auth

Pass tokens as `Authorization: Bearer <token>`. Any `re_` prefixed token is accepted.

```bash
curl http://localhost:4000/emails \
  -H "Authorization: Bearer re_test_key"
```

When no token is provided, requests fall back to the default user.

## Pointing Your App at the Emulator

### Environment Variable (Resend SDK)

The official Resend Node.js SDK reads `RESEND_BASE_URL` at module load time. Set it to the emulator URL and the SDK works without any code changes:

```bash
RESEND_BASE_URL=http://localhost:4000
```

```typescript
import { Resend } from 'resend'

// No baseUrl argument needed; the SDK reads RESEND_BASE_URL automatically.
const resend = new Resend('re_test_key')

await resend.emails.send({
  from: 'hello@example.com',
  to: 'user@example.com',
  subject: 'Hello',
  html: '<p>It works!</p>',
})
```

### Embedded in Next.js (adapter-next)

When using `@emulators/adapter-next`, the emulator runs inside your Next.js app at `/emulate/resend`. Set `RESEND_BASE_URL` via `next.config.ts`:

```typescript
// next.config.ts
import { withEmulate } from '@emulators/adapter-next'

export default withEmulate({
  env: {
    RESEND_BASE_URL: `http://localhost:${process.env.PORT ?? '3000'}/emulate/resend`,
  },
})
```

```typescript
// app/emulate/[...path]/route.ts
import { createEmulateHandler } from '@emulators/adapter-next'
import * as resend from '@emulators/resend'

export const { GET, POST, PUT, PATCH, DELETE } = createEmulateHandler({
  services: {
    resend: {
      emulator: resend,
      seed: {
        domains: [{ name: 'example.com' }],
      },
    },
  },
})
```

### Direct fetch

If you cannot use the SDK or env var, call the emulator directly:

```typescript
await fetch('http://localhost:4000/emails', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer re_test_key',
  },
  body: JSON.stringify({
    from: 'hello@example.com',
    to: 'user@example.com',
    subject: 'Hello',
    html: '<p>It works!</p>',
  }),
})
```

## Seed Config

```yaml
resend:
  domains:
    - name: example.com
      region: us-east-1
  contacts:
    - email: test@example.com
      first_name: Test
      last_name: User
      audience: Default
```

## Retrieving Sent Emails

This is the key differentiator of the emulator: every email sent via `POST /emails` is stored and queryable.

### Inbox UI

Browse sent emails in the browser:

```
http://localhost:4000/inbox
```

### REST API

```bash
# List all sent emails
curl http://localhost:4000/emails \
  -H "Authorization: Bearer re_test_key"

# Get a single email by ID
curl http://localhost:4000/emails/<id> \
  -H "Authorization: Bearer re_test_key"
```

### Extracting Data from Emails (tests, agents)

Useful for completing magic link, verification code, or password reset flows programmatically:

```bash
# Get the latest email ID
EMAIL_ID=$(curl -s http://localhost:4000/emails \
  -H "Authorization: Bearer re_test_key" | jq -r '.data[0].id')

# Extract a 6-digit code from the HTML body
CODE=$(curl -s http://localhost:4000/emails/$EMAIL_ID \
  -H "Authorization: Bearer re_test_key" | jq -r '.html' | grep -oE '[0-9]{6}')

echo "Verification code: $CODE"
```

## API Endpoints

### Emails

```bash
# Send an email
curl -X POST http://localhost:4000/emails \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"from": "hello@example.com", "to": "user@example.com", "subject": "Hello", "html": "<p>Hi</p>"}'

# Send batch (up to 100)
curl -X POST http://localhost:4000/emails/batch \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '[{"from": "a@example.com", "to": "b@example.com", "subject": "One", "html": "<p>1</p>"}]'

# List all emails
curl http://localhost:4000/emails \
  -H "Authorization: Bearer $TOKEN"

# Get email by ID
curl http://localhost:4000/emails/<id> \
  -H "Authorization: Bearer $TOKEN"

# Cancel a scheduled email
curl -X POST http://localhost:4000/emails/<id>/cancel \
  -H "Authorization: Bearer $TOKEN"
```

Supported fields: `from`, `to`, `subject`, `html`, `text`, `cc`, `bcc`, `reply_to`, `headers`, `tags`, `scheduled_at`.

### Domains

```bash
# Create domain
curl -X POST http://localhost:4000/domains \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "example.com", "region": "us-east-1"}'

# List domains
curl http://localhost:4000/domains \
  -H "Authorization: Bearer $TOKEN"

# Get domain
curl http://localhost:4000/domains/<id> \
  -H "Authorization: Bearer $TOKEN"

# Verify domain (instantly marks all records as verified)
curl -X POST http://localhost:4000/domains/<id>/verify \
  -H "Authorization: Bearer $TOKEN"

# Delete domain
curl -X DELETE http://localhost:4000/domains/<id> \
  -H "Authorization: Bearer $TOKEN"
```

### API Keys

```bash
# Create API key
curl -X POST http://localhost:4000/api-keys \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Production"}'

# List API keys
curl http://localhost:4000/api-keys \
  -H "Authorization: Bearer $TOKEN"

# Delete API key
curl -X DELETE http://localhost:4000/api-keys/<id> \
  -H "Authorization: Bearer $TOKEN"
```

### Audiences

```bash
# Create audience
curl -X POST http://localhost:4000/audiences \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Newsletter"}'

# List audiences
curl http://localhost:4000/audiences \
  -H "Authorization: Bearer $TOKEN"

# Delete audience
curl -X DELETE http://localhost:4000/audiences/<id> \
  -H "Authorization: Bearer $TOKEN"
```

### Contacts

```bash
# Create contact in an audience
curl -X POST http://localhost:4000/audiences/<audience_id>/contacts \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "first_name": "Jane", "last_name": "Doe"}'

# List contacts in an audience
curl http://localhost:4000/audiences/<audience_id>/contacts \
  -H "Authorization: Bearer $TOKEN"

# Delete contact
curl -X DELETE http://localhost:4000/audiences/<audience_id>/contacts/<id> \
  -H "Authorization: Bearer $TOKEN"
```

## Webhooks

The emulator dispatches webhook events when state changes:

- `email.sent` and `email.delivered` on `POST /emails`
- `domain.created` and `domain.deleted` on domain operations
- `contact.created` and `contact.deleted` on contact operations

## Common Patterns

### Magic Link / Verification Code Flow

```bash
TOKEN="re_test_key"
BASE="http://localhost:4000"

# 1. Send verification email
curl -X POST $BASE/emails \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"from": "auth@example.com", "to": "user@example.com", "subject": "Your code", "html": "<p>Code: <strong>482910</strong></p>"}'

# 2. Retrieve the email
EMAIL_ID=$(curl -s $BASE/emails -H "Authorization: Bearer $TOKEN" | jq -r '.data[0].id')

# 3. Read the HTML body
curl -s $BASE/emails/$EMAIL_ID -H "Authorization: Bearer $TOKEN" | jq -r '.html'
```

### Send and Verify in a Test

```typescript
import { createEmulator } from 'emulate'
import { Resend } from 'resend'

const emu = await createEmulator({ service: 'resend', port: 4000 })

process.env.RESEND_BASE_URL = emu.url
const resend = new Resend('re_test_key')

// Send
await resend.emails.send({
  from: 'auth@example.com',
  to: 'user@test.com',
  subject: 'Verify',
  html: '<p>Code: <strong>123456</strong></p>',
})

// Retrieve
const res = await fetch(`${emu.url}/emails`, {
  headers: { Authorization: 'Bearer re_test_key' },
})
const { data: emails } = await res.json()
console.log(emails[0].html) // contains "123456"
```
