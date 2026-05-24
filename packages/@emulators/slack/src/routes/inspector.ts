import type { RouteContext } from "@emulators/core";
import { escapeHtml, renderSettingsPage } from "@emulators/core";
import { getSlackStore } from "../store.js";
import type {
  SlackBookmark,
  SlackChannel,
  SlackEphemeralMessage,
  SlackMessage,
  SlackPin,
  SlackScheduledMessage,
} from "../entities.js";

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

function collectTextValues(value: unknown, output: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectTextValues(item, output);
    return;
  }
  if (value === null || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  const text = record.text;
  if (typeof text === "string" && text.trim().length > 0) {
    output.push(text);
  } else {
    collectTextValues(text, output);
  }
  collectTextValues(record.fields, output);
  collectTextValues(record.elements, output);
  collectTextValues(record.accessory, output);
}

function richMessagePreview(msg: Pick<SlackMessage, "text" | "blocks" | "attachments" | "files">): string {
  if (msg.text.trim().length > 0) return msg.text;

  const blockText: string[] = [];
  collectTextValues(msg.blocks, blockText);
  if (blockText.length > 0) return blockText.join(" ");

  const attachmentText =
    msg.attachments
      ?.flatMap((attachment) => [attachment.text, attachment.title])
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0) ?? [];
  if (attachmentText.length > 0) return attachmentText.join(" ");

  const fileText = msg.files?.map((file) => file.title || file.name).filter((value) => value.trim().length > 0) ?? [];
  if (fileText.length > 0) return fileText.join(" ");

  if (msg.blocks?.length) return `${msg.blocks.length} ${msg.blocks.length === 1 ? "block" : "blocks"}`;
  if (msg.attachments?.length) {
    return `${msg.attachments.length} ${msg.attachments.length === 1 ? "attachment" : "attachments"}`;
  }
  if (msg.files?.length) return `${msg.files.length} ${msg.files.length === 1 ? "file" : "files"}`;
  return msg.text;
}

function renderMessage(msg: SlackMessage, users: Map<string, string>): string {
  const displayName = users.get(msg.user) ?? msg.user;
  const isBot = msg.subtype === "bot_message";
  const letter = isBot ? "B" : (displayName[0] ?? "?").toUpperCase();
  const messageText = richMessagePreview(msg);
  const richBadge =
    msg.text.length === 0 && ((msg.blocks?.length ?? 0) > 0 || (msg.attachments?.length ?? 0) > 0)
      ? ' <span class="badge badge-granted">rich</span>'
      : "";
  const threadBadge =
    msg.reply_count > 0
      ? ` <span class="badge badge-requested">${msg.reply_count} ${msg.reply_count === 1 ? "reply" : "replies"}</span>`
      : "";
  const fileBadge = msg.files?.length
    ? ` <span class="badge badge-granted">${msg.files.length} ${msg.files.length === 1 ? "file" : "files"}</span>`
    : "";
  const threadIndicator =
    msg.thread_ts && msg.thread_ts !== msg.ts ? `<span class="badge badge-denied">thread</span> ` : "";

  return `<div class="org-row">
  <span class="org-icon">${escapeHtml(letter)}</span>
  <span class="org-name">${escapeHtml(displayName)}${isBot ? ' <span class="badge badge-granted">bot</span>' : ""}</span>
  <span class="user-meta" style="margin-left:auto">${timeAgo(msg.created_at)}</span>
</div>
<div class="info-text">${threadIndicator}${escapeHtml(messageText)}${richBadge}${fileBadge}${threadBadge}</div>
${renderReactions(msg.reactions)}`;
}

function renderEphemeralMessage(msg: SlackEphemeralMessage, users: Map<string, string>): string {
  const displayName = users.get(msg.target_user) ?? msg.target_user;
  return `<div class="org-row">
  <span class="org-icon">E</span>
  <span class="org-name">${escapeHtml(displayName)} <span class="badge badge-requested">ephemeral</span></span>
  <span class="user-meta" style="margin-left:auto">${timeAgo(msg.created_at)}</span>
</div>
<div class="info-text">${escapeHtml(richMessagePreview(msg))}</div>`;
}

function renderScheduledMessage(msg: SlackScheduledMessage): string {
  const scheduledAt = new Date(msg.post_at * 1000).toLocaleString("en-US", { timeZone: "UTC" });
  return `<div class="org-row">
  <span class="org-icon">S</span>
  <span class="org-name">${escapeHtml(msg.scheduled_message_id)} <span class="badge badge-requested">scheduled</span></span>
  <span class="user-meta" style="margin-left:auto">${escapeHtml(scheduledAt)} UTC</span>
</div>
<div class="info-text">${escapeHtml(richMessagePreview(msg))}</div>`;
}

