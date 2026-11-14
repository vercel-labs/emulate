---
name: google
description: Emulated Google OAuth 2.0, OpenID Connect, Gmail, Calendar, and Drive for local development and testing. Use when the user needs to test Google sign-in locally, emulate OIDC discovery, handle Google token exchange, configure Google OAuth clients, work with Gmail messages/drafts/threads/labels, manage Calendar events, upload or list Drive files, or work with Google userinfo without hitting real Google APIs. Triggers include "Google OAuth", "emulate Google", "mock Google login", "test Google sign-in", "OIDC emulator", "Google OIDC", "Gmail API", "Google Calendar", "Google Drive", "local Google auth", or any task requiring a local Google API.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# Google OAuth 2.0 / OIDC + Gmail, Calendar & Drive Emulator

OAuth 2.0 and OpenID Connect emulation with authorization code flow, PKCE support, ID tokens, OIDC discovery, refresh tokens, plus Gmail, Google Calendar, and Google Drive REST API surfaces.

## Start

Local listeners bind to `127.0.0.1` by default. For access from containers or other machines, pass `--host 0.0.0.0` to the CLI or `hostname: '0.0.0.0'` to `createEmulator`. Configure `--base-url` or `baseUrl` for advertised URLs reachable by those clients.

```bash
# Google only
npx emulate --service google

# Default port
# http://localhost:4002
```

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const google = await createEmulator({ service: 'google', port: 4002 })
// google.url === 'http://localhost:4002'
```

## Pointing Your App at the Emulator

### Environment Variable

```bash
GOOGLE_EMULATOR_URL=http://localhost:4002
```

### OAuth URL Mapping

| Real Google URL | Emulator URL |
|-----------------|-------------|
| `https://accounts.google.com/o/oauth2/v2/auth` | `$GOOGLE_EMULATOR_URL/o/oauth2/v2/auth` |
| `https://oauth2.googleapis.com/token` | `$GOOGLE_EMULATOR_URL/oauth2/token` |
| `https://www.googleapis.com/oauth2/v2/userinfo` | `$GOOGLE_EMULATOR_URL/oauth2/v2/userinfo` |
| `https://accounts.google.com/.well-known/openid-configuration` | `$GOOGLE_EMULATOR_URL/.well-known/openid-configuration` |
| `https://www.googleapis.com/oauth2/v3/certs` | `$GOOGLE_EMULATOR_URL/oauth2/v3/certs` |
| `https://gmail.googleapis.com/gmail/v1/...` | `$GOOGLE_EMULATOR_URL/gmail/v1/...` |
| `https://www.googleapis.com/calendar/v3/...` | `$GOOGLE_EMULATOR_URL/calendar/v3/...` |
| `https://www.googleapis.com/drive/v3/...` | `$GOOGLE_EMULATOR_URL/drive/v3/...` |

### google-auth-library (Node.js)

```typescript
import { OAuth2Client } from 'google-auth-library'

const GOOGLE_URL = process.env.GOOGLE_EMULATOR_URL ?? 'https://accounts.google.com'

const client = new OAuth2Client({
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  redirectUri: 'http://localhost:3000/api/auth/callback/google',
})

const emulatorAuthorizeUrl = `${GOOGLE_URL}/o/oauth2/v2/auth?client_id=${process.env.GOOGLE_CLIENT_ID}&redirect_uri=...&scope=openid+email+profile&response_type=code&state=...`
```

### Auth.js / NextAuth.js

```typescript
import Google from '@auth/core/providers/google'

Google({
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  authorization: {
    url: `${process.env.GOOGLE_EMULATOR_URL}/o/oauth2/v2/auth`,
    params: { scope: 'openid email profile' },
  },
  token: {
    url: `${process.env.GOOGLE_EMULATOR_URL}/oauth2/token`,
  },
  userinfo: {
    url: `${process.env.GOOGLE_EMULATOR_URL}/oauth2/v2/userinfo`,
  },
})
```

### Passport.js

