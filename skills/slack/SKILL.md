---
name: slack
description: Emulated Slack API for local development and testing. Use when the user needs to interact with Slack API endpoints locally, test Slack integrations, emulate channels/messages/users/views, set up Slack OAuth flows, test incoming webhooks, or work with the Slack Web API without hitting the real Slack API. Triggers include "Slack API", "emulate Slack", "mock Slack", "test Slack OAuth", "Slack bot", "Slack views", "incoming webhook", "local Slack", or any task requiring a local Slack API.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# Slack API Emulator

Fully stateful Slack Web API emulation with channels, messages, threads, reactions, user profiles, presence, modern file uploads, pins, bookmarks, views, OAuth v2, and incoming webhooks. Chat writes preserve common rich message fields such as `blocks`, `attachments`, `metadata`, formatting flags, unfurl flags, and client message ids. Conversation writes update archive state, names, topics, purposes, membership, DMs, MPIMs, and read cursors. User writes update profile fields, status, custom fields, and deterministic active or away presence. File writes support the current external upload flow with local upload URLs, file share messages, reads, lists, downloads, and deletes. Pin and bookmark writes support channel message pins and link bookmarks. View writes support App Home publishing and modal stacks. Seeded OAuth apps and OAuth installs create bot users and installation records. OAuth exchanges and explicit token seeds create scoped token records. State changes dispatch `event_callback` payloads to configured webhook URLs.

Slack message text is limited to 40,000 Unicode characters across chat writes, incoming webhooks, and file upload initial comments. Longer text is truncated at a Unicode code point boundary before it is stored or dispatched. Successful Web API responses include `warning: "message_truncated"` and `response_metadata` with the matching warning and explanatory message. Rich fields such as `blocks` and `attachments` are preserved unchanged.

## Start

Local listeners bind to `127.0.0.1` by default. For access from containers or other machines, pass `--host 0.0.0.0` to the CLI or `hostname: '0.0.0.0'` to `createEmulator`. Configure `--base-url` or `baseUrl` for advertised URLs reachable by those clients.

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

Scope checks are relaxed by default for local development. Set `slack.strict_scopes: true` in seed config when you need supported Web API methods to return Slack-style `missing_scope` errors with `needed` and `provided` fields. Strict mode checks `chat:write`, `channels:read`, `channels:history`, `channels:join`, `channels:manage`, `channels:write`, `groups:read`, `groups:history`, `groups:write`, `im:read`, `im:history`, `im:write`, `mpim:read`, `mpim:history`, `mpim:write`, `users:read`, `users:read.email`, `users.profile:read`, `users.profile:write`, `users:write`, `files:read`, `files:write`, `pins:read`, `pins:write`, `bookmarks:read`, `bookmarks:write`, `reactions:read`, `reactions:write`, `team:read`, and `admin.conversations:write`. Slack lists no method-specific scopes for `views.publish`, `views.open`, `views.update`, or `views.push`, so the emulator requires auth but does not add strict-scope checks for those methods.

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

`signing_secret` signs every outbound event subscription callback. Configure the receiving app with the same secret; signed callbacks include `X-Slack-Request-Timestamp` and `X-Slack-Signature`, with `X-Slack-Signature` set to `v0=<HMAC-SHA256(secret, "v0:<timestamp>:<raw-body>")>`. Verify against the unparsed request body. When the secret is absent or empty, callbacks are unsigned.

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

# Open a modal view with the returned trigger_id or interactivity_pointer before it expires
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

### Interactivity

Buttons and modal submissions can invoke your app's Interactivity Request URL. Configure `interactivity_url` on a seeded `slack.oauth_apps` entry and set `slack.signing_secret` to the same secret used by your receiver:

```yaml
slack:
  signing_secret: local-signing-secret
  oauth_apps:
    - app_id: A_MY_APP
      client_id: my-client
      client_secret: my-secret
      name: My App
      redirect_uris: []
      interactivity_url: http://localhost:3000/slack/interactions
```

- `POST /_slack/simulate/block-actions` accepts `channel`, `message_ts`, and a button selector (`action_id`, exact `text`, or `url`), plus the acting `user` ID or name. It supports buttons in actions blocks and section accessories, including ephemeral messages visible to that user. The simulator requires an authenticated emulator token and the acting user must belong to the conversation.
- `POST /_slack/simulate/view-submission` accepts `view_id`, optional `user`, and `values` keyed by input block ID. Text inputs take strings; static selects and radio buttons take an option value; multi-selects and checkboxes take arrays of option values. Omitted values retain previous input or initial values. Other input elements return `unsupported_element`.

