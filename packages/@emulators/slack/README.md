# @emulators/slack

Fully stateful Slack Web API emulation with channels, messages, threads, reactions, user profiles, presence, modern file uploads, pins, bookmarks, views, OAuth v2, and incoming webhooks. Chat writes preserve common rich message fields such as `blocks`, `attachments`, `metadata`, formatting flags, unfurl flags, and client message ids. Conversation writes update archive state, names, topics, purposes, membership, DMs, MPIMs, and read cursors. User writes update profile fields, status, custom fields, and deterministic active or away presence. File writes support the current external upload flow with local upload URLs, file share messages, reads, lists, downloads, and deletes. Pin and bookmark writes support channel message pins and link bookmarks. View writes support App Home publishing and modal stacks. OAuth installs create bot users and installation records. OAuth exchanges and explicit token seeds create scoped token records. Supported write state changes dispatch Slack `event_callback` payloads to configured webhook URLs.

Part of [emulate](https://github.com/vercel-labs/emulate) — local drop-in replacement services for CI and no-network sandboxes.

## Install

```bash
npm install @emulators/slack
```

## Endpoints

### Auth & Chat
- `POST /api/auth.test` — test authentication
- `POST /api/chat.postMessage` — post message with text or rich payload fields (supports threads via `thread_ts` and DM user IDs)
- `POST /api/chat.postEphemeral` — post ephemeral message outside channel history
- `POST /api/chat.update` — update message text and rich payload fields
- `POST /api/chat.delete` — delete message
- `GET /api/chat.getPermalink` / `POST /api/chat.getPermalink` — get message permalink
- `POST /api/chat.scheduleMessage` — schedule pending message
- `POST /api/chat.deleteScheduledMessage` — delete pending scheduled message
- `POST /api/chat.scheduledMessages.list` — list pending scheduled messages
- `POST /api/chat.meMessage` — /me message

### Conversations
- `POST /api/conversations.list` — list conversations (cursor pagination, `types`, `exclude_archived`)
- `POST /api/conversations.info` — get channel info
- `POST /api/conversations.create` — create channel
- `POST /api/conversations.archive` / `conversations.unarchive` — archive/restore channel
- `POST /api/conversations.rename` — rename channel
- `POST /api/conversations.setTopic` / `conversations.setPurpose` — update topic/purpose
- `POST /api/conversations.history` — channel history with rich message fields
- `POST /api/conversations.replies` — thread replies with rich message fields
- `POST /api/conversations.join` / `conversations.leave` — join/leave
- `POST /api/conversations.invite` / `conversations.kick` — manage membership
- `POST /api/conversations.open` / `conversations.close` — open/close DMs and MPIMs
- `POST /api/conversations.mark` — mark read cursor
- `POST /api/conversations.members` — list members

### Users & Reactions
- `POST /api/users.list` — list users (cursor pagination)
- `POST /api/users.info` — get user info
- `POST /api/users.lookupByEmail` — lookup by email
- `GET /api/users.profile.get` / `POST /api/users.profile.get` — get user profile fields
- `POST /api/users.profile.set` — update profile fields, status, and custom fields
- `GET /api/users.getPresence` / `POST /api/users.getPresence` — get active or away presence
- `POST /api/users.setPresence` — set the authed user to away or automatic presence
- `POST /api/reactions.add` / `reactions.remove` / `reactions.get` — manage reactions

### Files
- `POST /api/files.getUploadURLExternal` — create a local external upload session
- `POST /upload/v1/:fileId` — receive raw uploaded file bytes
- `POST /api/files.completeUploadExternal` — complete uploads and optionally share file messages
- `GET /api/files.info` / `POST /api/files.info` — get file metadata
- `GET /api/files.list` / `POST /api/files.list` — list completed files
- `GET /files-pri/:fileId/:filename` — download file bytes with a bearer token that can access the file
- `POST /api/files.delete` — delete a completed file

### Pins & Bookmarks
- `POST /api/pins.add` — pin a message to a channel
- `GET /api/pins.list` / `POST /api/pins.list` — list pinned message items for a channel
- `POST /api/pins.remove` — remove a message pin from a channel
- `POST /api/bookmarks.add` — add a link bookmark to a channel
- `POST /api/bookmarks.edit` — update a link bookmark
- `POST /api/bookmarks.list` — list channel bookmarks
- `POST /api/bookmarks.remove` — remove a bookmark from a channel

### Views
- `POST /api/views.publish` — publish or update an App Home view for a user
- `POST /api/views.open` — open a modal view
- `POST /api/views.update` — update a view by `view_id` or `external_id`
- `POST /api/views.push` — push a modal view onto the current modal stack
- `POST /api/views.generateTriggerId` — local helper for tests that need a modal trigger id

Modal opens and pushes require values from `/api/views.generateTriggerId`. Pass the returned value as `trigger_id` or `interactivity_pointer`; generate push values with an existing `view_id` and use them within 3 seconds.

### Team, Bots & Webhooks
- `POST /api/team.info` — workspace info
- `POST /api/bots.info` — bot info
- `POST /services/:teamId/:botId/:webhookId` — incoming webhook with text or rich payload fields

### OAuth
- `GET /oauth/v2/authorize` — authorization (shows user picker)
- `POST /oauth/v2/authorize/callback` — local user picker callback that creates the auth code
- `POST /api/oauth.v2.access` — token exchange

### Inspector
- `GET /` — tabbed local inspector for conversations, messages, files, views, auth records, incoming webhooks, event subscriptions, and event deliveries

## Auth

All Web API endpoints require `Authorization: Bearer <token>`. Seeded OAuth apps create local installation state, and the OAuth v2 flow with user picker UI returns Slack-style bot tokens. Scope checks are relaxed by default for local development. Set `strict_scopes: true` in Slack seed config to return Slack-style `missing_scope` errors when a token lacks the required method scope. Strict mode checks `chat:write`, `channels:read`, `channels:history`, `channels:join`, `channels:manage`, `channels:write`, `groups:read`, `groups:history`, `groups:write`, `im:read`, `im:history`, `im:write`, `mpim:read`, `mpim:history`, `mpim:write`, `users:read`, `users:read.email`, `users.profile:read`, `users.profile:write`, `users:write`, `files:read`, `files:write`, `pins:read`, `pins:write`, `bookmarks:read`, `bookmarks:write`, `reactions:read`, `reactions:write`, and `team:read`. Slack lists no method-specific scopes for `views.publish`, `views.open`, `views.update`, or `views.push`, so the emulator requires auth but does not add strict-scope checks for those methods.

## Current Limits

Slack Connect, Enterprise Grid admin APIs, Audit Logs API, SCIM, Legal Holds, Socket Mode, slash command and interaction simulation, user groups, reminders, stars, calls, canvases, lists, functions, workflows, chat streaming, legacy `files.upload`, exact rate limiting, and paid-plan behavior are not implemented.

## Seed Configuration

```yaml
slack:
  team:
    name: My Workspace
    domain: my-workspace
  users:
    - name: developer
      real_name: Developer
      email: dev@example.com
      profile:
        title: Local Developer
        status_text: Testing locally
        status_emoji: ":computer:"
      presence: active
  channels:
    - name: general
      topic: General discussion
    - name: random
      topic: Random stuff
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
  strict_scopes: false
```

## Links

- [Full documentation](https://emulate.dev/slack)
- [GitHub](https://github.com/vercel-labs/emulate)