```typescript
import { Strategy as GoogleStrategy } from 'passport-google-oauth20'

const GOOGLE_URL = process.env.GOOGLE_EMULATOR_URL ?? 'https://accounts.google.com'

new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: 'http://localhost:3000/api/auth/callback/google',
  authorizationURL: `${GOOGLE_URL}/o/oauth2/v2/auth`,
  tokenURL: `${GOOGLE_URL}/oauth2/token`,
  userProfileURL: `${GOOGLE_URL}/oauth2/v2/userinfo`,
}, verifyCallback)
```

## Seed Config

```yaml
google:
  users:
    - email: testuser@gmail.com
      name: Test User
      given_name: Test
      family_name: User
      picture: https://lh3.googleusercontent.com/a/default-user
      email_verified: true
      locale: en
    - email: dev@example.com
      name: Developer
    - email: admin@acme.com
      name: Admin
      hd: acme.com
  oauth_clients:
    - client_id: my-client-id.apps.googleusercontent.com
      client_secret: GOCSPX-secret
      name: My App
      redirect_uris:
        - http://localhost:3000/api/auth/callback/google
  labels:
    - id: Label_ops
      user_email: testuser@gmail.com
      name: Ops/Review
      color_background: "#DDEEFF"
      color_text: "#111111"
  messages:
    - id: msg_welcome
      user_email: testuser@gmail.com
      thread_id: thr_welcome
      from: "welcome@example.com"
      to: testuser@gmail.com
      subject: Welcome to the Gmail emulator
      body_text: You can now test Gmail flows locally.
      label_ids: [INBOX, UNREAD, CATEGORY_UPDATES]
      date: "2025-01-04T10:00:00.000Z"
  calendars:
    - id: primary
      user_email: testuser@gmail.com
      summary: testuser@gmail.com
      primary: true
      selected: true
      time_zone: UTC
  calendar_events:
    - id: evt_kickoff
      user_email: testuser@gmail.com
      calendar_id: primary
      summary: Project Kickoff
      start_date_time: "2025-01-10T09:00:00.000Z"
      end_date_time: "2025-01-10T09:30:00.000Z"
      attendees:
        - email: testuser@gmail.com
          display_name: Test User
      conference_entry_points:
        - entry_point_type: video
          uri: https://meet.google.com/example
          label: Google Meet
      hangout_link: https://meet.google.com/example
  drive_items:
    - id: drv_docs
      user_email: testuser@gmail.com
      name: Docs
      mime_type: application/vnd.google-apps.folder
      parent_ids: [root]
    - id: drv_readme
      user_email: testuser@gmail.com
      name: README.md
      mime_type: text/markdown
      parent_ids: [drv_docs]
      data: "# Hello World"
```

When no OAuth clients are configured, the emulator accepts any `client_id`. With clients configured, strict validation is enforced for `client_id`, `client_secret`, and `redirect_uri`.

Google authentication is permissive by default for local bearer-token workflows. Set `google.strict_scopes: true` in seed config to require emulator-issued, unexpired access tokens on Gmail, Calendar, Drive, and userinfo routes. Invalid credentials return `401 UNAUTHENTICATED`; missing method scopes return `403` with `insufficientPermissions`. Strict mode distinguishes read, write, send, settings, and metadata scopes, and userinfo includes only granted identity claims. Revoking an access or refresh token invalidates the linked access and refresh credentials. Discovery, signing keys, and the sign-in page remain public. This mode checks method scopes; resource-specific grants such as `drive.file` and Gmail add-on scopes are not modeled.

### Hosted domain (hd) claim

Google Workspace accounts include an `hd` claim in ID tokens and userinfo responses identifying the user's hosted domain. The emulator derives this automatically from the user's email domain. Consumer domains (`gmail.com`, `googlemail.com`) omit the claim, matching real Google behavior.

To override the derived value, set `hd` on a seeded user. To suppress the claim entirely, set `hd` to an empty string.

## OAuth / OIDC Endpoints

### OIDC Discovery

```bash
curl http://localhost:4002/.well-known/openid-configuration
```

### JWKS

```bash
curl http://localhost:4002/oauth2/v3/certs
```

