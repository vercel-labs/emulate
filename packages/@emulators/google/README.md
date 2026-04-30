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
- `GET /oauth2/v3/certs` — JSON Web Key Set (JWKS)

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
- `GET /discovery/v1/apis/calendar/v3/rest` — Calendar API discovery document (no auth required)
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

Standard OAuth 2.0 authorization code flow. Configure clients in the seed config.

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
