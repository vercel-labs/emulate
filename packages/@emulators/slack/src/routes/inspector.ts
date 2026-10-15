import type { InspectorTab, RouteContext, WebhookDelivery, WebhookSubscription } from "@emulators/core";
import { escapeAttr, escapeHtml, renderInspectorPage } from "@emulators/core";
import { getSlackStore } from "../store.js";
import type {
  SlackBookmark,
  SlackChannel,
  SlackEphemeralMessage,
  SlackIncomingWebhook,
  SlackInstallation,
  SlackMessage,
  SlackOAuthApp,
  SlackPin,
  SlackScheduledMessage,
  SlackToken,
  SlackView,
  SlackViewTrigger,
} from "../entities.js";
import { compareSlackBookmarks } from "./bookmarks.js";

const SERVICE_LABEL = "Slack";

const INSPECTOR_TABS: InspectorTab[] = [
  { id: "messages", label: "Messages", href: "/?tab=messages" },
  { id: "channels", label: "Channels", href: "/?tab=channels" },
  { id: "files", label: "Files", href: "/?tab=files" },
  { id: "views", label: "Views", href: "/?tab=views" },
  { id: "auth", label: "Auth", href: "/?tab=auth" },
  { id: "events", label: "Events", href: "/?tab=events" },
];

type InspectorTabId = (typeof INSPECTOR_TABS)[number]["id"];