Returns the RSA public key used to verify the ID tokens issued by the emulator. Google ID tokens use RS256, and the discovery document advertises the same algorithm.

### Authorization

```bash
# Browser flow: redirects to a user picker page
curl -v "http://localhost:4002/o/oauth2/v2/auth?\
client_id=my-client-id.apps.googleusercontent.com&\
redirect_uri=http://localhost:3000/api/auth/callback/google&\
scope=openid+email+profile&\
response_type=code&\
state=random-state&\
nonce=random-nonce"
```

Supports `code_challenge` and `code_challenge_method` for PKCE.

### Token Exchange

```bash
curl -X POST http://localhost:4002/oauth2/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "code=<authorization_code>&\
client_id=my-client-id.apps.googleusercontent.com&\
client_secret=GOCSPX-secret&\
redirect_uri=http://localhost:3000/api/auth/callback/google&\
grant_type=authorization_code"
```

The client can also send its credentials in an HTTP Basic `Authorization` header (`client_secret_basic`):

```bash
curl -X POST http://localhost:4002/oauth2/token \
  -u "my-client-id.apps.googleusercontent.com:GOCSPX-secret" \
  -d "code=<authorization_code>&\
redirect_uri=http://localhost:3000/api/auth/callback/google&\
grant_type=authorization_code"
```

Body credentials sent with the header must repeat it: a different `client_id` or `client_secret`, or a `client_secret` without `client_id`, returns `400 invalid_request`. The Basic username and password are compared as sent, without form-decoding, as Google does. Client credentials are only checked when OAuth clients are configured.

Also accepts `application/json` body. Returns:

```json
{
  "access_token": "google_...",
  "refresh_token": "google_refresh_...",
  "id_token": "<jwt>",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "openid email profile"
}
```

### Refresh Token

```bash
curl -X POST http://localhost:4002/oauth2/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "refresh_token=google_refresh_...&\
client_id=my-client-id.apps.googleusercontent.com&\
client_secret=GOCSPX-secret&\
grant_type=refresh_token"
```

Returns a new `access_token` (no new `refresh_token` or `id_token` on refresh).

### User Info

```bash
curl http://localhost:4002/oauth2/v2/userinfo \
  -H "Authorization: Bearer google_..."
```

### Token Revocation

```bash
curl -X POST http://localhost:4002/oauth2/revoke \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "token=google_..."
```

### Service Accounts

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

The assertion must be RS256-signed by one of the account's keys, with `iss` set to the account's `client_email`, a space-delimited `scope`, `aud` set to `https://oauth2.googleapis.com/token`, and an `exp` at most 65 minutes after `iat`. A `kid` that names none of the account's keys falls back to trying every key. The response has `access_token`, `expires_in: 3600`, `scope`, and `token_type: Bearer`, and no refresh token. Without `sub`, the token acts as the service account. With `sub`, it acts as that user, and every requested scope must be granted to the account's `client_id` under `google.domain_wide_delegation`. Under `google.strict_scopes`, Gmail, Calendar, and Drive check the token's scopes as they do for other tokens.

Errors follow Google's JWT error table: `invalid_scope` for an empty `scope`, `invalid_grant` for an unknown `sub` user, an unknown account, a bad signature, a wrong audience, or an expired or too-long-lived assertion, `401 unauthorized_client` when the account has no delegation or none of the requested scopes are delegated, and `403 access_denied` when only some of them are. The other errors return `400`. User suspension, key expiry, and `target_audience` ID tokens are not modeled.

```bash
curl -X POST http://localhost:4002/oauth2/token \
  -d "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<signed JWT>"
```

## Gmail API

All Gmail endpoints are under `/gmail/v1/users/:userId/...` where `:userId` is `me` or the authenticated user's email.

### Messages