Callbacks are `application/x-www-form-urlencoded` with one `payload` JSON field, signed over the exact encoded request body. Button payloads include an app-bound, single-use `trigger_id` that can open a modal for the acting user. Triggers expire after three seconds by default; set `slack.view_trigger_ttl_seconds` to a positive number to allow more time in local tests. App ownership is preserved for messages posted with an app's bot or user token. Simulators return the payload and `delivery_id`; attempts and delivery results are saved in `slack.interaction_deliveries`.

A button payload's `response_url` accepts JSON without a bearer token, up to five times within 30 minutes. It posts an ephemeral reply by default, or a public reply with `response_type: "in_channel"`. Use `replace_original: true` or `delete_original: true` to modify the source message. Replacement retains the source message's visibility. Rich blocks and thread replies are supported.

A modal receiver must acknowledge within three seconds. An empty HTTP 200 closes the submitted view, while `response_action: "clear"` closes its stack. `errors` retains the view and returns block errors; `update` replaces its contents; `push` adds a new view subject to the three-view limit. Delivery failures and invalid acknowledgements leave the modal open. Shortcuts, slash commands, non-button actions, `view_closed`, and `block_suggestion` are not simulated.

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

`POST /api/apps.uninstall` accepts `client_id`, `client_secret`, and an installation's user token in the Authorization header or POST `token` field. It removes that app's installation in the token's workspace and revokes all associated OAuth bot and user tokens, including earlier grants. Revoked credentials return `token_revoked` on Web API calls even with permissive authentication. Other apps and workspaces keep their credentials. Granular bot tokens cannot uninstall an app and return `no_permission`; configured development tokens without an app binding may uninstall a local installation. No method scope is required.

Uninstall dispatches `app_uninstalled` and `tokens_revoked` to matching event subscriptions with the removed app's `api_app_id`. `tokens_revoked.tokens.oauth` and `.bot` contain deduplicated user IDs, never token strings. Credentials are invalid before callbacks are delivered. Handlers should accept either event order. The app definition remains available for a new OAuth installation; reinstalling issues fresh tokens without reactivating revoked ones.

### Inspector

Open `GET /` in the Slack emulator to inspect conversations, messages, files, views, auth records, incoming webhooks, event subscriptions, and event deliveries.

## Event Dispatching

For supported Slack writes that emit events, the emulator dispatches `event_callback` payloads to configured webhook URLs. These payloads match Slack's Events API format:

Each callback includes outer `token`, `api_app_id`, `authorizations`, `team_id`, `event_id`, and integer Unix-seconds `event_time` alongside the inner `event`. For authenticated Web API writes, `team_id` comes from the presented Slack token's installation. Development tokens without a stored Slack record fall back to the affected channel, user, or file's team, then the seeded workspace team (or `T000000001`). Incoming webhook posts use their webhook record's team, or the target channel's team when no record matches. Each logical event gets a distinct `event_id` shared by deliveries to multiple subscribers.

Callbacks identify each workspace installation with its recipient `api_app_id` and bot authorization. With multiple installed apps, each receives a separate envelope; configured webhook subscriptions are shared and can route by `api_app_id`. Without an installation, callbacks use `A000000001` and a local user authorization. The legacy `token` field defaults to `emulate-verification-token`; set `slack.verification_token` to match receivers that check it. Use `slack.signing_secret` for request signature verification.

Every inner event includes `event_ts`. Message events include `channel_type` (`channel`, `group`, `im`, or `mpim`). Posts made with an issued or seeded bot token include the bot's `bot_id`, `app_id`, and `bot_profile` when the corresponding bot record exists. These fields persist in history, replies, and updates so handlers can identify their own messages. Removing an installed bot with `conversations.kick` or `conversations.leave` also emits `channel_left` or `group_left`, with `actor_id` and `event_ts`, for the affected app.

To test bot handlers, invite an installed app's `bot_user_id` with `conversations.invite`, subscribe to `app_mention`, then post text containing `<@BOT_USER_ID>` with `chat.postMessage`. Channel mentions produce one callback per mentioned app, with outer `api_app_id`, inner `event_ts`, and the original message and thread identity. DMs and MPIMs use `message` events.

- `message` events on `chat.postMessage`
- `app_mention` on `chat.postMessage` when channel message text mentions an installed member bot
- `app_uninstalled` / `tokens_revoked` on successful `apps.uninstall`
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
- `channel_left` / `group_left` when an installed bot leaves or is removed
- `im_created`, `im_open`, `im_close`, `im_marked`, and group open/close/marked events for DM and MPIM writes
- `user_change` on profile writes
- `presence_change` on presence writes
- `file_created`, `file_shared`, and `file_deleted` on file writes
- `message` with `subtype: file_share` on shared file uploads

