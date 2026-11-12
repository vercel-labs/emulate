import type { Context, Store, TokenMap } from "@emulators/core";
import type { SlackToken } from "./entities.js";
import { getSlackStore } from "./store.js";

export function slackRequestToken(c: Context): string | undefined {
  const authHeader = c.req.header("Authorization");
  if (!authHeader) return undefined;
  return authHeader.replace(/^(Bearer|token)\s+/i, "").trim() || undefined;
}

export function isSlackTokenRevoked(store: Store, token: string): boolean {
  return store.getData<Set<string>>("slack.revoked_tokens")?.has(token) ?? false;
}

/** Tokens revoked by auth.revoke fail later calls with invalid_auth, not token_revoked, which Slack reserves for
 * deleted users or workspaces and removed apps. */
export function isSlackTokenInvalidated(store: Store, token: string): boolean {
  return store.getData<Set<string>>("slack.invalidated_tokens")?.has(token) ?? false;
}

export function invalidateSlackToken(store: Store, token: string, tokenMap?: TokenMap): void {
  const ss = getSlackStore(store);
  const invalidated = store.getData<Set<string>>("slack.invalidated_tokens") ?? new Set<string>();
  invalidated.add(token);
  const record = ss.tokens.findOneBy("token", token);
  const login = tokenMap?.get(token)?.login;
  const tokenUser = record
    ? undefined
    : login
      ? (ss.users.findOneBy("user_id", login) ?? ss.users.findOneBy("name", login))
      : undefined;
  if (record) ss.tokens.delete(record.id);
  tokenMap?.delete(token);
  store.setData("slack.invalidated_tokens", invalidated);

  const botUserId =
    record?.token_type === "bot"
      ? (record.bot_user_id ?? record.user_id)
      : tokenUser?.is_bot
        ? tokenUser.user_id
        : undefined;
  if (botUserId && !hasLiveSlackBotToken(store, botUserId, tokenMap)) {
    deactivateSlackBotUser(store, botUserId, record?.bot_id);
  }
}

/** Every oauth.v2.access exchange issues a new bot token and keeps the old ones, so the bot stays active while any
 * other token still authenticates as it. */
function hasLiveSlackBotToken(store: Store, botUserId: string, tokenMap?: TokenMap): boolean {
  const ss = getSlackStore(store);
  if (
    ss.tokens.all().some((token) => token.token_type === "bot" && (token.bot_user_id ?? token.user_id) === botUserId)
  ) {
    return true;
  }
  if (!tokenMap) return false;
  const user = ss.users.findOneBy("user_id", botUserId);
  const aliases = new Set([botUserId, user?.name].filter((value): value is string => Boolean(value)));
  for (const [token, entry] of tokenMap) {
    if (aliases.has(entry.login) && !isSlackTokenRevoked(store, token) && !isSlackTokenInvalidated(store, token)) {
      return true;
    }
  }
  return false;
}

/** Revoking a bot token keeps the app installed but deactivates the bot user and removes its channel memberships. */
function deactivateSlackBotUser(store: Store, botUserId: string, botId?: string): void {
  const ss = getSlackStore(store);
  const user = ss.users.findOneBy("user_id", botUserId);
  if (user) ss.users.update(user.id, { deleted: true });
  for (const bot of ss.bots.all()) {
    if (bot.bot_id === botId || bot.user_id === botUserId) ss.bots.update(bot.id, { deleted: true });
  }

  const aliases = new Set([botUserId, user?.name].filter((value): value is string => Boolean(value)));
  for (const channel of ss.channels.all()) {
    if (!channel.members.some((member) => aliases.has(member))) continue;
    const members = channel.members.filter((member) => !aliases.has(member));
    ss.channels.update(channel.id, { members, num_members: members.length });
  }
}

export function revokeSlackTokens(store: Store, tokens: SlackToken[], tokenMap?: TokenMap): void {
  const revoked = store.getData<Set<string>>("slack.revoked_tokens") ?? new Set<string>();
  const ss = getSlackStore(store);
  for (const token of tokens) {
    revoked.add(token.token);
    ss.tokens.delete(token.id);
    tokenMap?.delete(token.token);
  }
  store.setData("slack.revoked_tokens", revoked);
}
