---
name: posthog
description: Emulated PostHog analytics and feature flag API for local development and testing. Use when the user needs to capture product analytics events locally, verify event payloads in tests, exercise feature flag decisions, test PostHog SDK integration without network access, or work with POSTHOG_HOST, NEXT_PUBLIC_POSTHOG_HOST, capture, batch, or decide endpoints.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# PostHog Analytics Emulator

Stateful PostHog capture and decide API emulation. Events persist in memory and feature flags evaluate from seeded project configuration.

No real analytics data is sent. Every call to the capture routes stores events locally so you can inspect them programmatically or in the browser.

## Start

```bash
# PostHog only
npx emulate --service posthog

# Default port when run alone
# http://localhost:4000
```

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const posthog = await createEmulator({ service: 'posthog', port: 4000 })
// posthog.url === 'http://localhost:4000'
```

## Auth

PostHog uses body-token auth for the supported SDK routes. Capture requests pass `api_key`; decide requests pass `token`.

```bash
curl -X POST http://localhost:4000/capture/ \
  -H "Content-Type: application/json" \
  -d '{"api_key": "phc_test", "event": "signup", "distinct_id": "user-1"}'
```

Bearer tokens are not required for capture or decide.

## Pointing Your App at the Emulator

Set the SDK host to the emulator URL:

```bash
POSTHOG_HOST=http://localhost:4000
NEXT_PUBLIC_POSTHOG_HOST=http://localhost:4000
```

```typescript
import { PostHog } from 'posthog-node'

const posthog = new PostHog('phc_test', {
  host: process.env.POSTHOG_HOST,
})

await posthog.capture({
  distinctId: 'user-1',
  event: 'signup',
  properties: { plan: 'pro' },
})
```

For browser SDK tests, configure the host the same way you configure production PostHog, but use the emulator URL and a seeded project token.

## Seed Config

```yaml
posthog:
  projects:
    - id: 1
      api_token: phc_test
  feature_flags:
    - key: new-checkout
      project_id: 1
      default: false
      conditions:
        - property: email
          operator: icontains
          value: "@acme.com"
          variant: true
      overrides:
        user-123: true
    - key: pricing-experiment
      project_id: 1
      default: control
      variants: [control, treatment]
      overrides:
        user-456: treatment
```

## Inspecting Events

Browse captured events and configured flags:

```
http://localhost:4000/_inspector
```

Filter inspector data by project:

```
http://localhost:4000/_inspector?tab=events&project_id=1
```

## API Endpoints

### Capture

```bash
curl -X POST http://localhost:4000/capture/ \
  -H "Content-Type: application/json" \
  -d '{"api_key": "phc_test", "event": "signup", "distinct_id": "user-1", "properties": {"plan": "pro"}}'
```

Batch capture:

```bash
curl -X POST http://localhost:4000/batch/ \
  -H "Content-Type: application/json" \
  -d '{"api_key": "phc_test", "batch": [{"event": "signup", "distinct_id": "user-1"}]}'
```

The capture parser also accepts `application/x-www-form-urlencoded` with `data=<json>` and `text/plain` JSON bodies used by sendBeacon.

### Decide

```bash
curl -X POST http://localhost:4000/decide/ \
  -H "Content-Type: application/json" \
  -d '{"token": "phc_test", "distinct_id": "user-1", "person_properties": {"email": "alice@acme.com"}}'
```

Decide returns `featureFlags`, `featureFlagPayloads`, and SDK config defaults that disable unsupported PostHog features cleanly.

## Limitations

Implemented: event capture, batch capture, feature flag defaults, distinct ID overrides, person property conditions, and inspector UI.

Not implemented: session replay, insights, cohorts, percentage rollouts, surveys, admin REST API, and group property evaluation.
