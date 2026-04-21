// Update-delivery Bot API methods: getMe, getUpdates, setWebhook,
// deleteWebhook, getWebhookInfo.
import type { Context } from "hono";
import type { Store } from "@emulators/core";
import { getTelegramStore } from "../store.js";
import { ok, okRaw, tgError } from "../http.js";
import { getDispatcher } from "../dispatcher.js";
import { parseWithSchema } from "../types/validators/body.js";
import { zGetUpdatesBody, zSetWebhookBody } from "../types/validators/delivery.js";
import type { TelegramBot } from "../entities.js";

export function getMe(c: Context, bot: TelegramBot) {
  return ok(c, {
    id: bot.bot_id,
    is_bot: true,
    first_name: bot.first_name,
    username: bot.username,
    can_join_groups: bot.can_join_groups,
    can_read_all_group_messages: bot.can_read_all_group_messages,
    supports_inline_queries: bot.supports_inline_queries,
  });
}

export async function getUpdates(
  c: Context,
  bot: TelegramBot,
  raw: unknown,
  dispatcher: ReturnType<typeof getDispatcher>,
) {
  const r = parseWithSchema(c, zGetUpdatesBody, raw);
  if (!r.ok) return r.response;
  const body = r.data;

  const limit = body.limit !== undefined ? Math.min(body.limit, 100) : 100;
  const timeout = body.timeout !== undefined ? Math.min(body.timeout, 50) : 0;
  const allowedUpdates = body.allowed_updates ?? bot.webhook_allowed_updates ?? null;

  if (bot.webhook_url) {
    return tgError(c, "Conflict: can't use getUpdates method while webhook is active", 409, 409);
  }

  const { cancelled, updates } = await dispatcher.getUpdates(bot.bot_id, body.offset, limit, timeout);
  if (cancelled) {
    return tgError(
      c,
      "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running",
      409,
      409,
    );
  }
  const filtered =
    allowedUpdates && allowedUpdates.length > 0
      ? updates.filter((u) => allowedUpdates.includes(u.type))
      : updates;
  return c.json({
    ok: true,
    result: filtered.map((u) => u.payload),
  });
}

export function setWebhook(
  c: Context,
  bot: TelegramBot,
  raw: unknown,
  store: Store,
) {
  const r = parseWithSchema(c, zSetWebhookBody, raw);
  if (!r.ok) return r.response;
  const body = r.data;

  const url = body.url ?? "";
  if (!url) {
    // Empty URL removes the webhook, matching real behaviour.
    return deleteWebhook(c, bot, store);
  }
  // Real Telegram only allows HTTPS webhooks (and rejects localhost, though
  // the emulator is lenient there for hermetic testing).
  if (!/^https:\/\//i.test(url)) {
    return tgError(c, "Bad Request: bad webhook: HTTPS url must be provided for webhook", 400, 400);
  }

  const ts = getTelegramStore(store);
  ts.bots.update(bot.id, {
    webhook_url: url,
    webhook_secret: body.secret_token ?? null,
    webhook_allowed_updates: body.allowed_updates ?? null,
  });
  return okRaw(c, true);
}

export function deleteWebhook(c: Context, bot: TelegramBot, store: Store) {
  const ts = getTelegramStore(store);
  ts.bots.update(bot.id, { webhook_url: null, webhook_secret: null, webhook_allowed_updates: null });
  return okRaw(c, true);
}

export function getWebhookInfo(c: Context, bot: TelegramBot) {
  return ok(c, {
    url: bot.webhook_url ?? "",
    has_custom_certificate: false,
    pending_update_count: 0,
    allowed_updates: bot.webhook_allowed_updates ?? undefined,
  });
}