function timeAgo(isoDate: string): string {
  const seconds = Math.floor((Date.now() - new Date(isoDate).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
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

function richMessagePreview(
  msg: Pick<SlackMessage, "text" | "blocks" | "attachments" | "files"> | SlackScheduledMessage,
): string {
  if (msg.text.trim().length > 0) return msg.text;

  const blockText: string[] = [];
  collectTextValues(msg.blocks, blockText);
  if (blockText.length > 0) return blockText.join(" ");

  const attachmentText =
    msg.attachments
      ?.flatMap((attachment) => [attachment.text, attachment.title])
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0) ?? [];
  if (attachmentText.length > 0) return attachmentText.join(" ");

  const files = "files" in msg ? msg.files : undefined;
  const fileText = files?.map((file) => file.title || file.name).filter((value) => value.trim().length > 0) ?? [];
  if (fileText.length > 0) return fileText.join(" ");

  if (msg.blocks?.length) return `${msg.blocks.length} ${msg.blocks.length === 1 ? "block" : "blocks"}`;
  if (msg.attachments?.length) {
    return `${msg.attachments.length} ${msg.attachments.length === 1 ? "attachment" : "attachments"}`;
  }
  if (files?.length) return `${files.length} ${files.length === 1 ? "file" : "files"}`;
  return msg.text;
}

function viewPreview(view: SlackView): string {
  const blockText: string[] = [];
  collectTextValues(view.blocks, blockText);
  if (blockText.length > 0) return blockText.join(" ");

  const title = view.title?.text;
  if (typeof title === "string" && title.trim().length > 0) return title;

  if (view.callback_id) return view.callback_id;
  if (view.external_id) return view.external_id;
  return `${view.blocks.length} ${view.blocks.length === 1 ? "block" : "blocks"}`;
}

function renderSection(title: string, body: string): string {
  return `<section class="inspector-section">
  <h2>${escapeHtml(title)}</h2>
  ${body}
</section>`;
}

function renderTable(headers: string[], rows: string[][], empty: string): string {
  if (rows.length === 0) return `<p class="inspector-empty">${escapeHtml(empty)}</p>`;

  const headerHtml = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("");
  const rowsHtml = rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("\n");
  return `<table class="inspector-table">
  <thead><tr>${headerHtml}</tr></thead>
  <tbody>
${rowsHtml}
  </tbody>
</table>`;
}

function badge(label: string, tone: "granted" | "requested" | "denied" = "requested"): string {
  return `<span class="badge badge-${tone}">${escapeHtml(label)}</span>`;
}

function renderReactionBadges(reactions: Array<{ name: string; count: number }>): string {
  if (reactions.length === 0) return "";
  return reactions.map((reaction) => badge(`:${reaction.name}: ${reaction.count}`, "granted")).join(" ");
}

function linkCell(href: string, label: string): string {
  return `<a href="${escapeAttr(href)}">${escapeHtml(label)}</a>`;
}

function scopePreview(scopes: string[] | undefined): string {
  if (!scopes || scopes.length === 0) return "";
  return scopes.join(", ");
}

function userLabel(users: Map<string, string>, id: string): string {
  return users.get(id) ?? id;
}

function channelLabel(ch: SlackChannel): string {
  if (ch.is_im) return `DM ${ch.name}`;
  if (ch.is_mpim) return `MPIM ${ch.name}`;
  if (ch.is_private) return `private ${ch.name}`;
  return `# ${ch.name}`;
}

function channelKind(ch: SlackChannel): string {
  if (ch.is_im) return "DM";
  if (ch.is_mpim) return "MPIM";
  if (ch.is_private) return "Private";
  return "Public";
}

function openStateLabel(ch: SlackChannel, users: Map<string, string>): string {
  if (ch.is_open_by_user) {
    const openUsers = Object.entries(ch.is_open_by_user)
      .filter(([, isOpen]) => isOpen === true)
      .map(([userId]) => userLabel(users, userId));
    return openUsers.length > 0 ? openUsers.join(", ") : "closed";
  }
  return ch.is_open ? "open" : "closed";
}

function maskToken(value: string): string {
  if (value.length <= 10) return value;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function sortedChannels(channels: SlackChannel[]): SlackChannel[] {
  return [...channels].sort(
    (a, b) =>
      Number(a.is_archived) - Number(b.is_archived) ||
      channelKind(a).localeCompare(channelKind(b)) ||
      a.name.localeCompare(b.name),
  );
}

export function inspectorRoutes(ctx: RouteContext): void {
  const { app, store, webhooks } = ctx;
  const ss = () => getSlackStore(store);

  app.get("/", (c) => {
    const team = ss().teams.all()[0];
    const requestedTab = c.req.query("tab") ?? "messages";
    const activeTab = INSPECTOR_TABS.some((tab) => tab.id === requestedTab)
      ? (requestedTab as InspectorTabId)
      : "messages";
    const users = buildUserMap();

    const body =
      activeTab === "channels"
        ? renderChannelsView(users)
        : activeTab === "files"
          ? renderFilesView(users)
          : activeTab === "views"
            ? renderViewsView(users)
            : activeTab === "auth"
              ? renderAuthView()
              : activeTab === "events"
                ? renderEventsView()
                : renderMessagesView(c.req.query("channel") ?? "", users);

    return c.html(
      renderInspectorPage(
        `${team?.name ?? "Slack"} - Message Inspector`,
        INSPECTOR_TABS,
        activeTab,
        body,
        SERVICE_LABEL,
      ),
    );
  });

  function buildUserMap(): Map<string, string> {
    const userMap = new Map<string, string>();
    for (const u of ss().users.all()) {
      userMap.set(u.user_id, u.name);
      userMap.set(u.name, u.name);
    }
    for (const b of ss().bots.all()) {
      userMap.set(b.bot_id, b.name);
      if (b.user_id) userMap.set(b.user_id, b.name);
    }
    return userMap;
  }

  function renderMessagesView(requestedChannel: string, users: Map<string, string>): string {
    const channels = sortedChannels(ss().channels.all());
    const visibleChannels = channels.filter((ch) => !ch.is_archived);
    const activeChannel =
      channels.find((ch) => ch.channel_id === requestedChannel) ?? visibleChannels[0] ?? channels[0];
    if (!activeChannel) {
      return renderSection("Messages", '<p class="inspector-empty">No conversations in the emulator store.</p>');
    }

    const channelMessages = ss()
      .messages.findBy("channel_id", activeChannel.channel_id)
      .sort((a, b) => (b.ts > a.ts ? 1 : -1));
    const messages = channelMessages.slice(0, 50);
    const threads = channelMessages
      .filter((message) => message.thread_ts && message.thread_ts !== message.ts)
      .slice(0, 20);
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
      .filter((pin) => channelMessages.some((message) => message.ts === pin.message_ts))
      .sort((a, b) => b.created - a.created)
      .slice(0, 20);
    const bookmarks = ss()
      .bookmarks.findBy("channel_id", activeChannel.channel_id)
      .sort(compareSlackBookmarks)
      .slice(0, 20);
    const views = ss()
      .views.all()
      .sort((a, b) => b.updated - a.updated || b.id - a.id);
    const homeViews = views.filter((view) => view.type === "home").slice(0, 20);
    const modalViews = views.filter((view) => view.type === "modal").slice(0, 20);

    const stats = `${ss().users.all().length} users, ${channels.length} conversations, ${ss().messages.all().length} messages, ${ss().views.all().length} views`;
    const body = [
      renderConversationSelector(channels, activeChannel.channel_id),
      renderSection(
        `Messages In ${channelLabel(activeChannel)}`,
        `<p class="info-text">${escapeHtml(activeChannel.topic.value || "No topic set")} - ${escapeHtml(stats)}</p>` +
          renderMessagesTable(
            messages,
            users,
            "No messages yet. Post one with chat.postMessage or an incoming webhook.",
          ),
      ),
      renderSection("Threads", renderMessagesTable(threads, users, "No thread replies for this conversation.")),
      renderSection(
        "Ephemeral",
        renderEphemeralTable(ephemeralMessages, users, "No ephemeral messages for this conversation."),
      ),
      renderSection(
        "Scheduled",
        renderScheduledTable(scheduledMessages, users, "No scheduled messages for this conversation."),
      ),
      renderSection("Pins", renderPinsTable(pins, channelMessages, users, "No pins for this conversation.")),
      renderSection("Bookmarks", renderBookmarksTable(bookmarks, "No bookmarks for this conversation.")),
      renderSection("App Home", renderViewsTable(homeViews, users, "No App Home views have been published.")),
      renderSection("Modals", renderViewsTable(modalViews, users, "No modal views have been opened.")),
    ];
    return body.join("\n");
  }

  function renderConversationSelector(channels: SlackChannel[], activeChannelId: string): string {
    const rows = channels.map((ch) => [
      ch.channel_id === activeChannelId ? badge("active", "granted") : "",
      linkCell(`/?tab=messages&channel=${encodeURIComponent(ch.channel_id)}`, channelLabel(ch)),
      escapeHtml(channelKind(ch)),
      escapeHtml(String(ch.num_members)),
      ch.is_archived ? badge("archived", "denied") : badge("open", "granted"),
    ]);
    return renderSection(
      "Conversations",
      renderTable(["", "Name", "Type", "Members", "State"], rows, "No conversations in the emulator store."),
    );
  }

  function renderChannelsView(users: Map<string, string>): string {
    const channels = sortedChannels(ss().channels.all());
    const conversations = channels.filter((channel) => !channel.is_im && !channel.is_mpim);
    const dms = channels.filter((channel) => channel.is_im || channel.is_mpim);

    return [
      renderSection(
        "Channels",
        renderTable(
          ["ID", "Name", "Type", "Members", "Topic", "Purpose", "State"],
          conversations.map((ch) => [
            escapeHtml(ch.channel_id),
            linkCell(`/?tab=messages&channel=${encodeURIComponent(ch.channel_id)}`, channelLabel(ch)),
            escapeHtml(channelKind(ch)),
            escapeHtml(ch.members.map((member) => userLabel(users, member)).join(", ")),
            escapeHtml(ch.topic.value),
            escapeHtml(ch.purpose.value),
            ch.is_archived ? badge("archived", "denied") : badge("open", "granted"),
          ]),
          "No channels in the emulator store.",
        ),
      ),
      renderSection(
        "Direct Messages",
        renderTable(
          ["ID", "Name", "Type", "Members", "Open State"],
          dms.map((ch) => [
            escapeHtml(ch.channel_id),
            linkCell(`/?tab=messages&channel=${encodeURIComponent(ch.channel_id)}`, channelLabel(ch)),
            escapeHtml(channelKind(ch)),
            escapeHtml(ch.members.map((member) => userLabel(users, member)).join(", ")),
            escapeHtml(openStateLabel(ch, users)),
          ]),
          "No DMs or MPIMs in the emulator store.",
        ),
      ),
    ].join("\n");
  }

  function renderFilesView(users: Map<string, string>): string {
    const files = ss()
      .files.all()
      .sort((a, b) => b.created - a.created || b.id - a.id);
    const sessions = ss()
      .fileUploadSessions.all()
      .filter((session) => !session.completed)
      .sort((a, b) => b.id - a.id);

    return [
      renderSection(
        "Files",
        renderTable(
          ["ID", "Title", "User", "Channels", "Size", "State", "Created"],
          files.map((file) => [
            escapeHtml(file.file_id),
            escapeHtml(file.title || file.name),
            escapeHtml(userLabel(users, file.user)),
            escapeHtml([...file.channels, ...file.groups, ...file.ims].join(", ")),
            escapeHtml(String(file.size)),
            file.deleted ? badge("deleted", "denied") : badge("available", "granted"),
            escapeHtml(new Date(file.created * 1000).toISOString()),
          ]),
          "No completed files in the emulator store.",
        ),
      ),
      renderSection(
        "Pending Uploads",
        renderTable(
          ["File ID", "Filename", "Title", "Length", "Uploaded", "Completed"],
          sessions.map((session) => [
            escapeHtml(session.file_id),
            escapeHtml(session.filename),
            escapeHtml(session.title),
            escapeHtml(String(session.length)),
            session.uploaded ? badge("uploaded", "granted") : badge("pending"),
            session.completed ? badge("complete", "granted") : badge("pending"),
          ]),
          "No pending external upload sessions.",
        ),
      ),
    ].join("\n");
  }

  function renderViewsView(users: Map<string, string>): string {
    const views = ss()
      .views.all()
      .sort((a, b) => b.updated - a.updated || b.id - a.id);
    const homeViews = views.filter((view) => view.type === "home");
    const modalViews = views.filter((view) => view.type === "modal");
    const triggers = ss()
      .viewTriggers.all()
      .sort((a, b) => b.expires_at - a.expires_at || b.id - a.id);

    return [
      renderSection("App Home", renderViewsTable(homeViews, users, "No App Home views have been published.")),
      renderSection("Modals", renderViewsTable(modalViews, users, "No modal views have been opened.")),
      renderSection("Trigger IDs", renderTriggerTable(triggers, users)),
    ].join("\n");
  }

  function renderAuthView(): string {
    const subscriptions = webhooks.getSubscriptions("slack");
    return [
      renderSection("OAuth Apps", renderOAuthAppsTable(ss().oauthApps.all())),
      renderSection("Installations", renderInstallationsTable(ss().installations.all())),
      renderSection("Tokens", renderTokensTable(ss().tokens.all())),
      renderSection("Incoming Webhooks", renderIncomingWebhooksTable(ss().incomingWebhooks.all())),
      renderSection("Event Subscriptions", renderSubscriptionsTable(subscriptions)),
    ].join("\n");
  }

  function renderEventsView(): string {
    const subscriptions = webhooks.getSubscriptions("slack");
    const slackHookIds = new Set(subscriptions.map((subscription) => subscription.id));
    const allDeliveries = webhooks
      .getDeliveries()
      .filter((delivery) => slackHookIds.has(delivery.hook_id))
      .sort((a, b) => b.id - a.id);
    const deliveries = allDeliveries.slice(0, 100);
    const failed = allDeliveries.filter((delivery) => !delivery.success).slice(0, 100);

    return [
      renderSection("Event Subscriptions", renderSubscriptionsTable(subscriptions)),
      renderSection(
        "Event Deliveries",
        renderDeliveriesTable(deliveries, subscriptions, "No Slack event deliveries yet."),
      ),
      renderSection("Last Errors", renderDeliveriesTable(failed, subscriptions, "No failed Slack event deliveries.")),
    ].join("\n");
  }
}

function renderMessagesTable(messages: SlackMessage[], users: Map<string, string>, empty: string): string {
  return renderTable(
    ["Time", "User", "Message", "Reactions", "TS"],
    messages.map((msg) => {
      const isBot = msg.subtype === "bot_message";
      const richBadge =
        msg.text.length === 0 && ((msg.blocks?.length ?? 0) > 0 || (msg.attachments?.length ?? 0) > 0)
          ? ` ${badge("rich", "granted")}`
          : "";
      const threadBadge =
        msg.reply_count > 0
          ? ` ${badge(`${msg.reply_count} ${msg.reply_count === 1 ? "reply" : "replies"}`, "requested")}`
          : "";
      const fileBadge = msg.files?.length
        ? ` ${badge(`${msg.files.length} ${msg.files.length === 1 ? "file" : "files"}`, "granted")}`
        : "";
      const threadIndicator = msg.thread_ts && msg.thread_ts !== msg.ts ? `${badge("thread", "denied")} ` : "";
      return [
        escapeHtml(timeAgo(msg.created_at)),
        `${escapeHtml(userLabel(users, msg.user))}${isBot ? ` ${badge("bot", "granted")}` : ""}`,
        `${threadIndicator}${escapeHtml(richMessagePreview(msg))}${richBadge}${fileBadge}${threadBadge}`,
        renderReactionBadges(msg.reactions),
        escapeHtml(msg.ts),
      ];
    }),
    empty,
  );
}

function renderEphemeralTable(messages: SlackEphemeralMessage[], users: Map<string, string>, empty: string): string {
  return renderTable(
    ["Time", "Target", "Message", "TS"],
    messages.map((msg) => [
      escapeHtml(timeAgo(msg.created_at)),
      `${escapeHtml(userLabel(users, msg.target_user))} ${badge("ephemeral", "requested")}`,
      escapeHtml(richMessagePreview(msg)),
      escapeHtml(msg.ts),
    ]),
    empty,
  );
}

function renderScheduledTable(messages: SlackScheduledMessage[], users: Map<string, string>, empty: string): string {
  return renderTable(
    ["Post At", "User", "Message", "ID"],
    messages.map((msg) => [
      escapeHtml(new Date(msg.post_at * 1000).toISOString()),
      escapeHtml(userLabel(users, msg.user)),
      escapeHtml(richMessagePreview(msg)),
      escapeHtml(msg.scheduled_message_id),
    ]),
    empty,
  );
}

function renderPinsTable(
  pins: SlackPin[],
  channelMessages: SlackMessage[],
  users: Map<string, string>,
  empty: string,
): string {
  return renderTable(
    ["Created", "Creator", "Message", "TS"],
    pins.map((pin) => {
      const message = channelMessages.find((candidate) => candidate.ts === pin.message_ts);
      return [
        escapeHtml(new Date(pin.created * 1000).toISOString()),
        escapeHtml(userLabel(users, pin.created_by)),
        escapeHtml(message ? richMessagePreview(message) : pin.message_ts),
        escapeHtml(pin.message_ts),
      ];
    }),
    empty,
  );
}

function renderBookmarksTable(bookmarks: SlackBookmark[], empty: string): string {
  return renderTable(
    ["Title", "Type", "Link", "Rank"],
    bookmarks.map((bookmark) => [
      escapeHtml(bookmark.title),
      escapeHtml(bookmark.type),
      escapeHtml(bookmark.link),
      escapeHtml(bookmark.rank),
    ]),
    empty,
  );
}

function renderViewsTable(views: SlackView[], users: Map<string, string>, empty: string): string {
  return renderTable(
    ["ID", "Type", "User", "App", "Preview", "Hash", "Root", "Previous"],
    views.map((view) => [
      escapeHtml(view.view_id),
      view.type === "home" ? badge("app home", "granted") : badge("modal", "requested"),
      escapeHtml(userLabel(users, view.user_id)),
      escapeHtml(view.app_id),
      escapeHtml(viewPreview(view)),
      escapeHtml(view.hash),
      escapeHtml(view.root_view_id),
      escapeHtml(view.previous_view_id ?? ""),
    ]),
    empty,
  );
}

function renderTriggerTable(triggers: SlackViewTrigger[], users: Map<string, string>): string {
  const now = Math.floor(Date.now() / 1000);
  return renderTable(
    ["Trigger ID", "User", "App", "View", "Expires", "State"],
    triggers.map((trigger) => [
      escapeHtml(trigger.trigger_id),
      escapeHtml(userLabel(users, trigger.user_id)),
      escapeHtml(trigger.app_id),
      escapeHtml(trigger.view_id ?? ""),
      escapeHtml(new Date(trigger.expires_at * 1000).toISOString()),
      trigger.used
        ? badge("used", "denied")
        : trigger.expires_at <= now
          ? badge("expired", "denied")
          : badge("active", "granted"),
    ]),
    "No local trigger ids have been generated.",
  );
}

function renderOAuthAppsTable(apps: SlackOAuthApp[]): string {
  return renderTable(
    ["App ID", "Client ID", "Name", "Bot", "Scopes", "User Scopes"],
    apps.map((app) => [
      escapeHtml(app.app_id ?? ""),
      escapeHtml(app.client_id),
      escapeHtml(app.name),
      escapeHtml(app.bot_id ?? app.bot_name ?? ""),
      escapeHtml(scopePreview(app.scopes)),
      escapeHtml(scopePreview(app.user_scopes)),
    ]),
    "No OAuth apps are configured.",
  );
}

function renderInstallationsTable(installations: SlackInstallation[]): string {
  return renderTable(
    ["Installation", "App", "Team", "Bot User", "Installer", "Scopes"],
    installations.map((installation) => [
      escapeHtml(installation.installation_id),
      escapeHtml(installation.app_id),
      escapeHtml(installation.team_id),
      escapeHtml(installation.bot_user_id),
      escapeHtml(installation.installer_user_id),
      escapeHtml(scopePreview(installation.scopes)),
    ]),
    "No OAuth installations have been recorded.",
  );
}

function renderTokensTable(tokens: SlackToken[]): string {
  return renderTable(
    ["Token", "Type", "Team", "User", "App", "Bot", "Scopes"],
    tokens.map((token) => [
      escapeHtml(maskToken(token.token)),
      escapeHtml(token.token_type),
      escapeHtml(token.team_id),
      escapeHtml(token.user_id),
      escapeHtml(token.app_id ?? ""),
      escapeHtml(token.bot_id ?? token.bot_user_id ?? ""),
      escapeHtml(scopePreview(token.scopes)),
    ]),
    "No Slack token records have been seeded or exchanged.",
  );
}

function renderIncomingWebhooksTable(webhooks: SlackIncomingWebhook[]): string {
  return renderTable(
    ["Token", "Team", "Bot", "Default Channel", "Label", "URL"],
    webhooks.map((webhook) => [
      escapeHtml(maskToken(webhook.token)),
      escapeHtml(webhook.team_id),
      escapeHtml(webhook.bot_id),
      escapeHtml(webhook.default_channel),
      escapeHtml(webhook.label),
      escapeHtml(webhook.url),
    ]),
    "No incoming webhooks are configured.",
  );
}

function renderSubscriptionsTable(subscriptions: WebhookSubscription[]): string {
  return renderTable(
    ["ID", "URL", "Events", "State"],
    subscriptions.map((subscription) => [
      escapeHtml(String(subscription.id)),
      escapeHtml(subscription.url),
      escapeHtml(subscription.events.join(", ")),
      subscription.active ? badge("active", "granted") : badge("inactive", "denied"),
    ]),
    "No Slack event subscriptions are registered.",
  );
}

function renderDeliveriesTable(
  deliveries: WebhookDelivery[],
  subscriptions: WebhookSubscription[],
  empty: string,
): string {
  const subscriptionsById = new Map(subscriptions.map((subscription) => [subscription.id, subscription]));
  return renderTable(
    ["ID", "Event", "Event ID", "Retry", "Hook", "URL", "Status", "Duration", "Delivered"],
    deliveries.map((delivery) => {
      const subscription = subscriptionsById.get(delivery.hook_id);
      return [
        escapeHtml(String(delivery.id)),
        escapeHtml(delivery.event),
        escapeHtml(String((delivery.payload as { event_id?: string } | null)?.event_id ?? "")),
        escapeHtml(String(delivery.redelivery_count ?? 0)),
        escapeHtml(String(delivery.hook_id)),
        escapeHtml(subscription?.url ?? ""),
        delivery.success
          ? badge(String(delivery.status_code ?? "ok"), "granted")
          : badge(String(delivery.status_code ?? "failed"), "denied"),
        escapeHtml(delivery.duration === null ? "" : `${delivery.duration}ms`),
        escapeHtml(delivery.delivered_at),
      ];
    }),
    empty,
  );
}
