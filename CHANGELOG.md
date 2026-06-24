# Changelog

<!-- release:start -->
## 0.8.0

### New Features

- **Twilio emulator** — local Twilio API emulation with accounts, phone numbers, messages, calls, conversations, messaging services, Verify flows, simulator endpoints, SDK conformance tests, and inspector support (#185)
- **Twilio SMS verification example** — working Next.js example for SMS verification with the Twilio emulator and local session handling (#186)

### Improvements

- **Twilio docs and agent guidance** — added README, docs site, and skill coverage for local Twilio development (#185, #186)

### Contributors

- @ctate

<!-- release:end -->

## 0.7.0

### New Features

- **Linear emulator** — stateful Linear GraphQL API emulation with seeded organizations, users, teams, workflow states, issues, comments, labels, projects, cycles, OAuth apps, tokens, webhooks, agent sessions, and local inspector support (#180)

### Improvements

- **Linear docs and agent guidance** — added README, docs site, programmatic API, and skill coverage for Linear API, OAuth, and webhook testing (#180)

### Contributors

- @ctate

## 0.6.1

### New Features

- **Vercel Blob emulator** — local emulation for Vercel Blob store operations, including uploads, downloads, listings, deletes, copy support, and inspector visibility (#175)

### Improvements

- **Vercel Blob examples** — added and hardened an example app that exercises upload sharing URL handling

### Contributors

- @ctate

## 0.6.0

### New Features

- **Expanded Slack emulator support** — stateful Slack writes for rich chat messages, updates, deletes, permalinks, ephemeral and scheduled messages, conversations and DMs, OAuth installs and scopes, user profiles and presence, modern file uploads, pins and bookmarks, App Home views, modals, inspector tabs, event delivery visibility, docs, and coverage matrix (#152-#164)

### Improvements

- **Slack SDK coverage** — added Slack WebClient conformance tests and route coverage for the supported Slack Web API surface (#152-#164)
- **Slack docs** — audited README, package docs, web docs, skill guidance, CLI seed output, strict scope notes, and unsupported Slack families against the implemented surface (#164)

### Contributors

- @ctate

## 0.5.0

### New Features

- **Clerk emulator** — local emulation of Clerk authentication and session management (#38)
- **Portless integration** — embed emulators directly in your app without dedicated ports, with base URL override support (#78)
- **Google `hd` claim** — hosted domain claim in ID tokens and userinfo for Google OAuth (#73)
- **Stripe Checkout example** — full working example of Stripe Checkout with the Stripe emulator (#82)
- **Resend magic link example** — working example of Resend magic link authentication flow (#51)
- **Docs landing page** — new landing page for the docs site (#81)

### Improvements

- **Unified UI design system** — all emulator UIs now share a consistent design system with CI quality checks (#50)
- **Stripe** — added customer sessions and payment methods API (#47)

### Bug Fixes

- Fixed **AWS S3** emulator compatibility with the official AWS SDK wire format (#65, #69)
- Fixed **Resend** email inbox links not being clickable in preview (#80)

### Contributors

- @ctate
- @disintegrator
- @jlucaso1
- @Railly
- @tmm

## 0.4.1

### Bug Fixes

- Include README in all `@emulators/*` npm packages

## 0.4.0

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
