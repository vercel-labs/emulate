# Changelog

## 0.6.0

<!-- release:start -->
### New Features

- **Native Go runtime** — the CLI now ships platform native binaries and runs services through the Go engine (#103, #133)
- **API Gateway v2 and Lambda** — local HTTP API proxy events, Lambda control plane APIs, and Node.js Lambda invocation support (#144, #145, #147)
- **EventBridge Lambda targets** — EventBridge rules can now deliver events to Lambda functions in the AWS emulator (#146)
- **Expanded AWS coverage** — added DynamoDB, SNS, CloudWatch Logs, Secrets Manager, SSM Parameter Store, KMS, and deeper IAM and STS support (#122, #123, #136, #138, #139, #140, #143)
- **Native service parity** — added Go backed implementations for Apple, Clerk, GitHub, Google, Microsoft Entra, MongoDB Atlas, Okta, Resend, Slack, Stripe, and Vercel (#114, #119, #120, #124, #125, #126, #127, #128, #129, #130, #131)
- **Vercel and Next.js foundations** — added Vercel API parity, Go Function scaffolding, and the Next proxy adapter foundation (#116, #117, #118, #119)

### Improvements

- **AWS SDK compatibility** — hardened gateway parsing, SigV4 auth, AWS error responses, S3 range and conditional reads, and SQS batch APIs (#107, #108, #141, #142)
- **Package compatibility facades** — package APIs now route to native implementations while preserving existing SDK entry points (#135)
- **Dependency policy** — added a minimum dependency release age requirement (#137)
- **Development runtime** — moved the repo to pnpm 11 and Node.js 24 (#115)
- **Docs and agent skills** — updated README, docs site, and service skills for the native runtime and expanded service coverage (#87, #119, #120, #124, #125, #126, #127, #128, #129, #130, #131)

### Breaking Changes

- **Node service engines removed** — emulator services now run through the native Go engine instead of the previous Hono based Node service implementations (#102, #134)

### Contributors

- @ctate
<!-- release:end -->

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
