---
name: twilio
description: Emulated Twilio SMS, voice, and verification API for local development and testing. Use when the user needs to send SMS locally, test 2FA/verification flows, create calls, inspect sent messages, or work with the Twilio API without sending real messages. Triggers include "Twilio API", "emulate Twilio", "send SMS locally", "test 2FA", "verification code", "mock Twilio", "local SMS", or any task requiring a local Twilio API.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(curl:*)
---

# Twilio SMS, Voice, and Verify Emulator

Fully stateful Twilio API emulation. Messages, calls, and verification codes persist in memory. Sent messages and verification codes are visible through the inbox UI.

No real SMS or calls are sent. Every API call stores the data locally so you can inspect it programmatically or in the browser.

## Start

```bash
# Twilio only
npx emulate --service twilio

# Default port (when run alone)
# http://localhost:4000
```

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const twilio = await createEmulator({ service: 'twilio', port: 4000 })
// twilio.url === 'http://localhost:4000'
```

## Auth

Pass any token in the Authorization header. Twilio uses Basic auth with Account SID and Auth Token, but the emulator accepts any credentials.

## Endpoints

### Messages

```bash
# Send an SMS
curl -X POST http://localhost:4000/2010-04-01/Accounts/AC_test/Messages.json \
  -d "To=+15559876543&From=+15551234567&Body=Hello"

# List messages
curl http://localhost:4000/2010-04-01/Accounts/AC_test/Messages.json

# Get a message
curl http://localhost:4000/2010-04-01/Accounts/AC_test/Messages/SMXXXXXXXX.json
```

### Calls

```bash
# Create a call
curl -X POST http://localhost:4000/2010-04-01/Accounts/AC_test/Calls.json \
  -d "To=+15559876543&From=+15551234567"

# List calls
curl http://localhost:4000/2010-04-01/Accounts/AC_test/Calls.json
```

### Verify (2FA)

```bash
# Send a verification code
curl -X POST http://localhost:4000/v2/Services/VA_default_service/Verifications \
  -d "To=+15559876543&Channel=sms"

# Check a code (get the code from the inbox UI at http://localhost:4000/)
curl -X POST http://localhost:4000/v2/Services/VA_default_service/VerificationCheck \
  -d "To=+15559876543&Code=123456"
```

### Inbox UI

Open `http://localhost:4000/` in a browser to see all sent messages, verification codes, and calls. Verification codes are shown in plain text for testing.

## Seed Config

```yaml
twilio:
  account_sid: AC_test_account
  auth_token: test_auth_token
  phone_numbers:
    - "+15551234567"
    - "+15559876543"
  verify_services:
    - sid: VA_test_service
      friendly_name: "My App Verify"
      code_length: 6
```

## Pointing Your App at the Emulator

Set `TWILIO_API_URL=http://localhost:PORT` or configure the Twilio client's base URL. Most Twilio SDKs support a custom API endpoint for testing.
