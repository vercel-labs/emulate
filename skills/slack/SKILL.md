---
name: slack
description: Emulated Slack API for local development and testing. Use when the user needs to interact with Slack API endpoints locally, test Slack integrations, emulate channels/messages/users/views, set up Slack OAuth flows, test incoming webhooks, or work with the Slack Web API without hitting the real Slack API. Triggers include "Slack API", "emulate Slack", "mock Slack", "test Slack OAuth", "Slack bot", "Slack views", "incoming webhook", "local Slack", or any task requiring a local Slack API.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# Slack API Emulator

Fully stateful Slack Web API emulation with channels, messages, threads, reactions, user profiles, presence, modern file uploads, pins, bookmarks, views, OAuth v2, and incoming webhooks. Chat writes preserve common rich message fields such as `blocks`, `attachments`, `metadata`, formatting flags, unfurl flags, and client message ids. Conversation writes update archive state, names, topics, purposes, membership, DMs, MPIMs, and read cursors. User writes update profile fields, status, custom fields, and deterministic active or away presence. File writes support the current external upload flow with local upload URLs, file share messages, reads, lists, downloads, and deletes. Pin and bookmark writes support channel message pins and link bookmarks. View writes support App Home publishing and modal stacks. Seeded OAuth apps and OAuth installs create bot users and installation records. OAuth exchanges and explicit token seeds create scoped token records. State changes dispatch `event_callback` payloads to configured webhook URLs.

## Start

```bash
# Slack only
npx emulate --service slack

# Default port (when run alone)
# http://localhost:4000
```

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const slack = await createEmulator({ service: 'slack', port: 4003 })
// slack.url === 'http://localhost:4003'
```

## Auth

Pass tokens as `Authorization: Bearer <token>`. All Web API endpoints require authentication.

```bash
curl -X POST http://localhost:4003/api/auth.test \
  -H "Authorization: Bearer test_token_admin"
```

Requests without a token return `not_authed`. In relaxed scope mode, any non-empty unknown bearer token maps to the first seeded user.

Scope checks are relaxed by default for local development. Set `slack.strict_scopes: true` in seed config when you need supported Web API methods to return Slack-style `missing_scope` errors with `needed` and `provided` fields. Strict mode checks `chat:write`, `channels:read`, `channels:history`, `channels:join`, `channels:manage`, `channels:write`, `groups:read`, `groups:history`, `groups:write`, `im:read`, `im:history`, `im:write`, `mpim:read`, `mpim:history`, `mpim:write`, `users:read`, `users:read.email`, `users.profile:read`, `users.profile:write`, `users:write`, `files:read`, `files:write`, `pins:read`, `pins:write`, `bookmarks:read`, `bookmarks:write`, `reactions:read`, `reactions:write`, and `team:read`. Slack lists no method-specific scopes for `views.publish`, `views.open`, `views.update`, or `views.push`, so the emulator requires auth but does not add strict-scope checks for those methods.

Chat writes and incoming webhooks apply Slack-compatible message limits: top-level `text` is truncated at 40,000 characters with a `message_truncated` warning, while oversized rich payloads such as too many blocks or overlong block text return Slack-style errors.

## Pointing Your App at the Emulator

### Environment Variable

```bash
SLACK_EMULATOR_URL=http://localhost:4003
```

### Slack SDK / Bolt

```typescript
import { WebClient } from '@slack/web-api'

const client = new WebClient(token, {
  slackApiUrl: `${process.env.SLACK_EMULATOR_URL}/api/`,
})
```

### OAuth URL Mapping

| Real Slack URL | Emulator URL |
|----------------|-------------|
| `https://slack.com/oauth/v2/authorize` | `$SLACK_EMULATOR_URL/oauth/v2/authorize` |
| `https://slack.com/api/oauth.v2.access` | `$SLACK_EMULATOR_URL/api/oauth.v2.access` |

### Auth.js / NextAuth.js

```typescript
{
  id: 'slack',
  name: 'Slack',
  type: 'oauth',
  authorization: {
    url: `${process.env.SLACK_EMULATOR_URL}/oauth/v2/authorize`,
    params: { scope: 'chat:write,channels:read,users:read,users.profile:read' },
  },
  token: {
    url: `${process.env.SLACK_EMULATOR_URL}/api/oauth.v2.access`,
  },
  clientId: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
}
```

## Seed Config

