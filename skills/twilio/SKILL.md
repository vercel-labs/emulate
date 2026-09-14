---
name: twilio
description: Emulated Twilio REST APIs for local development and testing. Use when the user needs to test Twilio Messaging, Verify, Voice, phone numbers, webhooks, status callbacks, inbound SMS simulation, Twilio SDK integrations, or SendGrid Mail Send without hitting real services.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# Twilio API Emulator

## SendGrid Mail Send

Use `POST /v3/mail/send` for existing SendGrid clients, with Bearer key
`SG.emulate-test-key` by default. Configure `twilio.sendgrid.api_keys` to
replace it. SendGrid authentication is separate from Twilio Basic auth.
Accepted mail returns empty `202` with `x-message-id`; sandbox mode validates
without delivery.
Supported message bodies are `text/plain` and `text/html`; other content types return `501`.
Templates and scheduled sends return `501`. With the official Node SDK, set the
local base URL after `setApiKey()`, because setting the key resets the URL.

Accepted requests are stored unchanged in `twilio.sendgrid.emails`, including
recipient lists, content, custom headers, and base64 attachments. Library
composition uses `createTwilioPlugin({ sendgrid: { apiKeys } })`.

Set `TWILIO_EMULATOR_URL` to the URL printed when starting the emulator. With
the default SendGrid key, send a message using:

```bash
curl -i "$TWILIO_EMULATOR_URL/v3/mail/send" \
  -H 'Authorization: Bearer SG.emulate-test-key' \
  -H 'Content-Type: application/json' \
  --data '{"personalizations":[{"to":[{"email":"inbox@example.com"}]}],"from":{"email":"sender@example.com"},"subject":"Local test","content":[{"type":"text/plain","value":"Hello from the emulator"}]}'
```

Send and inspect captured mail through the public Store API in a local test:

```javascript
import { createServer } from "@emulators/core";
import { createTwilioPlugin } from "@emulators/twilio";

const { app, store } = createServer(createTwilioPlugin());
const response = await app.request("http://localhost/v3/mail/send", {
  method: "POST",
  headers: {
    Authorization: "Bearer SG.emulate-test-key",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    personalizations: [{ to: [{ email: "inbox@example.com" }] }],
    from: { email: "sender@example.com" },
    subject: "Local test",
    content: [{ type: "text/plain", value: "Hello from the emulator" }],
  }),
});
console.log(response.status); // 202
console.log(store.collection("twilio.sendgrid.emails").all());
```

Stateful Twilio REST emulation with seeded accounts, Auth Tokens, API keys, incoming phone numbers, Programmable Messaging, Messaging Services, Verify, basic Voice calls, Conversations REST resources, signed webhooks, local simulator routes, and an inspector.

## Start

```bash
npx emulate --service twilio
```

Default URL: `http://localhost:4013` when all services are started, or `http://localhost:4000` when Twilio is the only service.

## Defaults

```text
TWILIO_ACCOUNT_SID=AC00000000000000000000000000000000
TWILIO_AUTH_TOKEN=twilio_test_auth_token
TWILIO_API_KEY=SK00000000000000000000000000000000
TWILIO_API_SECRET=twilio_test_api_secret
TWILIO_PHONE_NUMBER=+15551234567
TWILIO_VERIFY_SERVICE_SID=VA00000000000000000000000000000000
```

## URL Mapping

| Real Twilio URL | Emulator URL |
|-----------------|--------------|
| `https://api.twilio.com/2010-04-01/...` | `$TWILIO_EMULATOR_URL/2010-04-01/...` |
| `https://messaging.twilio.com/v1/...` | `$TWILIO_EMULATOR_URL/messaging/v1/...` |
| `https://verify.twilio.com/v2/...` | `$TWILIO_EMULATOR_URL/verify/v2/...` |

The official Node SDK builds absolute Twilio product URLs. In SDK tests, use a custom request client that rewrites those hosts to the emulator prefixes above.

## Auth

HTTP Basic auth accepts either:

- Account SID and Auth Token
- API Key SID and API Key Secret

## Core Routes

- `POST /2010-04-01/Accounts/{AccountSid}/Messages.json` - create outbound message
- `GET /2010-04-01/Accounts/{AccountSid}/Messages.json` - list messages
- `POST /2010-04-01/Accounts/{AccountSid}/Calls.json` - create outbound call
- `POST /verify/v2/Services/{ServiceSid}/Verifications` - start verification
- `POST /verify/v2/Services/{ServiceSid}/VerificationCheck` - check verification code
- `POST /conversations/v1/Services/{ServiceSid}/Conversations` - create Conversation
- `POST /conversations/v1/Services/{ServiceSid}/Conversations/{ConversationSid}/Participants` - add participant
- `POST /conversations/v1/Services/{ServiceSid}/Conversations/{ConversationSid}/Messages` - add message
- `POST /_twilio/simulate/inbound-message` - simulate inbound SMS
- `POST /_twilio/simulate/message-status` - simulate message status callback
- `POST /_twilio/simulate/inbound-call` - simulate inbound call

## SMS And OTP Testing

- The seeded Verify Service code is `123456`.
- Use `CustomCode` when creating a Verification to force a per-verification code.
- Use `GET /_twilio/simulate/verification-code?To=...&ServiceSid=...` with Basic auth to fetch the latest local code for an E2E test.
- Use `POST /_twilio/simulate/verification-status` with `VerificationSid` or `To` to force local Verify state.
- Use `POST /_twilio/simulate/inbound-message` to test inbound SMS webhooks.
- Inbound SMS uses an assigned Messaging Service `inbound_request_url` before falling back to the phone number `sms_url`.
- Use `POST /_twilio/simulate/message-status` to test outbound status callbacks.

## Current Limits

No real SMS, MMS, WhatsApp, email, voice, carrier, compliance, billing, Studio, Flex, TaskRouter, Video, Sync, Segment, Conversations SDK websocket behavior, or complete TwiML interpreter behavior is implemented.