When `slack.signing_secret` is configured, every existing outbound event subscription callback includes `X-Slack-Request-Timestamp` and `X-Slack-Signature`. The signature is `v0=<HMAC-SHA256(secret, "v0:<timestamp>:<raw-body>")>`, using the exact serialized callback body. Configure the receiver with the same secret and verify the unparsed request body. With an absent or empty secret, callbacks are unsigned.

### Channel privacy conversions

`POST /api/admin.conversations.convertToPrivate` and `POST /api/admin.conversations.convertToPublic` accept `channel_id`. Use a user token belonging to a seeded admin; bot and test tokens return `not_allowed_token_type`, and non-admin users return `missing_scope`. With `slack.strict_scopes: true`, the token also needs `admin.conversations:write`. For example:

```yaml
slack:
  tokens:
    - token: local-admin-user
      type: user
      user: admin
      scopes: [admin.conversations:write, channels:read, groups:read]
```

Conversions preserve the channel ID, members, and history, update visibility in conversation and file reads, and append a `message` with subtype `channel_convert_to_private` or `channel_convert_to_public`. Event callbacks include the acting user and the new `channel_type` (`group` or `channel`). Admins need not belong to the channel. DMs, MPIMs, and repeated conversions are rejected; `#general` cannot become private.

These methods operate on the emulated workspace without Slack's Enterprise plan or organization-wide installation requirements. Enterprise roles, channel-management policies, and MPIM conversion are not simulated.

### Slack Connect fixtures

Seed a user with a different `team_id` to test messages from another workspace. `users.info` and `users.list` return that user's workspace and `is_stranger` flag. Omitted user teams default to the emulated workspace. `is_stranger` defaults to `false` and can be seeded to model a user outside the app's visible shared channels.

```yaml
slack:
  users:
    - name: partner
      team_id: T_PARTNER
      is_stranger: false
  tokens:
    - token: xoxp-partner
      type: user
      user: partner
      scopes: [chat:write]
```

Use the seeded user token to act as the external user. Invite the user and your app's bot to a channel with `conversations.invite`, then post a message mentioning the bot. The app-mention event includes the author's `user_team` and `source_team`; the outer `team_id` identifies the receiving installation workspace selected by the token, which defaults to the emulated workspace. Ordinary message callbacks retain the author user ID, which can be resolved with `users.info`.

A channel with external members returns `is_ext_shared: true` and `is_shared: true`; its event callbacks include `is_ext_shared_channel: true`. Seed `channels[].is_ext_shared: true` to model an already shared channel. Sharing remains set after the last external member leaves or is removed, including across saved state. Slack Connect invitation and approval flows, workspace disconnection, and per-workspace channel settings are not simulated.

### Event retries

Use `POST /_slack/simulate/event-retry` with an authenticated emulator token and JSON `{ "event_id": "Ev...", "reason": "http_timeout" }` to test event deduplication. Get the event ID from a received callback or the inspector's Events tab. The simulator resends the latest recorded delivery for that event to its original subscription, preserving the entire payload and event ID. If several subscribers received it, only the latest recipient is retried.

Each attempt gets an increasing `X-Slack-Retry-Num`, starting at `1`, and `X-Slack-Retry-Reason` (default `http_timeout`). Reasons also accept `http_error`, `connection_failed`, `ssl_error`, `too_many_redirects`, and `unknown_error`. When `slack.signing_secret` is configured, the retry gets a fresh request timestamp and signature. The response includes `delivery_id`, `retry_num`, `success`, and `status_code`; a failed callback is recorded and still consumes a retry number.

Retries are explicit, with no automatic scheduling or three-attempt limit. Only the latest 1,000 event deliveries are retained in memory, so retries are unavailable after their history is evicted or the emulator restarts. Unknown events return `event_not_found`, and an inactive subscription returns `subscription_inactive`.

## Current Limits

Slack Connect invitation and approval flows, per-workspace channel settings, other Enterprise Grid admin APIs, Audit Logs API, SCIM, Legal Holds, Socket Mode, slash commands, shortcuts, and interaction types other than button actions and modal submissions, user groups, reminders, stars, calls, canvases, lists, functions, workflows, chat streaming, legacy `files.upload`, exact rate limiting, and paid-plan behavior are not implemented.

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

## Custom emulators alongside built-ins

Use `npx emulate init --custom inventory` to scaffold a third-party API emulator and test. Register it in `emulate.config.ts` with `defineConfig` from `emulate`, alongside built-in entries such as `{ emulator: "slack" }`. Run `npx emulate start --watch` to reload imports and inspect custom state at the printed `/_emulate` URL. Successful reloads reset the run to seed. Existing flat seed configs still work; `--config` selects an explicit file. For authoring and testing third-party API emulators, see https://emulate.dev/docs/custom-emulators.
