# @emulators/expo-push

Expo Push Service emulation: send with single messages, batches, and gzip bodies, get tickets and receipts, inject failures, replay seeded flakiness, and assert what each device was sent. No notification leaves the machine.

Part of [emulate](https://github.com/vercel-labs/emulate), local drop-in replacement services for CI and no-network sandboxes.

## Install

```bash
npm install @emulators/expo-push
```

## Endpoints

- `POST /--/api/v2/push/send` sends one message object or an array. Each `to` may be a token or an array of tokens. The response is `{ "data": [ticket, ...] }`, one ticket per recipient in request order.
- `POST /--/api/v2/push/getReceipts` takes `{ "ids": [...] }` and returns `{ "data": { "<id>": receipt } }`. Unknown ids are left out.
- `GET /inbox` lists what was sent.

Request bodies may be gzip or deflate compressed, as `expo-server-sdk` does above 1 KiB.

### What the service answers

| Case | Answer |
| --- | --- |
| Well-formed token | `ok` ticket with a UUID id, `ok` receipt |
| Malformed token | error ticket, `details.error` is `DeviceNotRegistered`, no id |
| Payload over 4096 bytes | error ticket, `MessageTooBig` |
| Device marked `registered: false` | `ok` ticket, error receipt `DeviceNotRegistered` |
| Missing or mistyped field | `400 VALIDATION_ERROR` |
| More than 100 recipients | `400 PUSH_TOO_MANY_NOTIFICATIONS` |
| Tokens from two seeded projects in one request | `400 PUSH_TOO_MANY_EXPERIENCE_IDS` |
| More than 1000 receipt ids | `400 PUSH_TOO_MANY_RECEIPTS` |
| `accessToken` set and no matching bearer token | `401 UNAUTHORIZED` |

Request errors use the Expo shape, `{ "errors": [{ "code", "message" }] }`. The recipient limit counts tokens after expanding `to` arrays, which matches `chunkPushNotifications` in `expo-server-sdk`.

## Point the SDK at the emulator

`expo-server-sdk` reads `EXPO_BASE_URL` once, when it is imported:

```ts
import { createEmulator } from "emulate";

const push = await createEmulator({ service: "expo-push", port: 4015 });
process.env.EXPO_BASE_URL = push.url;
const { Expo } = await import("expo-server-sdk");
```

For raw `fetch`, call `${push.url}/--/api/v2/push/send`.

## Seed config

```yaml
expo-push:
  seed: 42                       # ids and variant order repeat for the same seed
  accessToken: my-expo-token     # optional: require Authorization: Bearer <token>
  devices:
    - token: ExponentPushToken[alice-phone]
      project: "@acme/app"
      platform: ios
    - token: ExponentPushToken[alice-old-phone]
      registered: false          # receipt says DeviceNotRegistered
  failures:
    - id: gone
      match: { token: "ExponentPushToken[bob-phone]" }
      fail: { at: receipt, error: DeviceNotRegistered }
    - id: flaky
      match: { channelId: reminders }
      fail:                      # a list cycles in a seed-shuffled order
        - { at: ok }
        - { at: ok }
        - { at: ticket, error: MessageRateExceeded }
    - id: throttle
      times: 2                   # only the first two matching recipients
      fail: { at: request }      # 429 TOO_MANY_REQUESTS for the whole request
```

`devices` is optional. A device row matters only for `registered: false` and for `project`.

### Failure rules

A rule has an optional `id`, a `match`, an optional `times`, and `fail`. The first rule that matches a recipient and still has budget decides it. Malformed tokens and oversized payloads never reach the rules and do not spend a hit.

`match` keys, all of which must hold: `token` (exact), `title` and `body` (substring), `channelId` (exact), `data` (each listed key equals the same key of the message `data`).

`fail` is one fault or a list. A list cycles through one order that the seed shuffles, so the same `seed` replays the same sequence on every run and a different seed changes it. Fault shapes:

- `{ at: ok }` lets the message through. Use it to build a failure rate.
- `{ at: ticket, error, message? }` returns an error ticket with `details.error` set to `DeviceNotRegistered`, `MessageTooBig`, `MessageRateExceeded`, `MismatchSenderId`, or `InvalidCredentials`.
- `{ at: receipt, error, message? }` returns an `ok` ticket and an error receipt.
- `{ at: request, status?, code?, message? }` fails the whole request and records no messages. The default is `429 TOO_MANY_REQUESTS`, which `expo-server-sdk` retries with backoff.

## Assertions

Everything the service accepted is recorded, in order.

```ts
import { getExpoPushStore, sentTo, sentMessages } from "@emulators/expo-push";

sentTo(store, "ExponentPushToken[alice-phone]"); // messages for one token
sentMessages(store);                             // every recipient record
```

Each record has `token`, `message` (as sent, with `to` narrowed to that token), `ticket`, `receipt`, `request_id`, and `index`.

Over HTTP, for tests that run the emulator as a process:

- `GET /_expo-push/messages` with optional `token`, `title`, `body` (substring), and `status` (`ok` or `error`) query filters
- `GET /_expo-push/requests` lists every call, including rejected ones, with status and error code
- `GET /_expo-push/rules` and `PUT /_expo-push/rules` with `{ "failures": [...] }` read and replace the rules and zero their hit counts
- `POST /_expo-push/devices` with `{ "token", "registered", "project", "platform" }` adds or updates a device
- `POST /_expo-push/reset` restores the seeded devices and rules and clears the record

Control routes refuse requests that carry another site's `Origin`.

Programmatic helpers: `setDeviceRegistered(store, token, registered)`, `addFailure(store, rule)`, `resetExpoPush(store)`.

## Limits

- Tickets come back as an array even for a single message object. The docs describe the array form; check your client if it expects a bare object.
- Receipts are available immediately and never expire. The real service makes them available after a delay and clears them after 24 hours.
- There is no delivery to a device, no APNs or FCM behavior, and no per-device rate limiting. Use failure rules for those.
- Token validation is the same format check `expo-server-sdk` uses. The emulator cannot know whether a token belongs to a real device.
