# Magic Link Sign-In with Resend

A Next.js app demonstrating magic link authentication using the [Resend](https://resend.com) email API, powered by the emulated Resend service from `emulate`.

No real emails are sent. The emulator captures every email in-memory so you can inspect them through the inbox UI or retrieve them via the API.

## How it works

1. User enters their email on the sign-in page
2. The server generates a 6-digit code and sends it via the official Resend SDK (pointed at the embedded emulator using `RESEND_BASE_URL`)
3. The user is redirected to a verification page
4. The user retrieves the code from the emulator inbox and enters it
5. On success, a session cookie is set and the user lands on the dashboard

The Resend SDK reads `RESEND_BASE_URL` from the environment at module load time. In `next.config.ts`, this is set to `http://localhost:3000/emulate/resend` so all email traffic hits the local emulator instead of `https://api.resend.com`.

## Getting started

From the repository root:

```bash
pnpm install
pnpm --filter resend-magic-link dev
```

Open [http://localhost:3000](http://localhost:3000).

## Retrieving emails from the emulator

### Inbox UI

Visit [http://localhost:3000/emulate/resend/inbox](http://localhost:3000/emulate/resend/inbox) to browse sent emails in a web interface.

### REST API

List all sent emails:

```bash
curl http://localhost:3000/emulate/resend/emails \
  -H "Authorization: Bearer re_emulated_key"
```

Fetch a single email by ID:

```bash
curl http://localhost:3000/emulate/resend/emails/<id> \
  -H "Authorization: Bearer re_emulated_key"
```

### Extracting the sign-in code programmatically

This is useful in tests or agent workflows where you need to complete the magic link flow without a human reading the email:

```bash
# Send a sign-in request (sets the pending_signin cookie)
curl -s -c cookies.txt -L -X POST http://localhost:3000 \
  -d "email=test@example.com"

# List emails and grab the latest one
EMAIL_ID=$(curl -s http://localhost:3000/emulate/resend/emails \
  -H "Authorization: Bearer re_emulated_key" | jq -r '.data[0].id')

# Fetch the email HTML and extract the 6-digit code
CODE=$(curl -s http://localhost:3000/emulate/resend/emails/$EMAIL_ID \
  -H "Authorization: Bearer re_emulated_key" | jq -r '.html' | grep -oE '[0-9]{6}')

echo "Sign-in code: $CODE"
```

## Project structure

```
src/
  app/
    page.tsx                    Sign-in form (enter email)
    sign-in-form.tsx            Client component for email input
    actions.ts                  Server actions (send code, verify, sign out)
    verify/
      page.tsx                  Verification page (enter code)
      verify-form.tsx           Client component for code input
    dashboard/
      page.tsx                  Authenticated landing page
    emulate/
      [...path]/route.ts        Embedded emulator (Resend)
  lib/
    resend.ts                   Resend SDK client (uses RESEND_BASE_URL)
    session.ts                  Cookie-based session helpers
```
