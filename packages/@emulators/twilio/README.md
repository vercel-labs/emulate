# @emulators/twilio

Twilio API emulator for local development and CI. Part of [emulate](https://github.com/vercel-labs/emulate).

```bash
npm install @emulators/twilio
```

Run it through the CLI:

```bash
npx emulate --service twilio
```

The first supported surface includes seeded Account SID/Auth Token credentials, API key credentials, incoming phone numbers, Programmable Messaging, Messaging Services, Verify, basic Voice calls, Conversations REST resources, signed webhooks, simulator routes, and an inspector.

Default local credentials:

```text
TWILIO_ACCOUNT_SID=AC00000000000000000000000000000000
TWILIO_AUTH_TOKEN=twilio_test_auth_token
TWILIO_API_KEY=SK00000000000000000000000000000000
TWILIO_API_SECRET=twilio_test_api_secret
TWILIO_PHONE_NUMBER=+15551234567
TWILIO_VERIFY_SERVICE_SID=VA00000000000000000000000000000000
```

Twilio uses multiple product hosts. When testing with the official Node SDK, use a custom request client that rewrites Twilio hosts to the local emulator. The emulator exposes product-prefixed local routes such as `/verify/v2` and `/messaging/v1`.

No real SMS, voice, carrier, compliance, billing, or SendGrid traffic is performed.
