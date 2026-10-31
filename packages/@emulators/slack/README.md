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

Modal opens and pushes accept `trigger_id` or `interactivity_pointer` from an interaction payload or `/api/views.generateTriggerId`. Generate push values with an existing `view_id`. Triggers expire after 3 seconds by default; set `slack.view_trigger_ttl_seconds` to a positive number to allow more time in local tests.

### Team, Bots & Webhooks
- `POST /api/team.info` — workspace info
- `POST /api/bots.info` — bot info
- `POST /services/:teamId/:botId/:webhookId` — incoming webhook with text or rich payload fields

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

Callbacks are `application/x-www-form-urlencoded` with one `payload` JSON field, signed over the exact encoded request body. Button payloads include an app-bound, single-use `trigger_id` that can open a modal for the acting user. App ownership is preserved for messages posted with an app's bot or user token. Simulators return the payload and `delivery_id`; attempts and delivery results are saved in `slack.interaction_deliveries`.

A button payload's `response_url` accepts JSON without a bearer token, up to five times within 30 minutes. It posts an ephemeral reply by default, or a public reply with `response_type: "in_channel"`. Use `replace_original: true` or `delete_original: true` to modify the source message. Replacement retains the source message's visibility. Rich blocks and thread replies are supported.

A modal receiver must acknowledge within three seconds. An empty HTTP 200 closes the submitted view, while `response_action: "clear"` closes its stack. `errors` retains the view and returns block errors; `update` replaces its contents; `push` adds a new view subject to the three-view limit. Delivery failures and invalid acknowledgements leave the modal open. Shortcuts, slash commands, non-button actions, `view_closed`, and `block_suggestion` are not simulated.

### OAuth
- `GET /oauth/v2/authorize` — authorization (shows user picker)
- `POST /oauth/v2/authorize/callback` — local user picker callback that creates the auth code
- `POST /api/oauth.v2.access` — token exchange

### Inspector
- `GET /` — tabbed local inspector for conversations, messages, files, views, auth records, incoming webhooks, event subscriptions, and event deliveries

When a supported write emits an `event_callback`, the payload includes the inner `event` and outer `token`, `api_app_id`, `authorizations`, `team_id`, `event_id`, and integer Unix-seconds `event_time`. The team comes from the presented Slack token's installation; development tokens without a stored Slack record fall back to the affected channel, user, or file's team, then the seeded workspace team (or `T000000001`). Incoming webhook posts use their webhook record's team, or the target channel's team when no record matches. Each logical event has a distinct `event_id` shared by deliveries to multiple subscribers.

Each workspace installation receives an envelope attributed to its `api_app_id` and bot authorization. Event subscriptions are shared across apps; receivers can route by `api_app_id`. Without an installation, callbacks use `A000000001` and a local user authorization. The legacy `token` defaults to `emulate-verification-token`; override it with `slack.verification_token`. Use `slack.signing_secret` for signature verification.

Inner events include `event_ts`. Message events identify `channel`, `group`, `im`, or `mpim` in `channel_type`. Posts made with issued or seeded bot tokens and incoming webhook or interaction replies include `bot_id`, `app_id`, and `bot_profile` when the bot record exists, preserving bot identity in callbacks, updates, history, and replies. Removing an installed bot with `conversations.kick` or `conversations.leave` also emits `channel_left` or `group_left`, with `actor_id` and `event_ts`, for the affected app.

Slack message text is limited to 40,000 Unicode characters across chat writes, incoming webhooks, and file upload initial comments. Longer text is truncated at a Unicode code point boundary before it is stored or dispatched. Successful Web API responses include `warning: "message_truncated"` and `response_metadata` with the matching warning and explanatory message. Rich fields such as `blocks` and `attachments` are preserved unchanged.

## Auth

All Web API endpoints require `Authorization: Bearer <token>`. Seeded OAuth apps create local installation state, and the OAuth v2 flow with user picker UI returns Slack-style bot tokens. Scope checks are relaxed by default for local development. Set `strict_scopes: true` in Slack seed config to return Slack-style `missing_scope` errors when a token lacks the required method scope. Strict mode checks `chat:write`, `channels:read`, `channels:history`, `channels:join`, `channels:manage`, `channels:write`, `groups:read`, `groups:history`, `groups:write`, `im:read`, `im:history`, `im:write`, `mpim:read`, `mpim:history`, `mpim:write`, `users:read`, `users:read.email`, `users.profile:read`, `users.profile:write`, `users:write`, `files:read`, `files:write`, `pins:read`, `pins:write`, `bookmarks:read`, `bookmarks:write`, `reactions:read`, `reactions:write`, `team:read`, and `admin.conversations:write`. Slack lists no method-specific scopes for `views.publish`, `views.open`, `views.update`, or `views.push`, so the emulator requires auth but does not add strict-scope checks for those methods.

## Current Limits

Slack Connect invitation and approval flows, per-workspace channel settings, other Enterprise Grid admin APIs, Audit Logs API, SCIM, Legal Holds, Socket Mode, slash commands, shortcuts, and interaction types other than button actions and modal submissions, user groups, reminders, stars, calls, canvases, lists, functions, workflows, chat streaming, legacy `files.upload`, exact rate limiting, and paid-plan behavior are not implemented.

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
