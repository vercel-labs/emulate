import type { Context } from "hono";
import type { RouteContext, Store } from "@emulators/core";
import { escapeHtml, renderSettingsPage } from "@emulators/core";
import { getTelegramStore } from "../store.js";
import type {
  MessageEntity,
  TelegramBot,
  TelegramChat,
  TelegramMessage,
  TelegramUpdate,
} from "../entities.js";
import { isInlineKeyboardMarkup } from "../types/wire/reply-markup.js";

const SERVICE_LABEL = "Telegram";

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function renderEntities(text: string, entities?: MessageEntity[]): string {
  if (!entities || entities.length === 0) return escapeHtml(text);
  const sorted = [...entities].sort((a, b) => a.offset - b.offset);
  let html = "";
  let pos = 0;
  for (const e of sorted) {
    if (e.offset > pos) html += escapeHtml(text.slice(pos, e.offset));
    const slice = text.slice(e.offset, e.offset + e.length);
    const cls = `ent-${e.type}`;
    html += `<span class="${cls}" style="color:#ffcc00">${escapeHtml(slice)}</span>`;
    pos = e.offset + e.length;
  }
  if (pos < text.length) html += escapeHtml(text.slice(pos));
  return html;
}

function renderPhoto(msg: TelegramMessage, botToken: string): string {
  if (!msg.photo || msg.photo.length === 0) return "";
  const last = msg.photo[msg.photo.length - 1];
  const href = `/file/bot${botToken}/photos/${encodeURIComponent(String(msg.chat_id))}/${encodeURIComponent(last.file_id)}`;
  return `<div style="margin-top:4px"><span class="badge badge-granted">photo ${last.width}x${last.height}</span> <span class="user-meta">${escapeHtml(last.file_id)}</span></div>`;
}

function renderReplyMarkup(msg: TelegramMessage): string {
  const rm = msg.reply_markup;
  if (!rm) return "";
  if (!isInlineKeyboardMarkup(rm)) return "";
  const buttons = rm.inline_keyboard
    .flat()
    .map(
      (b) =>
        `<span class="badge badge-requested">${escapeHtml(b.text)}${b.callback_data ? ` → ${escapeHtml(b.callback_data)}` : ""}</span>`,
    )
    .join(" ");
  return `<div style="margin-top:4px">${buttons}</div>`;
}

function renderDocument(msg: TelegramMessage): string {
  if (!msg.document) return "";
  const d = msg.document;
  return `<div style="margin-top:4px"><span class="badge badge-granted">document</span> <span class="user-meta">${escapeHtml(d.file_name ?? d.file_id)}${d.mime_type ? ` · ${escapeHtml(d.mime_type)}` : ""}${d.file_size ? ` · ${d.file_size}B` : ""}</span></div>`;
}

function renderMessage(msg: TelegramMessage, lookups: Lookups): string {
  const from =
    msg.from_bot_id !== null
      ? lookups.bots.get(msg.from_bot_id) ?? `bot:${msg.from_bot_id}`
      : msg.from_user_id !== null
        ? lookups.users.get(msg.from_user_id) ?? `user:${msg.from_user_id}`
        : "?";

  const isBot = msg.from_bot_id !== null;
  const botBadge = isBot ? ` <span class="badge badge-granted">bot</span>` : "";
  const editedBadge = msg.edited_date ? ` <span class="badge badge-denied">edited</span>` : "";
  const deletedBadge = msg.deleted ? ` <span class="badge badge-denied">deleted</span>` : "";
  const letter = (from[0] ?? "?").toUpperCase();

  const bot = isBot ? lookups.botsByIdForToken.get(msg.from_bot_id ?? 0) : undefined;
  const token = bot?.token ?? lookups.anyToken;

  return `<div class="org-row">
  <span class="org-icon">${escapeHtml(letter)}</span>
  <span class="org-name">${escapeHtml(from)}${botBadge}</span>
  <span class="user-meta" style="margin-left:auto">${timeAgo(msg.created_at)}${editedBadge}${deletedBadge}</span>
</div>
<div class="info-text" style="${msg.deleted ? "text-decoration:line-through;opacity:0.5" : ""}">${renderEntities(msg.text ?? "", msg.entities)}${msg.caption ? ` <em>${escapeHtml(msg.caption)}</em>` : ""}</div>
${renderPhoto(msg, token)}
${renderDocument(msg)}
${renderReplyMarkup(msg)}`;
}

interface Lookups {
  users: Map<number, string>;
  bots: Map<number, string>;
  botsByIdForToken: Map<number, TelegramBot>;
  anyToken: string;
}

