---
name: google
description: Emulated Google OAuth 2.0, OpenID Connect, Gmail, Calendar, and Drive for local development and testing. Use when the user needs to test Google sign-in locally, emulate OIDC discovery, handle Google token exchange, configure Google OAuth clients, work with Gmail messages/drafts/threads/labels, manage Calendar events, upload or list Drive files, or work with Google userinfo without hitting real Google APIs. Triggers include "Google OAuth", "emulate Google", "mock Google login", "test Google sign-in", "OIDC emulator", "Google OIDC", "Gmail API", "Google Calendar", "Google Drive", "local Google auth", or any task requiring a local Google API.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(curl:*)
---

# Google OAuth 2.0 / OIDC + Gmail, Calendar & Drive Emulator

OAuth 2.0 and OpenID Connect emulation with authorization code flow, PKCE support, ID tokens, OIDC discovery, refresh tokens, plus Gmail, Google Calendar, and Google Drive REST API surfaces.

## Start

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

## OAuth / OIDC Endpoints

### OIDC Discovery

```bash
curl http://localhost:4002/.well-known/openid-configuration
```

### JWKS

```bash
curl http://localhost:4002/oauth2/v3/certs
```

Returns `{ "keys": [] }`. ID tokens are signed with HS256 using an internal secret.

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