```yaml
slack:
  team:
    name: My Workspace
    domain: my-workspace
  users:
    - name: developer
      real_name: Developer
      email: dev@example.com
      is_admin: true
      profile:
        title: Local Developer
        status_text: Testing locally
        status_emoji: ":computer:"
      presence: active
    - name: designer
      real_name: Designer
      email: designer@example.com
      profile:
        title: Designer
      presence: away
  channels:
    - name: general
      topic: General discussion
    - name: engineering
      topic: Engineering discussions
      is_private: true
  bots:
    - name: my-bot
  oauth_apps:
    - client_id: "12345.67890"
      client_secret: example_client_secret
      app_id: A000000001
      name: My Slack App
      redirect_uris:
        - http://localhost:3000/api/auth/callback/slack
      scopes:
        - chat:write
        - channels:read
        - channels:history
        - channels:join
        - channels:manage
        - channels:write
        - groups:read
        - groups:history
        - groups:write
        - im:read
        - im:history
        - im:write
        - mpim:read
        - mpim:history
        - mpim:write
        - users:read
        - users:read.email
        - users.profile:read
        - users.profile:write
        - users:write
        - files:read
        - files:write
        - pins:read
        - pins:write
        - bookmarks:read
        - bookmarks:write
        - reactions:read
        - reactions:write
        - team:read
      user_scopes:
        - users:read
        - users.profile:read
      bot_name: my-bot
  tokens:
    - token: xoxb-local-test
      user: developer
      scopes:
        - chat:write
        - channels:read
        - channels:history
        - channels:join
        - channels:manage
        - channels:write
        - groups:read
        - groups:history
        - groups:write
        - im:read
        - im:history
        - im:write
        - mpim:read
        - mpim:history
        - mpim:write
        - users:read
        - users:read.email
        - users.profile:read
        - users.profile:write
        - users:write
        - files:read
        - files:write
        - pins:read
        - pins:write
        - bookmarks:read
        - bookmarks:write
        - reactions:read
        - reactions:write
        - team:read
  incoming_webhooks:
    - channel: general
      label: CI Notifications
  strict_scopes: false
  signing_secret: my_signing_secret
```

When no OAuth apps are configured, the emulator accepts any `client_id`. With apps configured, strict validation is enforced for `client_id`, `client_secret`, and `redirect_uri`.

## API Endpoints

### Auth

```bash
# Test authentication
curl -X POST http://localhost:4003/api/auth.test \
  -H "Authorization: Bearer $TOKEN"
```

### Chat

`chat.postMessage`, `chat.update`, `conversations.history`, and `conversations.replies` round trip text plus common rich message fields: `blocks`, `attachments`, `metadata`, `mrkdwn`, `parse`, `link_names`, `unfurl_links`, `unfurl_media`, `username`, `icon_url`, `icon_emoji`, `bot_id`, `app_id`, `client_msg_id`, and `reply_broadcast`. `chat.postMessage` can also post to opened DM conversations or supported Slack user IDs.

`chat.postEphemeral` stores ephemeral messages outside channel history. `chat.scheduleMessage`, `chat.deleteScheduledMessage`, and `chat.scheduledMessages.list` keep scheduled messages pending until deleted or inspected.

```bash
# Post message
curl -X POST http://localhost:4003/api/chat.postMessage \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C000000001", "text": "Hello from the emulator!"}'

# Post threaded reply
curl -X POST http://localhost:4003/api/chat.postMessage \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C000000001", "text": "Thread reply", "thread_ts": "1234567890.123456"}'

# Post rich message
curl -X POST http://localhost:4003/api/chat.postMessage \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C000000001", "text": "Deploy complete", "blocks": [{"type": "section", "text": {"type": "mrkdwn", "text": "*Deploy* complete"}}], "metadata": {"event_type": "deploy_complete", "event_payload": {"deploy_id": "dep_123"}}, "unfurl_links": false}'

# Update message
curl -X POST http://localhost:4003/api/chat.update \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C000000001", "ts": "1234567890.123456", "text": "Updated message"}'

# Delete message
curl -X POST http://localhost:4003/api/chat.delete \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C000000001", "ts": "1234567890.123456"}'

# Get message permalink
curl -X GET 'http://localhost:4003/api/chat.getPermalink?channel=C000000001&message_ts=1234567890.123456' \
  -H "Authorization: Bearer $TOKEN"

# Post ephemeral message
curl -X POST http://localhost:4003/api/chat.postEphemeral \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C000000001", "user": "U000000001", "text": "Only you can see this"}'

# Schedule message
curl -X POST http://localhost:4003/api/chat.scheduleMessage \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"channel\": \"C000000001\", \"text\": \"Reminder\", \"post_at\": $(($(date +%s) + 3600))}"

# List scheduled messages
curl -X POST http://localhost:4003/api/chat.scheduledMessages.list \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C000000001"}'

# Delete scheduled message
curl -X POST http://localhost:4003/api/chat.deleteScheduledMessage \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C000000001", "scheduled_message_id": "Q123456789"}'

# /me message
curl -X POST http://localhost:4003/api/chat.meMessage \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C000000001", "text": "is thinking..."}'
```