```bash
# List messages (filter by labels, search query)
curl "http://localhost:4002/gmail/v1/users/me/messages?labelIds=INBOX&q=from:welcome&maxResults=10" \
  -H "Authorization: Bearer $TOKEN"

# Get message (format: full, metadata, minimal, raw)
curl "http://localhost:4002/gmail/v1/users/me/messages/msg_welcome?format=full" \
  -H "Authorization: Bearer $TOKEN"

# Send message
curl -X POST http://localhost:4002/gmail/v1/users/me/messages/send \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"to": "someone@example.com", "subject": "Hello", "body_text": "Hi there"}'

# Insert message (bypass send)
curl -X POST http://localhost:4002/gmail/v1/users/me/messages \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"to": "test@example.com", "from": "me@example.com", "subject": "Test", "body_text": "Body", "labelIds": ["INBOX"]}'

# Import message
curl -X POST http://localhost:4002/gmail/v1/users/me/messages/import \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"to": "test@example.com", "from": "external@example.com", "subject": "Imported", "body_text": "Content"}'

# Modify labels on a message
curl -X POST http://localhost:4002/gmail/v1/users/me/messages/msg_welcome/modify \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"addLabelIds": ["STARRED"], "removeLabelIds": ["UNREAD"]}'

# Trash / untrash
curl -X POST http://localhost:4002/gmail/v1/users/me/messages/msg_welcome/trash \
  -H "Authorization: Bearer $TOKEN"
curl -X POST http://localhost:4002/gmail/v1/users/me/messages/msg_welcome/untrash \
  -H "Authorization: Bearer $TOKEN"

# Delete permanently
curl -X DELETE http://localhost:4002/gmail/v1/users/me/messages/msg_welcome \
  -H "Authorization: Bearer $TOKEN"

# Batch modify
curl -X POST http://localhost:4002/gmail/v1/users/me/messages/batchModify \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ids": ["msg_welcome", "msg_build"], "addLabelIds": ["STARRED"]}'

# Batch delete
curl -X POST http://localhost:4002/gmail/v1/users/me/messages/batchDelete \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ids": ["msg_welcome"]}'

# Get attachment
curl http://localhost:4002/gmail/v1/users/me/messages/msg_id/attachments/att_id \
  -H "Authorization: Bearer $TOKEN"
```

Upload variants also available at `/upload/gmail/v1/users/:userId/messages`, `.../messages/send`, `.../messages/import`.

`messages.send` and `drafts.send` deliver the message to each `To`, `Cc`, and `Bcc` recipient who is a user of the emulator. The recipient gets a copy labeled `INBOX` and `UNREAD`, without the `Bcc` header, threaded with the messages it replies to in their mailbox, and with their filters applied. Recipients who aren't emulator users are skipped. A message sent to yourself stays one message, labeled `SENT`, `INBOX`, and `UNREAD`. `messages.insert` and `messages.import` don't deliver.

### Drafts

```bash
# List drafts
curl http://localhost:4002/gmail/v1/users/me/drafts \
  -H "Authorization: Bearer $TOKEN"

# Create draft
curl -X POST http://localhost:4002/gmail/v1/users/me/drafts \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": {"to": "someone@example.com", "subject": "Draft subject", "body_text": "Draft body"}}'

# Get draft (format: full, metadata, minimal, raw)
curl "http://localhost:4002/gmail/v1/users/me/drafts/draft_id?format=full" \
  -H "Authorization: Bearer $TOKEN"

# Update draft
curl -X PUT http://localhost:4002/gmail/v1/users/me/drafts/draft_id \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": {"subject": "Updated subject", "body_text": "Updated body"}}'

# Send draft
curl -X POST http://localhost:4002/gmail/v1/users/me/drafts/send \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id": "draft_id"}'

# Delete draft
curl -X DELETE http://localhost:4002/gmail/v1/users/me/drafts/draft_id \
  -H "Authorization: Bearer $TOKEN"
```

### Threads

```bash
# List threads (filter by labels, search query)
curl "http://localhost:4002/gmail/v1/users/me/threads?labelIds=INBOX&maxResults=20" \
  -H "Authorization: Bearer $TOKEN"

# Get thread (all messages in thread)
curl "http://localhost:4002/gmail/v1/users/me/threads/thr_welcome?format=full" \
  -H "Authorization: Bearer $TOKEN"

# Modify labels on all messages in thread
curl -X POST http://localhost:4002/gmail/v1/users/me/threads/thr_welcome/modify \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"addLabelIds": ["STARRED"], "removeLabelIds": ["UNREAD"]}'

# Trash / untrash / delete thread
curl -X POST http://localhost:4002/gmail/v1/users/me/threads/thr_welcome/trash \
  -H "Authorization: Bearer $TOKEN"
curl -X DELETE http://localhost:4002/gmail/v1/users/me/threads/thr_welcome \
  -H "Authorization: Bearer $TOKEN"
```

