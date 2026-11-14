# @emulators/google

Google OAuth 2.0, OpenID Connect, and mutable Google Workspace-style surfaces for local Gmail, Calendar, and Drive flows.

Part of [emulate](https://github.com/vercel-labs/emulate) — local drop-in replacement services for CI and no-network sandboxes.

## Install

```bash
npm install @emulators/google
```

## Endpoints

### OAuth & OIDC
- `GET /o/oauth2/v2/auth` — authorization endpoint
- `POST /oauth2/token` — token exchange
- `GET /oauth2/v2/userinfo` — get user info
- `GET /.well-known/openid-configuration` — OIDC discovery document
- `GET /oauth2/v3/certs` — JSON Web Key Set (JWKS) with the RSA public key for ID token verification

When OAuth clients are configured, `POST /oauth2/token` takes the client's credentials as `client_id` and `client_secret` in the body (`client_secret_post`) or in an HTTP Basic `Authorization` header (`client_secret_basic`), for both the authorization code and refresh token grants. Body credentials sent with the header must repeat it: a different `client_id` or `client_secret`, or a `client_secret` without `client_id`, returns `400 invalid_request`. As Google does, the emulator compares the Basic username and password as sent, without form-decoding them.

### Service accounts

`POST /oauth2/token` accepts the JWT bearer grant (`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`) for service accounts seeded under `google.service_accounts`. Each key takes the `key_id` from the account's key file and its PEM public key or X.509 certificate, so the private key stays with the code under test.

```yaml
google:
  users:
    - email: alice@example.com
  service_accounts:
    - client_email: archiver@my-project.iam.gserviceaccount.com
      client_id: "104523180291234567890"
      keys:
        - key_id: 5f0c2b7e9a
          public_key: |
            -----BEGIN PUBLIC KEY-----
            ...
            -----END PUBLIC KEY-----
  domain_wide_delegation:
    - client_id: "104523180291234567890"
      scopes:
        - https://www.googleapis.com/auth/gmail.readonly
```

The assertion must be RS256-signed by one of the account's keys, with `iss` set to the account's `client_email`, a space-delimited `scope`, `aud` set to `https://oauth2.googleapis.com/token` or the emulator's own `/oauth2/token` URL, and an `exp` at most 65 minutes after `iat`. A `kid` that names none of the account's keys falls back to trying every key. The response has `access_token`, `expires_in: 3600`, `scope`, and `token_type: Bearer`, and no refresh token. Without `sub`, the token acts as the service account, including under `google.strict_scopes`. With `sub`, it acts as that user, and every requested scope must be granted to the account's `client_id` under `google.domain_wide_delegation`. Under `google.strict_scopes`, Gmail, Calendar, and Drive check the token's scopes as they do for other tokens.

Errors follow Google's JWT error table: `invalid_scope` for an empty `scope`, `invalid_grant` for an unknown `sub` user, an unknown account, a bad signature, a wrong audience, or an expired or too-long-lived assertion, `401 unauthorized_client` when the account has no delegation or none of the requested scopes are delegated, and `403 access_denied` when only some of them are. The other errors return `400`. User suspension, key expiry, and `target_audience` ID tokens are not modeled.

### Gmail
- `GET /gmail/v1/users/:userId/messages` — list messages with `q`, `labelIds`, `maxResults`, and `pageToken`
- `GET /gmail/v1/users/:userId/messages/:id` — fetch message in `full`, `metadata`, `minimal`, or `raw` formats
- `GET /gmail/v1/users/:userId/messages/:messageId/attachments/:id` — fetch attachment bodies
- `POST /gmail/v1/users/:userId/messages/send` — create sent mail from `raw` MIME or structured fields
- `POST /gmail/v1/users/:userId/messages/import` — import inbox mail
- `POST /gmail/v1/users/:userId/messages` — insert a message directly
- `POST /gmail/v1/users/:userId/messages/:id/modify` — add/remove labels on one message
- `POST /gmail/v1/users/:userId/messages/batchModify` — add/remove labels across many messages
- `POST /gmail/v1/users/:userId/messages/:id/trash` — trash message
- `POST /gmail/v1/users/:userId/messages/:id/untrash` — untrash message

`messages.send` and `drafts.send` deliver the message to each `To`, `Cc`, and `Bcc` recipient who is a user of the emulator. The recipient gets a copy labeled `INBOX` and `UNREAD`, without the `Bcc` header, threaded with the messages it replies to in their mailbox, and with their filters applied. Recipients who aren't emulator users are skipped. A message sent to yourself stays one message, labeled `SENT`, `INBOX`, and `UNREAD`, unless your own filters remove those labels. `messages.insert` and `messages.import` don't deliver.

### Drafts
- `GET /gmail/v1/users/:userId/drafts` — list drafts
- `POST /gmail/v1/users/:userId/drafts` — create draft
- `GET /gmail/v1/users/:userId/drafts/:id` — get draft
- `PUT /gmail/v1/users/:userId/drafts/:id` — update draft
- `POST /gmail/v1/users/:userId/drafts/:id/send` — send draft
- `DELETE /gmail/v1/users/:userId/drafts/:id` — delete draft

### Threads
- `GET /gmail/v1/users/:userId/threads` — list threads
- `GET /gmail/v1/users/:userId/threads/:id` — get thread
- `POST /gmail/v1/users/:userId/threads/:id/modify` — add/remove labels across a thread

### Labels
- `GET /gmail/v1/users/:userId/labels` — list labels
- `POST /gmail/v1/users/:userId/labels` — create label
- `PATCH /gmail/v1/users/:userId/labels/:id` — update label
- `DELETE /gmail/v1/users/:userId/labels/:id` — delete label

### History, Watch & Settings
- `GET /gmail/v1/users/:userId/history` — list history
- `POST /gmail/v1/users/:userId/watch` — set up push notifications
- `POST /gmail/v1/users/:userId/stop` — stop push notifications
- `GET /gmail/v1/users/:userId/settings/filters` — list filters
- `POST /gmail/v1/users/:userId/settings/filters` — create filter
- `DELETE /gmail/v1/users/:userId/settings/filters/:id` — delete filter
- `GET /gmail/v1/users/:userId/settings/forwardingAddresses` — list forwarding addresses
- `GET /gmail/v1/users/:userId/settings/sendAs` — list send-as aliases

### Calendar
- `GET /discovery/v1/apis/calendar/v3/rest` — public Calendar v3 REST discovery document
- `GET /calendar/v3/users/:userId/calendarList` — list calendars
- `GET /calendar/v3/calendars/:calendarId/events` — list events
- `POST /calendar/v3/calendars/:calendarId/events` — create event
- `DELETE /calendar/v3/calendars/:calendarId/events/:eventId` — delete event
- `POST /calendar/v3/freeBusy` — free/busy query

### Drive
- `GET /drive/v3/files` — list files
- `GET /drive/v3/files/:fileId` — get file metadata
- `POST /drive/v3/files` — create file
- `PATCH /drive/v3/files/:fileId` — update file metadata
- `PUT /drive/v3/files/:fileId` — update file content
- `POST /upload/drive/v3/files` — upload file

## Auth

Standard OAuth 2.0 authorization code flow with RS256-signed OIDC ID tokens. Configure clients in the seed config. The discovery document advertises RS256 and `/oauth2/v3/certs` returns the RSA public key used to verify issued ID tokens.

## Seed Configuration

```yaml
google:
  users:
    - email: testuser@example.com
      name: Test User
  oauth_clients:
    - client_id: my-client-id.apps.googleusercontent.com
      client_secret: GOCSPX-secret
      redirect_uris:
        - http://localhost:3000/api/auth/callback/google
  labels:
    - id: Label_ops
      user_email: testuser@example.com
      name: Ops/Review
  messages:
    - id: msg_welcome
      user_email: testuser@example.com
      from: welcome@example.com
      to: testuser@example.com
      subject: Welcome to the Gmail emulator
      body_text: You can now test Gmail, Calendar, and Drive flows locally.
      label_ids: [INBOX, UNREAD, CATEGORY_UPDATES]
  calendars:
    - id: primary
      user_email: testuser@example.com
      summary: testuser@example.com
      primary: true
      time_zone: UTC
  calendar_events:
    - id: evt_kickoff
      user_email: testuser@example.com
      calendar_id: primary
      summary: Project Kickoff
      start_date_time: 2025-01-10T09:00:00.000Z
      end_date_time: 2025-01-10T09:30:00.000Z
  drive_items:
    - id: drv_docs
      user_email: testuser@example.com
      name: Docs
      mime_type: application/vnd.google-apps.folder
      parent_ids: [root]
```

## Links

- [Full documentation](https://emulate.dev/google)
- [GitHub](https://github.com/vercel-labs/emulate)
