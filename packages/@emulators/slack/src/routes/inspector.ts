import type { RouteContext } from "@emulators/core";
import { escapeHtml, renderSettingsPage } from "@emulators/core";
import { getSlackStore } from "../store.js";
import type { SlackMessage, SlackChannel } from "../entities.js";

const SERVICE_LABEL = "Slack";

function timeAgo(isoDate: string): string {
  const seconds = Math.floor((Date.now() - new Date(isoDate).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function renderReactions(reactions: Array<{ name: string; count: number }>): string {
  if (!reactions || reactions.length === 0) return "";
  const badges = reactions
    .map((r) => `<span class="badge badge-granted">:${escapeHtml(r.name)}: ${r.count}</span>`)
    .join(" ");
  return `<div style="margin-top:4px">${badges}</div>`;
}

function renderMessage(msg: SlackMessage, users: Map<string, string>): string {
  const displayName = users.get(msg.user) ?? msg.user;
  const isBot = msg.subtype === "bot_message";
  const letter = isBot ? "B" : (displayName[0] ?? "?").toUpperCase();
  const threadBadge = msg.reply_count > 0
    ? ` <span class="badge badge-requested">${msg.reply_count} ${msg.reply_count === 1 ? "reply" : "replies"}</span>`
    : "";
  const threadIndicator = msg.thread_ts && msg.thread_ts !== msg.ts
    ? `<span class="badge badge-denied">thread</span> `
    : "";

  return `<div class="org-row">
  <span class="org-icon">${escapeHtml(letter)}</span>
  <span class="org-name">${escapeHtml(displayName)}${isBot ? ' <span class="badge badge-granted">bot</span>' : ""}</span>
  <span class="user-meta" style="margin-left:auto">${timeAgo(msg.created_at)}</span>
</div>
<div class="info-text">${threadIndicator}${escapeHtml(msg.text)}${threadBadge}</div>
${renderReactions(msg.reactions)}`;
}

function renderChannelSidebar(channels: SlackChannel[], activeId: string): string {
  return channels
    .map((ch) => {
      const active = ch.channel_id === activeId ? ' class="active"' : "";
      const prefix = ch.is_private ? "🔒 " : "# ";
      return `<a href="/?channel=${escapeHtml(ch.channel_id)}"${active}>${prefix}${escapeHtml(ch.name)}</a>`;
    })
    .join("\n");
}

export function inspectorRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ss = () => getSlackStore(store);

  // Message Inspector - the visual dashboard
  app.get("/", (c) => {
    const channels = ss().channels.all().filter((ch) => !ch.is_archived);
    const team = ss().teams.all()[0];

    if (channels.length === 0) {
      return c.html(renderSettingsPage(
        "Slack Inspector",
        "<p class='empty'>No channels</p>",
        "<p class='empty'>No channels in the emulator store.</p>",
        SERVICE_LABEL
      ));
    }

    // Pick active channel from query param or default to first
    const requestedChannel = c.req.query("channel") ?? "";
    const activeChannel = channels.find((ch) => ch.channel_id === requestedChannel) ?? channels[0];

    // Build user lookup map
    const userMap = new Map<string, string>();
    for (const u of ss().users.all()) {
      userMap.set(u.user_id, u.name);
      userMap.set(u.name, u.name);
    }
    for (const b of ss().bots.all()) {
      userMap.set(b.bot_id, b.name);
    }

    // Get messages for the active channel, newest first
    const messages = ss().messages
      .findBy("channel_id", activeChannel.channel_id)
      .sort((a, b) => (b.ts > a.ts ? 1 : -1))
      .slice(0, 50);

    const sidebar = renderChannelSidebar(channels, activeChannel.channel_id);

    // Build the message list
    const messageHtml = messages.length === 0
      ? '<p class="empty">No messages yet. Post one with chat.postMessage or an incoming webhook.</p>'
      : messages.map((m) => renderMessage(m, userMap)).join("\n<div style='height:8px'></div>\n");

    const stats = `${ss().users.all().length} users, ${channels.length} channels, ${ss().messages.all().length} messages`;

    const bodyHtml = `
<div class="s-card">
  <div class="s-card-header">
    <div class="s-icon">#</div>
    <div>
      <div class="s-title">${escapeHtml(activeChannel.name)}</div>
      <div class="s-subtitle">${escapeHtml(activeChannel.topic.value || "No topic set")} - ${activeChannel.num_members} members</div>
    </div>
  </div>
  <div class="section-heading">
    Messages
    <span class="user-meta">${stats}</span>
  </div>
  ${messageHtml}
</div>`;

    return c.html(renderSettingsPage(
      `${team?.name ?? "Slack"} - Message Inspector`,
      sidebar,
      bodyHtml,
      SERVICE_LABEL
    ));
  });
}
