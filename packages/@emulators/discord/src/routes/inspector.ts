import type { RouteContext } from "@emulators/core";
import { escapeHtml, renderInspectorPage } from "@emulators/core";
import { getDiscordStore } from "../store.js";
import type { DiscordChannel, DiscordGuild } from "../entities.js";

const SERVICE_LABEL = "Discord";

const tabs = [
  { id: "guilds", label: "Guilds", href: "/?tab=guilds" },
  { id: "channels", label: "Channels", href: "/?tab=channels" },
  { id: "messages", label: "Messages", href: "/?tab=messages" },
  { id: "members", label: "Members", href: "/?tab=members" },
  { id: "roles", label: "Roles", href: "/?tab=roles" },
];

export function inspectorRoutes(ctx: RouteContext): void {
  const { app } = ctx;

  app.get("/", (c) => {
    const tab = c.req.query("tab") ?? "guilds";
    const active = tabs.some((t) => t.id === tab) ? tab : "guilds";
    const body = renderBody(active, ctx);
    return c.html(renderInspectorPage("Discord Inspector", tabs, active, body, SERVICE_LABEL));
  });
}

function renderBody(active: string, ctx: RouteContext): string {
  const ds = getDiscordStore(ctx.store);
  if (active === "channels") return renderChannels(ds.guilds.all(), ds.channels.all());
  if (active === "messages") return renderMessages(ctx);
  if (active === "members") return renderMembers(ctx);
  if (active === "roles") return renderRoles(ctx);
  return renderGuilds(ctx);
}

function renderGuilds(ctx: RouteContext): string {
  const ds = getDiscordStore(ctx.store);
  const rows = ds.guilds
    .all()
    .map((guild) => {
      const channels = ds.channels.findBy("guild_id", guild.guild_id).length;
      const members = ds.members.findBy("guild_id", guild.guild_id).length;
      return `<tr><td>${escapeHtml(guild.guild_id)}</td><td>${escapeHtml(guild.name)}</td><td>${channels}</td><td>${members}</td></tr>`;
    })
    .join("");

  return tableSection("Guilds", ["ID", "Name", "Channels", "Members"], rows);
}

function renderChannels(guilds: DiscordGuild[], channels: DiscordChannel[]): string {
  const guildNames = new Map(guilds.map((guild) => [guild.guild_id, guild.name]));
  const rows = channels
    .map((channel) => {
      return `<tr><td>${escapeHtml(channel.channel_id)}</td><td>${escapeHtml(channel.name)}</td><td>${escapeHtml(guildNames.get(channel.guild_id ?? "") ?? "")}</td><td>${channel.type}</td><td>${escapeHtml(channel.topic ?? "")}</td></tr>`;
    })
    .join("");

  return tableSection("Channels", ["ID", "Name", "Guild", "Type", "Topic"], rows);
}

function renderMessages(ctx: RouteContext): string {
  const ds = getDiscordStore(ctx.store);
  const channelNames = new Map(ds.channels.all().map((channel) => [channel.channel_id, channel.name]));
  const userNames = new Map(ds.users.all().map((user) => [user.user_id, user.username]));
  const rows = ds.messages
    .all()
    .sort((a, b) => (b.timestamp > a.timestamp ? 1 : -1))
    .slice(0, 100)
    .map((message) => {
      return `<tr><td>${escapeHtml(message.message_id)}</td><td>${escapeHtml(channelNames.get(message.channel_id) ?? message.channel_id)}</td><td>${escapeHtml(userNames.get(message.author_id) ?? message.author_id)}</td><td>${escapeHtml(message.content)}</td><td>${escapeHtml(message.timestamp)}</td></tr>`;
    })
    .join("");

  return tableSection("Messages", ["ID", "Channel", "Author", "Content", "Timestamp"], rows);
}

function renderMembers(ctx: RouteContext): string {
  const ds = getDiscordStore(ctx.store);
  const guildNames = new Map(ds.guilds.all().map((guild) => [guild.guild_id, guild.name]));
  const userNames = new Map(ds.users.all().map((user) => [user.user_id, user.username]));
  const rows = ds.members
    .all()
    .map((member) => {
      return `<tr><td>${escapeHtml(guildNames.get(member.guild_id) ?? member.guild_id)}</td><td>${escapeHtml(userNames.get(member.user_id) ?? member.user_id)}</td><td>${escapeHtml(member.nick ?? "")}</td><td>${member.roles.length}</td></tr>`;
    })
    .join("");

  return tableSection("Members", ["Guild", "User", "Nick", "Roles"], rows);
}

function renderRoles(ctx: RouteContext): string {
  const ds = getDiscordStore(ctx.store);
  const guildNames = new Map(ds.guilds.all().map((guild) => [guild.guild_id, guild.name]));
  const rows = ds.roles
    .all()
    .map((role) => {
      return `<tr><td>${escapeHtml(role.role_id)}</td><td>${escapeHtml(role.name)}</td><td>${escapeHtml(guildNames.get(role.guild_id) ?? role.guild_id)}</td><td>${escapeHtml(role.permissions)}</td><td>${role.mentionable ? '<span class="badge badge-granted">yes</span>' : '<span class="badge badge-requested">no</span>'}</td></tr>`;
    })
    .join("");

  return tableSection("Roles", ["ID", "Name", "Guild", "Permissions", "Mentionable"], rows);
}

function tableSection(title: string, headers: string[], rows: string): string {
  const head = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("");
  const body =
    rows ||
    `<tr><td colspan="${headers.length}" class="inspector-empty">No ${escapeHtml(title.toLowerCase())}</td></tr>`;
  return `<section class="inspector-section"><h2>${escapeHtml(title)}</h2><table class="inspector-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></section>`;
}
