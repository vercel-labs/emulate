# SMS Verification with Twilio

A Next.js app demonstrating phone number verification (SMS OTP) using the [Twilio Verify](https://www.twilio.com/docs/verify) API, powered by the emulated Twilio service from `emulate`.

No real SMS is sent. The emulator runs the Verify flow entirely in-memory, so you can complete the verification with the seeded code or inspect state through the inspector UI.

## How it works

1. User enters their phone number on the home page
2. The server starts a verification via the official Twilio SDK: `verify.v2.services(SID).verifications.create({ to, channel: "sms" })`
3. The user is redirected to a verification page
4. The user enters the code and the server checks it: `verify.v2.services(SID).verificationChecks.create({ to, code })`
5. On success, a session cookie is set and the user lands on the dashboard

The seeded Verify Service accepts the code `123456` for every verification, so the demo can be completed without reading an SMS.

## Pointing the SDK at the emulator

The official Twilio SDK builds absolute URLs against product hosts like `api.twilio.com` and `verify.twilio.com`. `src/lib/twilio.ts` installs a custom request client that rewrites those hosts onto the embedded emulator, which mounts each product under a path prefix:

| Real Twilio URL                          | Emulator URL                                        |
| ---------------------------------------- | --------------------------------------------------- |
| `https://api.twilio.com/2010-04-01/...`  | `http://localhost:3000/emulate/twilio/2010-04-01/...` |
| `https://verify.twilio.com/v2/...`       | `http://localhost:3000/emulate/twilio/verify/v2/...`  |
| `https://messaging.twilio.com/v1/...`    | `http://localhost:3000/emulate/twilio/messaging/v1/...` |

The base URL is set via `TWILIO_BASE_URL` in `next.config.ts`.

## Getting started

From the repository root:

```bash
pnpm install
pnpm --filter twilio-sms-verification dev
```

Open [http://localhost:3000](http://localhost:3000).

## Inspecting verifications

### Inspector UI

Visit [http://localhost:3000/emulate/twilio/?tab=verify](http://localhost:3000/emulate/twilio/?tab=verify) to browse Verify services and verifications (including the issued code) in a web interface.

### Fetching the code programmatically

This is useful in tests or agent workflows where you need to complete the flow without a human reading the SMS:

```bash
# Start a verification through the example API route (sets the pending_verification cookie)
curl -s -c cookies.txt -X POST http://localhost:3000/api/verification/start \
  --data-urlencode "phone=+15555550123"

# Fetch the latest local code for that number
curl -s -G http://localhost:3000/emulate/twilio/_twilio/simulate/verification-code \
  --data-urlencode "To=+15555550123" \
  --data-urlencode "ServiceSid=VA00000000000000000000000000000000" \
  -u "AC00000000000000000000000000000000:twilio_test_auth_token" | jq -r '.code'
```

## Seeded defaults

The Twilio emulator boots with a ready-to-use account and Verify Service:

```text
TWILIO_ACCOUNT_SID=AC00000000000000000000000000000000
TWILIO_AUTH_TOKEN=twilio_test_auth_token
TWILIO_VERIFY_SERVICE_SID=VA00000000000000000000000000000000
Seeded Verify code=123456
```

## Project structure

```
src/
  app/
    page.tsx                    Phone entry form
    phone-form.tsx              Client component for phone input
    actions.ts                  Server actions (send code, check code, sign out)
    verify/
      page.tsx                  Verification page (enter code)
      verify-form.tsx           Client component for code input
    dashboard/
      page.tsx                  Verified landing page
    api/
      verification/start/
        route.ts                Programmatic send-code route for tests and agents
    emulate/
      [...path]/route.ts        Embedded emulator (Twilio)
  lib/
    twilio.ts                   Twilio SDK client + request client that targets the emulator
    session.ts                  Cookie-based session helpers
    verification.ts             Shared verification starter
```
