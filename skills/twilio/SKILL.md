---
name: twilio
description: Emulated Twilio REST APIs for local development and testing. Use when the user needs to test Twilio Messaging, Verify, Voice, phone numbers, webhooks, status callbacks, inbound SMS simulation, or Twilio SDK integrations without hitting the real Twilio service.
allowed-tools: Bash(npx emulate:*)
---

# Twilio API Emulator

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

## Current Limits

No real SMS, MMS, WhatsApp, email, voice, carrier, compliance, billing, SendGrid, Studio, Flex, TaskRouter, Video, Sync, Segment, Conversations SDK websocket behavior, or complete TwiML interpreter behavior is implemented.
