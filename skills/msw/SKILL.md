---
name: msw
description: Mock Service Worker integration that answers real provider URLs from stateful emulators via @emulators/msw. Use when the user wants SDKs to keep production URLs in tests, needs MSW handlers for GitHub, Slack, Twilio, Stripe, AWS, Google, or other emulated APIs, wants to combine realistic emulator state with per-test MSW overrides, or wants to capture emulator webhooks in process. Triggers include "MSW", "Mock Service Worker", "setupServer", "@emulators/msw", "createEmulatorHandlers", "intercept real API hosts", or "no base URL in tests".
allowed-tools: Bash(npx emulate:*)
---

# Mock Service Worker Integration

The `@emulators/msw` package turns emulators into [Mock Service Worker](https://mswjs.io) request handlers for the real provider hosts. Application code and SDKs keep their production URLs. MSW intercepts each request, and a stateful emulator running in the same process answers it.

## Install

```bash
npm install -D @emulators/msw msw
```

## Setup

```typescript
import { setupServer } from 'msw/node'
import { createEmulatorHandlers } from '@emulators/msw'

const emulators = await createEmulatorHandlers({
  services: {
    github: {
      seed: {
        users: [{ login: 'octocat' }],
        repos: [{ owner: 'octocat', name: 'hello-world', auto_init: true }],
      },
    },
    slack: {},
    twilio: {},
  },
  tokens: { octocat_token: { login: 'octocat', scopes: ['repo', 'user'] } },
})
const server = setupServer(...emulators.handlers)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  server.resetHandlers()
  emulators.reset()
})
afterAll(async () => {
  server.close()
  await emulators.close()
})
```

Clients need no base URL, endpoint, or custom HTTP client:

```typescript
const octokit = new Octokit({ auth: 'octocat_token' })
await octokit.rest.issues.create({ owner: 'octocat', repo: 'hello-world', title: 'Bug' })

const client = twilio('AC00000000000000000000000000000000', 'twilio_test_auth_token')
await client.verify.v2.services('VA00000000000000000000000000000000').verifications.create({ to: '+15557654321', channel: 'sms' })
```

Each service accepts `seed` (the same shape as its section of `emulate.config.yaml`) and `baseUrl`. Pass `{}` or `true` for defaults. `tokens` is shared by every service. `emulators.emulators.<service>` exposes each in-process emulator for direct `fetch` and `request` calls.

## Per-test overrides

Handlers added with `server.use()` run first, so you can inject failures on top of realistic state:

```typescript
import { http, HttpResponse } from 'msw'

server.use(
  http.post(
    'https://api.github.com/repos/:owner/:repo/issues',
    () => HttpResponse.json({ message: 'API rate limit exceeded' }, { status: 403 }),
    { once: true },
  ),
)
```

## Webhooks

Emulators deliver webhooks with `fetch`, so MSW intercepts them too. Add a handler for the delivery URL to capture deliveries or to call your route handler in process, with signatures intact:

```typescript
import { POST } from '@/app/api/github/webhook/route'

server.use(http.post('https://app.example.test/api/github/webhook', ({ request }) => POST(request)))
```

With `onUnhandledRequest: 'error'`, MSW reports a delivery to a URL that has no handler as unhandled. Many deliveries are sent in the background, so wait for them (for example with `vi.waitFor`) before asserting.

## Hosts

Each built-in service exports a host table that maps real provider hosts onto the emulator's single origin:

| Service | Hosts |
|---------|-------|
| GitHub | `api.github.com`, `github.com`, `uploads.github.com` |
| Slack | `slack.com`, `hooks.slack.com`, `files.slack.com` |
| Twilio | `api.twilio.com`, `verify.twilio.com` (`/verify`), `messaging.twilio.com` (`/messaging`), `conversations.twilio.com` (`/conversations`) |
| Google | `accounts.google.com`, `www.googleapis.com`, `gmail.googleapis.com`, `oauth2.googleapis.com` (`/oauth2`) |
| Microsoft | `login.microsoftonline.com`, `graph.microsoft.com` |
| Apple | `appleid.apple.com` |
| Vercel | `api.vercel.com`, `vercel.com` |
| AWS | S3 path-style and virtual-hosted URLs (`/s3`), `sqs` (`/sqs/`), `sts` (`/sts/`), `iam` (`/iam/`) |
| Stripe | `api.stripe.com` |
| Resend | `api.resend.com` |
| Linear | `api.linear.app`, `linear.app` |
| Clerk | `api.clerk.com`, `*.clerk.accounts.dev` |
| Okta | `*.okta.com`, `*.oktapreview.com`, `*.okta-emea.com` |
| MongoDB Atlas | `cloud.mongodb.com` |

Paths in parentheses are the emulator prefixes that a host maps onto. Every service advertises its first unprefixed host as its base URL (for example `https://api.github.com`), so links, redirects, and URLs the emulator generates route back through MSW. Okta has no fixed host, so pass your org URL: `okta: { baseUrl: 'https://dev-123.okta.com' }`. AWS has no single primary host and advertises `http://aws.localhost`, which the handlers also route.

## Limitations

- Node only. The handlers run emulators in process with `setupServer`. Browser `setupWorker` is not supported.
- Stripe's default Node HTTP client writes the request body after a TLS `secureConnect` event that MSW's intercepted sockets do not emit, so requests stall. Use the fetch client: `new Stripe(key, { httpClient: Stripe.createFetchHttpClient() })`.
- Emulated responses without a `Content-Length` are buffered so Node HTTP clients such as axios finish reading them. `text/event-stream` responses stay streamed.
- The SQS emulator implements the Query protocol (`Action` parameters). It does not handle the AWS JSON protocol that current AWS SDK SQS clients use.

## In-process emulators without MSW

The handlers are built on `createEmulator({ service, listen: false })`, which runs a built-in service without opening a port:

```typescript
import { createEmulator, getServiceHosts, toEmulatorPath } from 'emulate'

const github = await createEmulator({ service: 'github', listen: false, baseUrl: 'https://api.github.com' })
const res = await github.request('/user', { headers: { Authorization: 'token test_token_admin' } })

const hosts = await getServiceHosts('twilio')
toEmulatorPath(hosts, 'https://verify.twilio.com/v2/Services') // '/verify/v2/Services'
```
