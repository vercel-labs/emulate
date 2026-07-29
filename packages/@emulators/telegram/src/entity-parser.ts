import type { MessageEntity, TelegramBot } from "./entities.js";

/** Auto-detect bot_command / mention / url / email / hashtag / cashtag
 *  entities in a raw text. Matches Telegram's behaviour for unparsed
 *  messages (no parse_mode). */
export function parseEntities(text: string, bot?: TelegramBot | null): MessageEntity[] {
  const entities: MessageEntity[] = [];
  if (!text) return entities;
  void bot;

  const overlapsExisting = (start: number, end: number) =>
    entities.some((e) => start < e.offset + e.length && end > e.offset);

  // Bot commands: /command or /command@botname at the start or after whitespace
  const cmdRe = /(?:^|\s)(\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?)/g;
  for (const m of text.matchAll(cmdRe)) {
    const full = m[1];
    const start = (m.index ?? 0) + m[0].length - full.length;
    entities.push({ type: "bot_command", offset: start, length: full.length });
  }

  // Mentions: @username anywhere.
  const mentionRe = /(?:^|[^A-Za-z0-9_\/])(@[A-Za-z0-9_]+)/g;
  for (const m of text.matchAll(mentionRe)) {
    const full = m[1];
    const start = (m.index ?? 0) + m[0].length - full.length;
    if (!overlapsExisting(start, start + full.length)) {
      entities.push({ type: "mention", offset: start, length: full.length });
    }
  }

  // URLs: http:// or https://... (strip trailing .,!?)]})
  const urlRe = /\bhttps?:\/\/[^\s<]+/g;
  for (const m of text.matchAll(urlRe)) {
    let full = m[0];
    full = full.replace(/[.,!?)\]}]+$/, "");
    const start = m.index ?? 0;
    if (!overlapsExisting(start, start + full.length)) {
      entities.push({ type: "url", offset: start, length: full.length });
    }
  }

  // Emails
  const emailRe = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
  for (const m of text.matchAll(emailRe)) {
    const full = m[0];
    const start = m.index ?? 0;
    if (!overlapsExisting(start, start + full.length)) {
      entities.push({ type: "email", offset: start, length: full.length });
    }
  }

  // Hashtags: #tag after whitespace or start
  const hashRe = /(?:^|\s)(#[A-Za-z0-9_]+)/g;
  for (const m of text.matchAll(hashRe)) {
    const full = m[1];
    const start = (m.index ?? 0) + m[0].length - full.length;
    if (!overlapsExisting(start, start + full.length)) {
      entities.push({ type: "hashtag", offset: start, length: full.length });
    }
  }

  // Cashtags: $AAPL style
  const cashRe = /(?:^|\s)(\$[A-Z]{1,8})\b/g;
  for (const m of text.matchAll(cashRe)) {
    const full = m[1];
    const start = (m.index ?? 0) + m[0].length - full.length;
    if (!overlapsExisting(start, start + full.length)) {
      entities.push({ type: "cashtag", offset: start, length: full.length });
    }
  }

  entities.sort((a, b) => a.offset - b.offset);
  return entities;
}