### Conversations

```bash
# List channels (cursor pagination)
curl -X POST http://localhost:4003/api/conversations.list \
  -H "Authorization: Bearer $TOKEN"

# List DMs and MPIMs
curl -X POST http://localhost:4003/api/conversations.list \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"types": "im,mpim"}'

# Get channel info
curl -X POST http://localhost:4003/api/conversations.info \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C000000001"}'

# Create channel
curl -X POST http://localhost:4003/api/conversations.create \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "new-channel", "is_private": false}'

# Archive and unarchive a non-general channel
curl -X POST http://localhost:4003/api/conversations.archive \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C000000002"}'

curl -X POST http://localhost:4003/api/conversations.unarchive \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C000000002"}'

# Rename channel
curl -X POST http://localhost:4003/api/conversations.rename \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C000000001", "name": "new-channel-name"}'

# Set topic / purpose
curl -X POST http://localhost:4003/api/conversations.setTopic \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C000000001", "topic": "Release coordination"}'

curl -X POST http://localhost:4003/api/conversations.setPurpose \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C000000001", "purpose": "Coordinate release work"}'

# Channel history (top-level messages only)
curl -X POST http://localhost:4003/api/conversations.history \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C000000001"}'

# Thread replies
curl -X POST http://localhost:4003/api/conversations.replies \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C000000001", "ts": "1234567890.123456"}'

# Join / leave channel
curl -X POST http://localhost:4003/api/conversations.join \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C000000001"}'

# Discover IDs before membership or DM examples
curl -X POST http://localhost:4003/api/users.list \
  -H "Authorization: Bearer $TOKEN"

curl -X POST http://localhost:4003/api/conversations.list \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"types": "public_channel,private_channel"}'

CHANNEL_ID="<channel-id-from-conversations.list>"
USER_ID="<user-id-from-users.list>"

# Invite / kick user
curl -X POST http://localhost:4003/api/conversations.invite \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"channel\": \"$CHANNEL_ID\", \"users\": \"$USER_ID\"}"

curl -X POST http://localhost:4003/api/conversations.kick \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"channel\": \"$CHANNEL_ID\", \"user\": \"$USER_ID\"}"

# Open DM, then set DM_CHANNEL_ID to the returned channel.id
curl -X POST http://localhost:4003/api/conversations.open \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"users\": \"$USER_ID\", \"return_im\": true}"

DM_CHANNEL_ID="<channel.id-from-conversations.open>"

curl -X POST http://localhost:4003/api/conversations.close \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"channel\": \"$DM_CHANNEL_ID\"}"

# Mark conversation read
curl -X POST http://localhost:4003/api/conversations.mark \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C000000001", "ts": "1234567890.123456"}'

# List members
curl -X POST http://localhost:4003/api/conversations.members \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C000000001"}'
```

### Users

```bash
# List users (cursor pagination)
curl -X POST http://localhost:4003/api/users.list \
  -H "Authorization: Bearer $TOKEN"

# Get user info
curl -X POST http://localhost:4003/api/users.info \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user": "U000000001"}'

# Lookup by email
curl -X POST http://localhost:4003/api/users.lookupByEmail \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email": "dev@example.com"}'

# Get a user profile
curl -X GET 'http://localhost:4003/api/users.profile.get?user=U000000001' \
  -H "Authorization: Bearer $TOKEN"

# Update profile fields and status
curl -X POST http://localhost:4003/api/users.profile.set \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user": "U000000001", "profile": {"display_name": "Developer", "status_text": "Testing locally", "status_emoji": ":computer:"}}'

# Get presence
curl -X GET 'http://localhost:4003/api/users.getPresence?user=U000000001' \
  -H "Authorization: Bearer $TOKEN"

# Set the authed user away
curl -X POST http://localhost:4003/api/users.setPresence \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"presence": "away"}'

# Return the authed user to automatic presence
curl -X POST http://localhost:4003/api/users.setPresence \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"presence": "auto"}'
```

### Files

