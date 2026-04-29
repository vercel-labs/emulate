# Changelog

## 0.5.0

<!-- release:start -->
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
<!-- release:end -->

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