function renderPin(pin: SlackPin, message: SlackMessage | undefined, users: Map<string, string>): string {
  const creator = users.get(pin.created_by) ?? pin.created_by;
  const text = message ? richMessagePreview(message) : pin.message_ts;
  return `<div class="org-row">
  <span class="org-icon">P</span>
  <span class="org-name">${escapeHtml(creator)} <span class="badge badge-requested">pin</span></span>
  <span class="user-meta">${timeAgo(new Date(pin.created * 1000).toISOString())}</span>
</div>
<div class="info-text">${escapeHtml(text)}</div>`;
}

function renderBookmark(bookmark: SlackBookmark): string {
  return `<div class="org-row">
  <span class="org-icon">B</span>
  <span class="org-name">${escapeHtml(bookmark.title)} <span class="badge badge-granted">bookmark</span></span>
  <span class="user-meta">${escapeHtml(bookmark.type)}</span>
</div>
<div class="info-text">${escapeHtml(bookmark.link)}</div>`;
}

function renderChannelSidebar(channels: SlackChannel[], activeId: string): string {
  return channels
    .map((ch) => {
      const active = ch.channel_id === activeId ? ' class="active"' : "";
      const prefix = ch.is_private ? "private " : "# ";
      return `<a href="/?channel=${escapeHtml(ch.channel_id)}"${active}>${prefix}${escapeHtml(ch.name)}</a>`;
    })
    .join("\n");
}

export function inspectorRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ss = () => getSlackStore(store);

  // Message Inspector - the visual dashboard
  app.get("/", (c) => {
    const channels = ss()
      .channels.all()
      .filter((ch) => !ch.is_archived);
    const team = ss().teams.all()[0];

    if (channels.length === 0) {
      return c.html(
        renderSettingsPage(
          "Slack Inspector",
          "<p class='empty'>No channels</p>",
          "<p class='empty'>No channels in the emulator store.</p>",
          SERVICE_LABEL,
        ),
      );
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
    const messages = ss()
      .messages.findBy("channel_id", activeChannel.channel_id)
      .sort((a, b) => (b.ts > a.ts ? 1 : -1))
      .slice(0, 50);
    const ephemeralMessages = ss()
      .ephemeralMessages.findBy("channel_id", activeChannel.channel_id)
      .sort((a, b) => (b.ts > a.ts ? 1 : -1))
      .slice(0, 20);
    const scheduledMessages = ss()
      .scheduledMessages.findBy("channel_id", activeChannel.channel_id)
      .sort((a, b) => a.post_at - b.post_at)
      .slice(0, 20);
    const pins = ss()
      .pins.findBy("channel_id", activeChannel.channel_id)
      .filter((pin) =>
        ss()
          .messages.findBy("channel_id", pin.channel_id)
          .some((message) => message.ts === pin.message_ts),
      )
      .sort((a, b) => b.created - a.created)
      .slice(0, 20);
    const bookmarks = ss()
      .bookmarks.findBy("channel_id", activeChannel.channel_id)
      .sort((a, b) => a.date_created - b.date_created)
      .slice(0, 20);

    const sidebar = renderChannelSidebar(channels, activeChannel.channel_id);

    // Build the message list
    const messageHtml =
      messages.length === 0
        ? '<p class="empty">No messages yet. Post one with chat.postMessage or an incoming webhook.</p>'
        : messages.map((m) => renderMessage(m, userMap)).join("\n<div style='height:8px'></div>\n");
    const ephemeralHtml =
      ephemeralMessages.length === 0
        ? ""
        : `<div class="section-heading">Ephemeral</div>${ephemeralMessages
            .map((m) => renderEphemeralMessage(m, userMap))
            .join("\n<div style='height:8px'></div>\n")}`;
    const scheduledHtml =
      scheduledMessages.length === 0
        ? ""
        : `<div class="section-heading">Scheduled</div>${scheduledMessages
            .map(renderScheduledMessage)
            .join("\n<div style='height:8px'></div>\n")}`;
    const pinsHtml =
      pins.length === 0
        ? ""
        : `<div class="section-heading">Pins</div>${pins
            .map((pin) =>
              renderPin(
                pin,
                messages.find((message) => message.ts === pin.message_ts),
                userMap,
              ),
            )
            .join("\n<div style='height:8px'></div>\n")}`;
    const bookmarksHtml =
      bookmarks.length === 0
        ? ""
        : `<div class="section-heading">Bookmarks</div>${bookmarks
            .map(renderBookmark)
            .join("\n<div style='height:8px'></div>\n")}`;

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
  ${ephemeralHtml}
  ${scheduledHtml}
  ${pinsHtml}
  ${bookmarksHtml}
</div>`;

    return c.html(renderSettingsPage(`${team?.name ?? "Slack"} - Message Inspector`, sidebar, bodyHtml, SERVICE_LABEL));
  });
}
