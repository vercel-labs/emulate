---
name: telegram
description: Emulated Telegram Bot API for local development and testing. Use when the user needs to end-to-end test a Telegram bot without creating a real bot or clicking through Telegram clients. Supports text messages, bot commands, group chats with mentions, photo uploads with file_id round-trip, callback queries + inline keyboards, webhook delivery with retry, long polling. Triggers include "Telegram bot", "Telegram Bot API", "emulate Telegram", "mock Telegram", "test Telegram webhook", "grammY", "telegraf", "bot e2e tests", or any task requiring a local Telegram Bot API.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(curl:*)
---

# Telegram Bot API Emulator

Fully stateful Telegram Bot API emulation. Real grammY / telegraf / `@chat-adapter/telegram` SDKs connect unmodified. Simulates users sending messages and clicking buttons so bot code runs end-to-end without network.

## Start

```bash
# Telegram only — default port 4011
npx emulate --service telegram
```

Or programmatically:

```typescript
import { createEmulator } from "emulate";

const tg = await createEmulator({ service: "telegram", port: 4011 });
// tg.url === 'http://localhost:4011'
```

## Test client

```typescript
import { createTelegramTestClient } from "@emulators/telegram/test";

const tg = createTelegramTestClient("http://localhost:4011");

const bot = await tg.createBot({ username: "trip_test_bot", first_name: "Trip Test" });
const user = await tg.createUser({ first_name: "Alice" });
const dm = await tg.createPrivateChat({ botId: bot.bot_id, userId: user.id });

// User sends a text message — bot receives it via webhook or long polling.
await tg.sendUserMessage({ chatId: dm.id, userId: user.id, text: "/connect ABC" });

// User uploads a photo.
await tg.sendUserPhoto({ chatId: dm.id, userId: user.id, photoBytes: fs.readFileSync("test.jpg") });

// User taps an inline keyboard button on a message the bot sent.
await tg.clickInlineButton({ chatId: dm.id, userId: user.id, messageId: 42, callbackData: "confirm:yes" });

// Assert on what the bot sent.
const replies = await tg.getSentMessages({ chatId: dm.id });
```

## Pointing your bot at the emulator

### grammY

```typescript
import { Bot } from "grammy";
const bot = new Bot(process.env.BOT_TOKEN!, {
  client: { apiRoot: process.env.TELEGRAM_API_ROOT ?? "https://api.telegram.org" },
});
```

Set `TELEGRAM_API_ROOT=http://localhost:4011` in tests.

### telegraf

```typescript
import { Telegraf } from "telegraf";
const bot = new Telegraf(process.env.BOT_TOKEN!, {
  telegram: { apiRoot: process.env.TELEGRAM_API_ROOT ?? "https://api.telegram.org" },
});
```

### @chat-adapter/telegram

Use `mode: "polling"` and point at the emulator by injecting the base URL before the adapter is created. The adapter uses `https://api.telegram.org/bot<token>` under the hood — override via environment or DI.

## Webhook vs long polling

The emulator supports both, per bot:

```typescript
// Webhook: bot calls setWebhook({ url }) — the emulator POSTs Update JSON to `url` on user activity.
await fetch(`${tg.url}/bot${bot.token}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url: "http://localhost:3000/api/webhooks/telegram", secret_token: "sekret" }),
});

// Long polling: omit setWebhook; bot drains updates via getUpdates.
const res = await fetch(`${tg.url}/bot${bot.token}/getUpdates`);
```

Webhook delivery retries on 5xx up to 3 times (1s / 2s / 4s backoff). Terminal on 4xx. The `X-Telegram-Bot-Api-Secret-Token` header is sent when configured.

## Seed config

```yaml
telegram:
  bots:
    - username: trip_bot
      first_name: Trip Bot
      token: "100001:TRIP_BOT_TOKEN"
      commands:
        - command: connect
          description: Connect this chat to a trip
  users:
    - first_name: Alice
      username: alice_tester
  chats:
    - type: private
      between: [trip_bot, alice_tester]
    - type: group
      title: Morocco Planning
      members: [alice_tester]
      bots: [trip_bot]
```

## Inspector

Open `http://localhost:4011/` in a browser for a read-only view of bots, chats, messages, and the Update queue. Useful for debugging test failures.

## Privacy rules in groups

Matches real Telegram: bots in groups only see messages that mention them (`@bot_username`) or are addressed bot commands (`/command` or `/command@bot_username`). To see every message, set `can_read_all_group_messages: true` when creating the bot.

## Non-goals

Payments, games, Telegram Business API, Passport, TON wallets, BotFather account management. Out of scope forever.
