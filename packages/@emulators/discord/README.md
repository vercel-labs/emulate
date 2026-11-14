# @emulators/discord

Local Discord REST and OAuth emulator for `emulate`.

Phase 1 scope:

- Guilds, channels, messages, members, and roles through Discord-style REST routes under `/api/v10`
- OAuth 2.0 authorization code flow through `/oauth2/authorize` and `/api/oauth2/token`
- Discord snowflake ID generation
- `Bot <token>` and `Bearer <token>` authorization
- Inspector UI at `/`

Follow-up PRs will cover slash commands and interactions, webhooks, and Gateway WebSocket support. They are intentionally out of scope for this package slice.

## Usage

```bash
npx emulate start --service discord
```

The Discord emulator uses port `4012` when started from the default multi-service config order.

## Seed Config

```yaml
discord:
  applications:
    - id: "123456789012345678"
      client_id: "discord-client-id"
      client_secret: "discord-client-secret"
      name: "My Discord App"
      bot_token: "discord-bot-token"
      redirect_uris:
        - "http://localhost:3000/api/auth/callback/discord"
  users:
    - id: "222222222222222222"
      username: "developer"
      email: "dev@example.com"
  guilds:
    - id: "333333333333333333"
      name: "My Server"
      members:
        - user_id: "222222222222222222"
          roles: ["admin"]
      roles:
        - id: "444444444444444444"
          name: "admin"
          permissions: "8"
      channels:
        - id: "555555555555555555"
          name: "general"
          type: "GUILD_TEXT"
```

## Routes

- `GET /api/v10/users/@me`
- `GET /api/v10/guilds`
- `POST /api/v10/guilds`
- `GET /api/v10/guilds/{guild_id}`
- `PATCH /api/v10/guilds/{guild_id}`
- `DELETE /api/v10/guilds/{guild_id}`
- `GET /api/v10/guilds/{guild_id}/channels`
- `POST /api/v10/guilds/{guild_id}/channels`
- `GET /api/v10/channels/{channel_id}`
- `PATCH /api/v10/channels/{channel_id}`
- `DELETE /api/v10/channels/{channel_id}`
- `GET /api/v10/channels/{channel_id}/messages`
- `POST /api/v10/channels/{channel_id}/messages`
- `GET /api/v10/channels/{channel_id}/messages/{message_id}`
- `PATCH /api/v10/channels/{channel_id}/messages/{message_id}`
- `DELETE /api/v10/channels/{channel_id}/messages/{message_id}`
- `GET /api/v10/guilds/{guild_id}/members`
- `GET /api/v10/guilds/{guild_id}/members/{user_id}`
- `PUT /api/v10/guilds/{guild_id}/members/{user_id}`
- `PATCH /api/v10/guilds/{guild_id}/members/{user_id}`
- `DELETE /api/v10/guilds/{guild_id}/members/{user_id}`
- `GET /api/v10/guilds/{guild_id}/roles`
- `POST /api/v10/guilds/{guild_id}/roles`
- `PATCH /api/v10/guilds/{guild_id}/roles/{role_id}`
- `DELETE /api/v10/guilds/{guild_id}/roles/{role_id}`
- `GET /oauth2/authorize`
- `POST /api/oauth2/token`
