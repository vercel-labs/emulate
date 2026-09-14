---
name: discord
description: Emulated Discord API for local development and testing. Use when the user needs to interact with Discord REST API endpoints locally, test Discord OAuth flows, emulate guilds, channels, messages, members, roles, or work with Discord bot API calls without hitting the real Discord API.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# Discord API Emulator

Phase 1 covers Discord REST API resources, OAuth 2.0, snowflake IDs, bot token auth, and the inspector UI.

Slash commands, interactions, webhooks, and Gateway WebSocket support are planned follow-up PRs. Do not describe them as available in this phase.

## Start

```bash
npx emulate start --service discord
```

When all services run together, Discord is available at `http://localhost:4012`.

## Auth

Use bot tokens for REST calls:

```bash
curl http://localhost:4012/api/v10/users/@me \
  -H "Authorization: Bot discord-bot-token"
```

OAuth bearer tokens returned from `/api/oauth2/token` can be sent as `Authorization: Bearer <token>`.

## URL Mapping

| Real Discord URL | Emulator URL |
|------------------|--------------|
| `https://discord.com/api/v10` | `$DISCORD_EMULATOR_URL/api/v10` |
| `https://discord.com/oauth2/authorize` | `$DISCORD_EMULATOR_URL/oauth2/authorize` |
| `https://discord.com/api/oauth2/token` | `$DISCORD_EMULATOR_URL/api/oauth2/token` |

## REST Endpoints

- `GET /api/v10/users/@me`
- `GET /api/v10/guilds`
- `POST /api/v10/guilds`
- `GET /api/v10/guilds/:guildId`
- `PATCH /api/v10/guilds/:guildId`
- `DELETE /api/v10/guilds/:guildId`
- `GET /api/v10/guilds/:guildId/channels`
- `POST /api/v10/guilds/:guildId/channels`
- `GET /api/v10/channels/:channelId`
- `PATCH /api/v10/channels/:channelId`
- `DELETE /api/v10/channels/:channelId`
- `GET /api/v10/channels/:channelId/messages`
- `POST /api/v10/channels/:channelId/messages`
- `GET /api/v10/channels/:channelId/messages/:messageId`
- `PATCH /api/v10/channels/:channelId/messages/:messageId`
- `DELETE /api/v10/channels/:channelId/messages/:messageId`
- `GET /api/v10/guilds/:guildId/members`
- `GET /api/v10/guilds/:guildId/members/:userId`
- `PUT /api/v10/guilds/:guildId/members/:userId`
- `PATCH /api/v10/guilds/:guildId/members/:userId`
- `DELETE /api/v10/guilds/:guildId/members/:userId`
- `GET /api/v10/guilds/:guildId/roles`
- `POST /api/v10/guilds/:guildId/roles`
- `PATCH /api/v10/guilds/:guildId/roles/:roleId`
- `DELETE /api/v10/guilds/:guildId/roles/:roleId`

## OAuth

Configure applications in seed config with `client_id`, `client_secret`, `bot_token`, and `redirect_uris`.

```yaml
discord:
  applications:
    - id: "123456789012345678"
      client_id: discord-client-id
      client_secret: discord-client-secret
      name: My Discord App
      bot_token: discord-bot-token
      redirect_uris:
        - http://localhost:3000/api/auth/callback/discord
```

## Inspector

Open `/` on the Discord emulator origin to inspect guilds, channels, messages, members, and roles.
