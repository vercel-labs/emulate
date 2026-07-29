import { randomBytes, createHash } from "crypto";
import type { Store } from "@emulators/core";

interface TelegramCounters {
  botId: number;
  userId: number;
  fileSequence: number;
  updateSequence: Map<number, number>;
  groupChatId: number;
  supergroupChatId: number;
  channelChatId: number;
}

const COUNTERS_KEY = "telegram.counters";

function getCounters(store: Store): TelegramCounters {
  let counters = store.getData<TelegramCounters>(COUNTERS_KEY);
  if (!counters) {
    counters = {
      botId: 100000,
      userId: 1000,
      fileSequence: 1,
      updateSequence: new Map(),
      groupChatId: -1000000000,
      supergroupChatId: -1001000000000,
      channelChatId: -1002000000000,
    };
    store.setData(COUNTERS_KEY, counters);
  }
  return counters;
}

export function nextBotId(store: Store): number {
  const c = getCounters(store);
  c.botId += 1;
  return c.botId;
}

export function nextUserId(store: Store): number {
  const c = getCounters(store);
  c.userId += 1;
  return c.userId;
}

export function nextGroupChatId(store: Store): number {
  const c = getCounters(store);
  c.groupChatId -= 1;
  return c.groupChatId;
}

export function nextSupergroupChatId(store: Store): number {
  const c = getCounters(store);
  c.supergroupChatId -= 1;
  return c.supergroupChatId;
}

export function nextChannelChatId(store: Store): number {
  const c = getCounters(store);
  c.channelChatId -= 1;
  return c.channelChatId;
}

export function generateBotToken(botId: number): string {
  const secret = randomBytes(24).toString("base64url").slice(0, 35);
  return `${botId}:${secret}`;
}

export function parseBotIdFromToken(token: string): number | null {
  const m = token.match(/^(\d+):/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export function nextFileId(
  store: Store,
  botId: number,
  chatId: number,
  tier: string,
): { file_id: string; file_unique_id: string } {
  const c = getCounters(store);
  c.fileSequence += 1;
  const seq = c.fileSequence;
  const raw = `${botId}:${chatId}:${seq}:${tier}`;
  const file_id = `tg_emu_${Buffer.from(raw).toString("base64url")}`;
  const file_unique_id = `uq_${createHash("sha1").update(raw).digest("hex").slice(0, 16)}`;
  return { file_id, file_unique_id };
}

export function nextUpdateId(store: Store, botId: number): number {
  const c = getCounters(store);
  const current = c.updateSequence.get(botId) ?? 0;
  const next = current + 1;
  c.updateSequence.set(botId, next);
  return next;
}

export function generateCallbackQueryId(): string {
  return randomBytes(8).toString("hex");
}