function buildLookups(store: Store): Lookups {
  const ts = getTelegramStore(store);
  const users = new Map<number, string>();
  for (const u of ts.users.all()) {
    users.set(u.user_id, u.username ? `@${u.username}` : u.first_name);
  }
  const bots = new Map<number, string>();
  const botsByIdForToken = new Map<number, TelegramBot>();
  for (const b of ts.bots.all()) {
    bots.set(b.bot_id, `@${b.username}`);
    botsByIdForToken.set(b.bot_id, b);
  }
  const anyToken = ts.bots.all()[0]?.token ?? "";
  return { users, bots, botsByIdForToken, anyToken };
}

function renderChatLink(ch: TelegramChat, activeId: number, view: string): string {
  const active = ch.chat_id === activeId && view === "chats" ? ' class="active"' : "";
  const icon = ch.type === "private" ? "💬" : ch.type === "group" ? "#" : "ch";
  const label =
    ch.type === "private"
      ? ch.first_name || ch.username || `user:${ch.chat_id}`
      : ch.title ?? `chat:${ch.chat_id}`;
  return `<a href="/?view=chats&chat=${ch.chat_id}"${active}>${escapeHtml(icon)} ${escapeHtml(label)}</a>`;
}

function renderBotLink(bot: TelegramBot, activeId: number, view: string): string {
  const active = bot.bot_id === activeId && view === "bots" ? ' class="active"' : "";
  return `<a href="/?view=bots&bot=${bot.bot_id}"${active}>🤖 @${escapeHtml(bot.username)}</a>`;
}

function renderSidebar(store: Store, view: string, activeId: number): string {
  const ts = getTelegramStore(store);
  const tabs = `<div class="section-heading"><a href="/?view=chats" style="color:${view === "chats" ? "#33ff00" : "#1a8c00"}">Chats</a> / <a href="/?view=bots" style="color:${view === "bots" ? "#33ff00" : "#1a8c00"}">Bots</a></div>`;

  if (view === "bots") {
    const bots = ts.bots.all();
    if (bots.length === 0) return `${tabs}<p class="empty">No bots</p>`;
    return tabs + bots.map((b) => renderBotLink(b, activeId, view)).join("\n");
  }

  const chats = ts.chats.all();
  if (chats.length === 0) return `${tabs}<p class="empty">No chats</p>`;
  return tabs + chats.map((ch) => renderChatLink(ch, activeId, view)).join("\n");
}

function renderChatView(store: Store, chatId: number): string {
  const ts = getTelegramStore(store);
  const chat = ts.chats.findOneBy("chat_id", chatId);
  if (!chat) return `<p class="empty">Chat ${chatId} not found</p>`;

  const messages = ts.messages
    .findBy("chat_id", chatId)
    .sort((a, b) => a.message_id - b.message_id)
    .slice(-50);

  const draftSnapshots = ts.draftSnapshots
    .findBy("chat_id", chatId)
    .sort((a, b) => (a.draft_id !== b.draft_id ? a.draft_id - b.draft_id : a.seq - b.seq));

  const lookups = buildLookups(store);

  const header = `<div class="s-card-header">
    <div class="s-icon">${chat.type === "private" ? "💬" : "#"}</div>
    <div>
      <div class="s-title">${escapeHtml(chat.title ?? chat.first_name ?? String(chat.chat_id))}</div>
      <div class="s-subtitle">${chat.type} · chat_id ${chat.chat_id} · ${chat.member_user_ids.length} users, ${chat.member_bot_ids.length} bots</div>
    </div>
  </div>`;

  const body =
    messages.length === 0
      ? '<p class="empty">No messages yet.</p>'
      : messages.map((m) => renderMessage(m, lookups)).join("\n<div style='height:8px'></div>\n");

  const draftsByKey = new Map<string, typeof draftSnapshots>();
  for (const s of draftSnapshots) {
    const key = `${s.draft_id}:${s.bot_id}`;
    const list = draftsByKey.get(key) ?? [];
    list.push(s);
    draftsByKey.set(key, list);
  }

  const draftsHtml =
    draftSnapshots.length === 0
      ? ""
      : `<div class="section-heading">Streaming drafts <span class="user-meta">${draftSnapshots.length} snapshots across ${draftsByKey.size} drafts</span></div>
${[...draftsByKey.entries()]
  .map(([key, list]) => {
    const [draftId, botId] = key.split(":");
    const botLabel = lookups.bots.get(Number(botId)) ?? `bot:${botId}`;
    const rows = list
      .map(
        (s) =>
          `<tr><td>${s.seq}</td><td>${timeAgo(s.created_at)}</td><td style="max-width:480px;word-break:break-word">${escapeHtml(s.text.slice(0, 160))}${s.text.length > 160 ? "..." : ""}</td></tr>`,
      )
      .join("");
    return `<div class="s-card" style="padding:8px 0">
  <div class="s-subtitle">draft_id ${escapeHtml(draftId)} · ${escapeHtml(botLabel)}</div>
  <table class="inspector-table">
    <thead><tr><th>seq</th><th>at</th><th>text</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;
  })
  .join("\n")}`;

  return `<div class="s-card">${header}<div class="section-heading">Messages</div>${body}${draftsHtml}</div>`;
}

function renderBotView(store: Store, botId: number): string {
  const ts = getTelegramStore(store);
  const bot = ts.bots.findOneBy("bot_id", botId);
  if (!bot) return `<p class="empty">Bot ${botId} not found</p>`;

  const updates = ts.updates
    .findBy("for_bot_id", bot.bot_id)
    .sort((a, b) => b.update_id - a.update_id)
    .slice(0, 30);

  const pending = updates.filter((u) => !u.delivered).length;

  const header = `<div class="s-card-header">
    <div class="s-icon">🤖</div>
    <div>
      <div class="s-title">@${escapeHtml(bot.username)}</div>
      <div class="s-subtitle">bot_id ${bot.bot_id} · token <code style="color:#ffcc00">${escapeHtml(bot.token)}</code></div>
    </div>
  </div>`;

  const webhookRow = bot.webhook_url
    ? `<tr><td>Webhook</td><td><code style="color:#ffcc00">${escapeHtml(bot.webhook_url)}</code>${bot.webhook_secret ? ' <span class="badge badge-granted">with secret</span>' : ""}</td></tr>`
    : `<tr><td>Webhook</td><td><span class="user-meta">not set · uses long polling</span></td></tr>`;

  const config = `<div class="section-heading">Configuration</div>