```bash
# Request a local upload URL
curl -X POST http://localhost:4003/api/files.getUploadURLExternal \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"filename": "deploy.txt", "length": 18}'

# Upload bytes to the returned upload_url
curl -X POST http://localhost:4003/upload/v1/F000000001 \
  -H "Content-Type: application/octet-stream" \
  --data-binary @deploy.txt

# Complete and share the file in a channel
curl -X POST http://localhost:4003/api/files.completeUploadExternal \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"files": [{"id": "F000000001", "title": "Deploy Log"}], "channel_id": "C000000001", "initial_comment": "Deploy log attached"}'

# Get file info
curl -X GET 'http://localhost:4003/api/files.info?file=F000000001' \
  -H "Authorization: Bearer $TOKEN"

# List files
curl -X POST http://localhost:4003/api/files.list \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C000000001"}'

# Download file bytes from url_private
curl -X GET http://localhost:4003/files-pri/F000000001/deploy.txt \
  -H "Authorization: Bearer $TOKEN"

# Delete a file
curl -X POST http://localhost:4003/api/files.delete \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"file": "F000000001"}'
```

### Pins And Bookmarks

```bash
# Pin a message
curl -X POST http://localhost:4003/api/pins.add \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C000000001", "timestamp": "1234567890.123456"}'

# List pinned messages
curl -X GET 'http://localhost:4003/api/pins.list?channel=C000000001' \
  -H "Authorization: Bearer $TOKEN"

# Remove a message pin
curl -X POST http://localhost:4003/api/pins.remove \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C000000001", "timestamp": "1234567890.123456"}'

# Add a link bookmark
curl -X POST http://localhost:4003/api/bookmarks.add \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel_id": "C000000001", "title": "Runbook", "type": "link", "link": "https://example.com/runbook"}'

# Edit a bookmark
curl -X POST http://localhost:4003/api/bookmarks.edit \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel_id": "C000000001", "bookmark_id": "Bk000000001", "title": "Updated Runbook"}'

# List bookmarks
curl -X POST http://localhost:4003/api/bookmarks.list \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel_id": "C000000001"}'

# Remove a bookmark
curl -X POST http://localhost:4003/api/bookmarks.remove \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel_id": "C000000001", "bookmark_id": "Bk000000001"}'
```

### Views

```bash
# Publish an App Home view
curl -X POST http://localhost:4003/api/views.publish \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "U000000001", "view": {"type": "home", "blocks": [{"type": "section", "text": {"type": "plain_text", "text": "Local App Home"}}]}}'

# Generate a local trigger id for modal tests
curl -X POST http://localhost:4003/api/views.generateTriggerId \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "U000000001"}'

# Open a modal view with the returned trigger_id or interactivity_pointer within 3 seconds
curl -X POST http://localhost:4003/api/views.open \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"trigger_id": "<trigger_id from views.generateTriggerId>", "view": {"type": "modal", "title": {"type": "plain_text", "text": "Local Modal"}, "blocks": [{"type": "section", "text": {"type": "plain_text", "text": "Modal body"}}]}}'

# Update a view
curl -X POST http://localhost:4003/api/views.update \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"view_id": "V000000001", "view": {"type": "modal", "title": {"type": "plain_text", "text": "Updated Modal"}, "blocks": [{"type": "section", "text": {"type": "plain_text", "text": "Updated body"}}]}}'

# Generate a push trigger tied to an existing modal view
curl -X POST http://localhost:4003/api/views.generateTriggerId \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"view_id": "V000000001"}'

# Push a modal view onto the current stack with the returned trigger_id or interactivity_pointer
curl -X POST http://localhost:4003/api/views.push \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"trigger_id": "<trigger_id from views.generateTriggerId>", "view": {"type": "modal", "title": {"type": "plain_text", "text": "Next Modal"}, "blocks": []}}'
```

### Reactions

```bash
# Add reaction
curl -X POST http://localhost:4003/api/reactions.add \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C000000001", "timestamp": "1234567890.123456", "name": "thumbsup"}'

# Remove reaction
curl -X POST http://localhost:4003/api/reactions.remove \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C000000001", "timestamp": "1234567890.123456", "name": "thumbsup"}'

# Get reactions
curl -X POST http://localhost:4003/api/reactions.get \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C000000001", "timestamp": "1234567890.123456"}'
```

### Team

```bash
# Get workspace info
curl -X POST http://localhost:4003/api/team.info \
  -H "Authorization: Bearer $TOKEN"
```

### Bots

```bash
# Get bot info
curl -X POST http://localhost:4003/api/bots.info \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"bot": "B000000001"}'
```

### Incoming Webhooks