### Labels

```bash
# List labels
curl http://localhost:4002/gmail/v1/users/me/labels \
  -H "Authorization: Bearer $TOKEN"

# Get label
curl http://localhost:4002/gmail/v1/users/me/labels/INBOX \
  -H "Authorization: Bearer $TOKEN"

# Create label
curl -X POST http://localhost:4002/gmail/v1/users/me/labels \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "My Label", "color": {"backgroundColor": "#DDEEFF", "textColor": "#111111"}}'

# Update label (PUT replaces, PATCH merges)
curl -X PATCH http://localhost:4002/gmail/v1/users/me/labels/Label_ops \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Ops/Reviewed"}'

# Delete label (user labels only)
curl -X DELETE http://localhost:4002/gmail/v1/users/me/labels/Label_ops \
  -H "Authorization: Bearer $TOKEN"
```

### History & Watch

```bash
# List history changes since a given historyId
curl "http://localhost:4002/gmail/v1/users/me/history?startHistoryId=1&historyTypes=messageAdded&maxResults=100" \
  -H "Authorization: Bearer $TOKEN"

# Set up push notification watch (stub)
curl -X POST http://localhost:4002/gmail/v1/users/me/watch \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"topicName": "projects/my-project/topics/gmail", "labelIds": ["INBOX"]}'

# Stop watch
curl -X POST http://localhost:4002/gmail/v1/users/me/stop \
  -H "Authorization: Bearer $TOKEN"
```

### Settings

```bash
# List filters
curl http://localhost:4002/gmail/v1/users/me/settings/filters \
  -H "Authorization: Bearer $TOKEN"

# Create filter (auto-label incoming messages matching criteria)
curl -X POST http://localhost:4002/gmail/v1/users/me/settings/filters \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"criteria": {"from": "alerts@example.com"}, "action": {"addLabelIds": ["Label_ops"]}}'

# Delete filter
curl -X DELETE http://localhost:4002/gmail/v1/users/me/settings/filters/filter_id \
  -H "Authorization: Bearer $TOKEN"

# List forwarding addresses
curl http://localhost:4002/gmail/v1/users/me/settings/forwardingAddresses \
  -H "Authorization: Bearer $TOKEN"

# List send-as aliases
curl http://localhost:4002/gmail/v1/users/me/settings/sendAs \
  -H "Authorization: Bearer $TOKEN"
```

## Google Calendar API

### Discovery

The Calendar discovery document is public and describes the Calendar v3 methods supported by the emulator:

```bash
curl http://localhost:4002/discovery/v1/apis/calendar/v3/rest
```

### Calendar List

```bash
curl http://localhost:4002/calendar/v3/users/me/calendarList \
  -H "Authorization: Bearer $TOKEN"
```

### Events

```bash
# List events (filter by time range, search, order)
curl "http://localhost:4002/calendar/v3/calendars/primary/events?\
timeMin=2025-01-01T00:00:00Z&timeMax=2025-12-31T23:59:59Z&maxResults=50&orderBy=startTime" \
  -H "Authorization: Bearer $TOKEN"

# Create event
curl -X POST http://localhost:4002/calendar/v3/calendars/primary/events \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"summary": "Team Meeting", "start": {"dateTime": "2025-01-10T14:00:00Z"}, "end": {"dateTime": "2025-01-10T15:00:00Z"}, "attendees": [{"email": "dev@example.com"}]}'

# Delete event
curl -X DELETE http://localhost:4002/calendar/v3/calendars/primary/events/evt_kickoff \
  -H "Authorization: Bearer $TOKEN"
```

### FreeBusy