<table class="inspector-table">
  <tr><td>First name</td><td>${escapeHtml(bot.first_name)}</td></tr>
  <tr><td>Can join groups</td><td>${bot.can_join_groups}</td></tr>
  <tr><td>Read all group messages</td><td>${bot.can_read_all_group_messages}</td></tr>
  ${webhookRow}
  <tr><td>Commands</td><td>${bot.commands.length === 0 ? '<span class="user-meta">none</span>' : bot.commands.map((c) => `<code style="color:#ffcc00">/${escapeHtml(c.command)}</code> — ${escapeHtml(c.description)}`).join("<br>")}</td></tr>
</table>`;

  const queue = `<div class="section-heading">Update Queue <span class="user-meta">${pending} pending / ${updates.length} shown</span></div>
${renderUpdateTable(updates)}`;

  return `<div class="s-card">${header}${config}${queue}</div>`;
}

function renderUpdateTable(updates: TelegramUpdate[]): string {
  if (updates.length === 0) return '<p class="inspector-empty">No updates yet.</p>';
  const rows = updates
    .map((u) => {
      const status = u.delivered
        ? `<span class="badge badge-granted">delivered</span>`
        : `<span class="badge badge-requested">pending</span>`;
      const mode = `<span class="badge">${u.delivery_mode}</span>`;
      return `<tr>
      <td>${u.update_id}</td>
      <td>${u.type}</td>
      <td>${mode}</td>
      <td>${status}</td>
      <td>${u.delivery_attempts}</td>
      <td><span class="user-meta">${u.delivery_error ? escapeHtml(u.delivery_error) : ""}</span></td>
    </tr>`;
    })
    .join("");
  return `<table class="inspector-table">
    <thead><tr><th>ID</th><th>Type</th><th>Mode</th><th>Status</th><th>Attempts</th><th>Error</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

export function inspectorRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;

  app.get("/", (c: Context) => {
    const view = c.req.query("view") === "bots" ? "bots" : "chats";
    const activeId = Number(c.req.query(view === "bots" ? "bot" : "chat") ?? 0);

    const sidebar = renderSidebar(store, view, activeId);

    let body: string;
    if (view === "bots") {
      const ts = getTelegramStore(store);
      const defaultId = activeId || ts.bots.all()[0]?.bot_id || 0;
      body = defaultId
        ? renderBotView(store, defaultId)
        : '<p class="empty">No bots yet. Create one via POST /_emu/telegram/bots.</p>';
    } else {
      const ts = getTelegramStore(store);
      const defaultId = activeId || ts.chats.all()[0]?.chat_id || 0;
      body = defaultId
        ? renderChatView(store, defaultId)
        : '<p class="empty">No chats yet. Simulate activity via POST /_emu/telegram/chats/private.</p>';
    }

    return c.html(renderSettingsPage("Telegram Inspector", sidebar, body, SERVICE_LABEL));
  });
}
