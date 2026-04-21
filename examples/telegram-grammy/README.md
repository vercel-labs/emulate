# telegram-grammy-demo

A small [grammY](https://grammy.dev) bot that runs unchanged against the Telegram emulator **and** against real Telegram. Serves as the parity proof for `@emulators/telegram`.

## Handlers

| Command / event            | Exercises                                                                |
| -------------------------- | ------------------------------------------------------------------------ |
| `/start`                   | Text send, command routing                                               |
| `/echo <text>`             | Command with arguments                                                   |
| `/menu`                    | `sendMessage` with `reply_markup.inline_keyboard`                        |
| click on inline button     | `callback_query` update, `answerCallbackQuery`, `editMessageReplyMarkup` |
| photo message              | Photo receive, `file_id` round-trip via `replyWithPhoto(file_id)`        |
| plain text (not a command) | Fallback text echo                                                       |

The handler code in `src/handlers.ts` is backend-agnostic. Only `src/bot.ts` reads `TELEGRAM_API_ROOT` and wires it into grammY's `client.apiRoot`.

## Run against the emulator

```bash
# Terminal 1
npx emulate --service telegram --port 4011

# Terminal 2
pnpm --filter telegram-grammy-demo start:emu
```

The bot connects to the default seeded bot (`@emulate_bot`) and long-polls. Drive user activity:

```bash
curl -X POST http://localhost:4011/_emu/telegram/chats/1001/messages \
  -H 'content-type: application/json' \
  -d '{"userId":1001,"text":"/start"}'

curl -s 'http://localhost:4011/_emu/telegram/chats/1001/messages?scope=bot'
```

Or open `http://localhost:4011/` in a browser — the inspector shows chats, messages, and the Update queue live.

## Run against real Telegram

```bash
BOT_TOKEN=<your-botfather-token> pnpm --filter telegram-grammy-demo start
```

`TELEGRAM_API_ROOT` defaults to `https://api.telegram.org` when unset. Open your bot in a Telegram client, send `/start`, `/echo hi`, `/menu`, a photo — they should behave identically to the emulator run. This is the one-shot parity check.

## Run the parity test

```bash
pnpm --filter telegram-grammy-demo test
```

The test boots the emulator in-process on an OS-picked port, starts the bot against it, simulates user activity through the test control plane, and asserts the bot's replies against the store. Covers all six handler paths. Runs in ~10 seconds.

Treat the emulator and real Telegram as interchangeable backends: if this test passes and the real-Telegram smoke run looks the same, the emulator is good enough for bot development.