```bash
curl -X POST http://localhost:4002/calendar/v3/freeBusy \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"timeMin": "2025-01-10T00:00:00Z", "timeMax": "2025-01-10T23:59:59Z", "items": [{"id": "primary"}]}'
```

## Google Drive API

### Files

```bash
# List files (with query filter, pagination, ordering)
curl "http://localhost:4002/drive/v3/files?q='root'+in+parents&pageSize=20" \
  -H "Authorization: Bearer $TOKEN"

# Create file (JSON metadata)
curl -X POST http://localhost:4002/drive/v3/files \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "notes.txt", "mimeType": "text/plain", "parents": ["root"]}'

# Create file with content (multipart/related upload)
curl -X POST http://localhost:4002/upload/drive/v3/files \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: multipart/related; boundary=boundary" \
  --data-binary $'--boundary\r\nContent-Type: application/json\r\n\r\n{"name":"data.csv","mimeType":"text/csv"}\r\n--boundary\r\nContent-Type: text/csv\r\n\r\na,b,c\n1,2,3\r\n--boundary--'

# Get file metadata
curl http://localhost:4002/drive/v3/files/drv_readme \
  -H "Authorization: Bearer $TOKEN"

# Download file content
curl "http://localhost:4002/drive/v3/files/drv_readme?alt=media" \
  -H "Authorization: Bearer $TOKEN"

# Update file (PATCH or PUT; move parents with query params)
curl -X PATCH "http://localhost:4002/drive/v3/files/drv_readme?addParents=folder_id&removeParents=root" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "README-updated.md"}'
```

## Common Patterns

### Full Authorization Code Flow

```bash
GOOGLE_URL="http://localhost:4002"
CLIENT_ID="my-client-id.apps.googleusercontent.com"
CLIENT_SECRET="GOCSPX-secret"
REDIRECT_URI="http://localhost:3000/api/auth/callback/google"

# 1. Open in browser (user picks a seeded account)
#    $GOOGLE_URL/o/oauth2/v2/auth?client_id=$CLIENT_ID&redirect_uri=$REDIRECT_URI&scope=openid+email+profile&response_type=code&state=abc

# 2. After user selection, emulator redirects to:
#    $REDIRECT_URI?code=<code>&state=abc

# 3. Exchange code for tokens
curl -X POST $GOOGLE_URL/oauth2/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "code=<code>&client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET&redirect_uri=$REDIRECT_URI&grant_type=authorization_code"

# 4. Fetch user info with the access_token
curl $GOOGLE_URL/oauth2/v2/userinfo \
  -H "Authorization: Bearer <access_token>"
```

### OIDC Discovery-Based Setup

```typescript
import { Issuer } from 'openid-client'

const googleIssuer = await Issuer.discover(
  process.env.GOOGLE_EMULATOR_URL ?? 'https://accounts.google.com'
)

const client = new googleIssuer.Client({
  client_id: process.env.GOOGLE_CLIENT_ID,
  client_secret: process.env.GOOGLE_CLIENT_SECRET,
  redirect_uris: ['http://localhost:3000/api/auth/callback/google'],
})
```

### Send a Gmail Message and Check the Thread

```bash
TOKEN="test_token_admin"
BASE="http://localhost:4002"

# Send a message
curl -X POST $BASE/gmail/v1/users/me/messages/send \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"to": "someone@example.com", "subject": "Test", "body_text": "Hello"}'

# List threads in INBOX
curl "$BASE/gmail/v1/users/me/threads?labelIds=INBOX" \
  -H "Authorization: Bearer $TOKEN"
```

## Custom emulators alongside built-ins

Use `npx emulate init --custom inventory` to scaffold a third-party API emulator and test. Register it in `emulate.config.ts` with `defineConfig` from `emulate`, alongside built-in entries such as `{ emulator: "google" }`. Run `npx emulate start --watch` to reload imports and inspect custom state at the printed `/_emulate` URL. Successful reloads reset the run to seed. Existing flat seed configs still work; `--config` selects an explicit file. For authoring and testing third-party API emulators, see https://emulate.dev/docs/custom-emulators.