```bash
# Post via incoming webhook
curl -X POST http://localhost:4003/services/T000000001/B000000001/X000000001 \
  -H "Content-Type: application/json" \
  -d '{"text": "Deployment complete!"}'

# Post to a specific channel
curl -X POST http://localhost:4003/services/T000000001/B000000001/X000000001 \
  -H "Content-Type: application/json" \
  -d '{"text": "Alert!", "channel": "C000000002"}'

# Post threaded webhook message
curl -X POST http://localhost:4003/services/T000000001/B000000001/X000000001 \
  -H "Content-Type: application/json" \
  -d '{"text": "Thread update", "thread_ts": "1234567890.123456"}'
```

### OAuth

```bash
# Authorize (browser flow, shows user picker)
# GET /oauth/v2/authorize?client_id=...&redirect_uri=...&scope=...&state=...
# The picker submits POST /oauth/v2/authorize/callback to create the auth code.

# Token exchange
curl -X POST http://localhost:4003/api/oauth.v2.access \
  -H "Content-Type: application/json" \
  -d '{"client_id": "12345.67890", "client_secret": "example_client_secret", "code": "<code>"}'
```

Returns a Slack-style response:

```json
{
  "ok": true,
  "access_token": "xoxb-...",
  "token_type": "bot",
  "scope": "chat:write,channels:read",
  "app_id": "A000000001",
  "bot_user_id": "U000000099",
  "team": { "id": "T000000001", "name": "Emulate" },
  "authed_user": { "id": "U000000001" }
}
```

### Inspector

Open `GET /` in the Slack emulator to inspect conversations, messages, files, views, auth records, incoming webhooks, event subscriptions, and event deliveries.

## Event Dispatching

When supported Slack writes mutate state, the emulator dispatches `event_callback` payloads to configured webhook URLs. These payloads match Slack's Events API format:

- `message` events on `chat.postMessage`
- `message` with `subtype: message_changed` on `chat.update`
- `message` with `subtype: message_deleted` on `chat.delete`
- rich message fields are included on posted `message` events when present
- `reaction_added` / `reaction_removed` events on `reactions.add` / `reactions.remove`
- `pin_added` / `pin_removed` events on `pins.add` / `pins.remove`
- `message` with `subtype: bot_message` on incoming webhook posts
- `channel_archive` / `channel_unarchive` for public lifecycle archive writes
- `group_archive` / `group_unarchive` for private lifecycle archive writes
- `channel_rename` / `group_rename` and matching name message subtypes on `conversations.rename`
- `message` with public `channel_topic` / `channel_purpose` or private `group_topic` / `group_purpose` subtypes on topic and purpose writes
- `member_joined_channel` / `member_left_channel` on invite, join, leave, and kick writes
- `im_created`, `im_open`, `im_close`, `im_marked`, and group open/close/marked events for DM and MPIM writes
- `user_change` on profile writes
- `presence_change` on presence writes
- `file_created`, `file_shared`, and `file_deleted` on file writes
- `message` with `subtype: file_share` on shared file uploads

## Current Limits

Slack Connect, Enterprise Grid admin APIs, Audit Logs API, SCIM, Legal Holds, Socket Mode, slash command and interaction simulation, user groups, reminders, stars, calls, canvases, lists, functions, workflows, chat streaming, legacy `files.upload`, exact rate limiting, and paid-plan behavior are not implemented.

## Common Patterns

### Post Messages and React

```bash
TOKEN="test_token_admin"
BASE="http://localhost:4003"

# Post a message
curl -X POST $BASE/api/chat.postMessage \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C000000001", "text": "Hello!"}'

# React to it (use the ts from the response)
curl -X POST $BASE/api/reactions.add \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C000000001", "timestamp": "<ts>", "name": "wave"}'
```

### OAuth Flow

1. Redirect user to `$SLACK_EMULATOR_URL/oauth/v2/authorize?client_id=...&redirect_uri=...&scope=chat:write,channels:read&state=...`
2. User picks a seeded user on the emulator's UI
3. Emulator redirects back with `?code=...&state=...`
4. Exchange code for token via `POST /api/oauth.v2.access`
5. Use `xoxb-` token to call Web API endpoints

When `user_scope` is included in the authorize URL and callback, the exchange response includes `authed_user.access_token`, `authed_user.scope`, and `authed_user.token_type`.

### CI Notifications via Webhook

```bash
# Use the default incoming webhook
curl -X POST http://localhost:4003/services/T000000001/B000000001/X000000001 \
  -H "Content-Type: application/json" \
  -d '{"text": "Build passed on main"}'
```
