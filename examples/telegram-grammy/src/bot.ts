import { Bot } from "grammy";
import { registerHandlers } from "./handlers.js";

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("BOT_TOKEN is required. Set BOT_TOKEN=<your-token> (or run `pnpm start:emu` for the default emulator token).");
  process.exit(1);
}

const apiRoot = process.env.TELEGRAM_API_ROOT ?? "https://api.telegram.org";

const bot = new Bot(token, { client: { apiRoot } });
registerHandlers(bot);

bot.catch((err) => {
  console.error("handler error:", err);
});

async function main() {
  const me = await bot.api.getMe();
  console.log(`Starting bot @${me.username} (id=${me.id}) against ${apiRoot}`);
  await bot.start({
    drop_pending_updates: false,
    onStart: () => console.log("Polling for updates..."),
  });
}

void main();
