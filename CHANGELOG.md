# Changelog

## Unreleased

### New Features

- **Telegram Bot API emulator** (`@emulators/telegram`) — stateful, wire-compatible Bot API surface so grammY / telegraf / `@chat-adapter/telegram` clients can run against `http://localhost:4007` unmodified. Includes a typed test client (`@emulators/telegram/test`), per-bot webhook delivery with HTTPS validation and 5xx retry (initial + 3 retries, 1s/2s/4s backoff), long-poll `getUpdates` with 409 on concurrent polls, `MarkdownV2` / `HTML` / legacy `Markdown` parse modes with blockquote support, forum-topic methods, `ChatFullInfo` shape on `getChat`, per-chat creator / administrator modeling, `message_reaction` + `message_reaction_count` dispatch, inspector UI, and control-plane fault injection

### Typing

- **Telegram emulator — hand-authored type system** (`@emulators/telegram`) — replaced every `Record<string, unknown>`, `as unknown as X`, and per-field `typeof body.X` ladder with a self-contained type system under `src/types/` backed by zod 4 validators. Store rows (`src/types/store/*`) are separated from Bot API wire shapes (`src/types/wire/*`) and request bodies (`src/types/request/*`, derived from `z.infer`). `Dispatcher.enqueue` is generic on `UpdateType` with `PayloadFor<T>`; `TelegramUpdate.payload` is a discriminated `WireUpdate` union; `buildMediaField` returns a discriminated `WireMediaField`; `getChatMember` / `getChatAdministrators` return a discriminated `WireChatMember` union on `status`. Route handlers parse input through `parseJsonBody(c, schema)`; errors are normalised to Telegram's `Bad Request: X is required` wording. No runtime behaviour change.

## 0.4.1

<!-- release:start -->

### Bug Fixes

- Include README in all `@emulators/*` npm packages
<!-- release:end -->

## 0.4.0

<!-- release:start -->

### New Features

- **Next.js adapter** — embed emulators directly in your Next.js app via `@emulators/adapter-next`, solving the Vercel preview deployment problem where OAuth callback URLs change with every deployment (#43)
- **MongoDB Atlas emulator** — local emulation of MongoDB Atlas with Data API support (#18)
- **Stripe emulator** — local emulation of Stripe billing and payment APIs (#4)
- **Resend emulator** — local emulation of the Resend email API (#7)
- **Okta emulator** — local emulation of Okta authentication and OIDC flows (#32)

### Improvements

- **Microsoft Entra ID** — added v1 OAuth token endpoint and Microsoft Graph `/users/{id}` route (#30)

### Bug Fixes

- Fixed multiple bugs, security hardening, and quality improvements across all emulators (#37)

### Contributors

- @AmorosoDavid12
- @ctate
- @jk4235
- @mvanhorn
<!-- release:end -->
