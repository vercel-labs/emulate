# @emulators/posthog

Local PostHog API emulator for product analytics events and feature flag decisions.

## Usage

```typescript
import { createEmulator } from 'emulate'

const posthog = await createEmulator({
  service: 'posthog',
  port: 4000,
  seed: {
    posthog: {
      projects: [{ id: 1, api_token: 'phc_test' }],
      feature_flags: [
        {
          key: 'new-checkout',
          project_id: 1,
          default: false,
          conditions: [
            { property: 'email', operator: 'icontains', value: '@acme.com', variant: true },
          ],
        },
      ],
    },
  },
})
```

Point PostHog SDKs at `posthog.url` as the host. Capture and decide routes authenticate with the body token fields used by PostHog: `api_key` for capture routes and `token` for decide.

## Routes

- `POST /capture/`
- `POST /batch/`
- `POST /e/`
- `POST /track/`
- `POST /decide/`
- `GET /_inspector`

Capture routes accept JSON, `application/x-www-form-urlencoded` with a `data` field, and `text/plain` sendBeacon payloads. Stored events are visible in the inspector.

## Feature Flags

Feature flags support exact distinct ID overrides and simple person property conditions:

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
```

Evaluation order is override, then conditions, then default. Cohorts, percentage rollouts, group property evaluation, surveys, insights, and session replay are not implemented.
