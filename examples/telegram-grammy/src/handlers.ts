import { Bot, InlineKeyboard, InputFile } from "grammy";

/**
 * Registers all demo handlers on a grammY Bot instance.
 * Handlers are defined once and run unchanged against:
 *   - the Telegram emulator (TELEGRAM_API_ROOT=http://localhost:4011)
 *   - real Telegram (apiRoot unset)
 */
export function registerHandlers(bot: Bot): void {
  bot.command("start", async (ctx) => {
    await ctx.reply(
      `Hi ${ctx.from?.first_name ?? "there"}! I'm the emulate demo bot.\n` +
        `Try /echo <text>, /menu, or send me a photo.`,
    );
  });

  bot.command("echo", async (ctx) => {
    const arg = ctx.match?.toString().trim() ?? "";
    if (!arg) {
      await ctx.reply("Usage: /echo <text>");
      return;
    }
    await ctx.reply(arg);
  });

  // Streaming demo — simulates an LLM reply arriving in chunks.
  // Uses sendMessageDraft, an emulator-only extension that models
  // animated streaming (each call appends a snapshot under
  // (chat_id, draft_id, bot_id)), then commits the final text as a
  // real message.
  bot.command("stream", async (ctx) => {
    if (ctx.chat?.type !== "private") {
      await ctx.reply("/stream only works in private chats (Bot API limit).");
      return;
    }
    const draftId = Math.floor(Date.now() / 1000);
    const chunks = ["Thinking", "Thinking.", "Thinking..", "Thinking...", "Here is your plan: Tangier → Chefchaouen → Fez."];
    for (const text of chunks) {
      await ctx.api.raw.sendMessageDraft({
        chat_id: ctx.chat.id,
        draft_id: draftId,
        text,
      });
      await sleep(700);
    }
    await ctx.reply(chunks[chunks.length - 1]);
  });

  // editMessageText demo — bot revises its own reply in place.
  bot.command("revise", async (ctx) => {
    const first = await ctx.reply("Draft reply v1: working on it...");
    await sleep(1500);
    await ctx.api.editMessageText(first.chat.id, first.message_id, "Final reply: done!");
  });

  // deleteMessage demo — bot sends, then deletes its own message.
  bot.command("oops", async (ctx) => {
    const sent = await ctx.reply("This message will self-destruct.");
    await sleep(1500);
    await ctx.api.deleteMessage(sent.chat.id, sent.message_id);
    await ctx.reply("Deleted the previous message.");
  });

  bot.command("menu", async (ctx) => {
    const kb = new InlineKeyboard()
      .text("Option A", "opt:a")
      .text("Option B", "opt:b")
      .row()
      .text("Cancel", "opt:cancel");
    await ctx.reply("Pick an option:", { reply_markup: kb });
  });

  bot.callbackQuery(/^opt:/, async (ctx) => {
    const choice = ctx.callbackQuery.data.slice("opt:".length);
    const label =
      choice === "a" ? "You picked A." : choice === "b" ? "You picked B." : "Cancelled.";
    await ctx.answerCallbackQuery({ text: label });
    if (ctx.callbackQuery.message) {
      await ctx.api.editMessageReplyMarkup(
        ctx.callbackQuery.message.chat.id,
        ctx.callbackQuery.message.message_id,
        { reply_markup: { inline_keyboard: [] } },
      );
      await ctx.reply(label);
    }
  });

  bot.on("message:photo", async (ctx) => {
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    const caption = ctx.message.caption;
    await ctx.reply(
      `Got a photo (${largest.width}x${largest.height}, file_id=${largest.file_id.slice(0, 16)}...)${caption ? ` with caption: ${caption}` : ""}.`,
    );
    // Echo the photo back by file_id — exercises the file_id round-trip
    await ctx.replyWithPhoto(largest.file_id, { caption: "echo" });
  });

  bot.on("message:text", async (ctx) => {
    // Fallback for plain text that isn't a command
    if (ctx.message.text.startsWith("/")) return;
    await ctx.reply(`You said: ${ctx.message.text}`);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { InlineKeyboard, InputFile };
