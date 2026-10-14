import type { Context, RouteContext } from "@emulators/core";
import type { SlackChannel, SlackMessage, SlackUser } from "../entities.js";
import { getSlackStore } from "../store.js";
import { formatSlackPermalink, parseSlackBody, requireSlackScopes, slackError, slackOk } from "../helpers.js";

const DEFAULT_COUNT = 20;
const MAX_COUNT = 100;

interface SearchQuery {
  terms: string[];
  inChannels: string[];
  fromUsers: string[];
  after?: number;
  before?: number;
  on?: [number, number];
}

// Splits a Slack search query into free-text terms and the modifiers this
// emulator supports: in:, from:, before:, after:, on:. Quoted phrases stay one
// term. Unsupported modifiers are treated as plain text so a query never fails.
export function parseSlackSearchQuery(query: string): SearchQuery {
  const parsed: SearchQuery = { terms: [], inChannels: [], fromUsers: [] };
  const tokens = query.match(/"[^"]*"|\S+/g) ?? [];
  for (const raw of tokens) {
    const token = raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2 ? raw.slice(1, -1) : raw;
    const modifier = /^(in|from|before|after|on):(.+)$/i.exec(token);
    if (!modifier || raw.startsWith('"')) {
      if (token.trim()) parsed.terms.push(token.toLowerCase());
      continue;
    }
    const [, key, value] = modifier;
    switch (key.toLowerCase()) {
      case "in":
        parsed.inChannels.push(stripReference(value, "#"));
        break;
      case "from":
        parsed.fromUsers.push(stripReference(value, "@"));
        break;
      case "after":
      case "before":
      case "on": {
        const day = Date.parse(`${value}T00:00:00Z`);
        if (Number.isNaN(day)) {
          parsed.terms.push(token.toLowerCase());
        } else if (key.toLowerCase() === "after") {
          parsed.after = day + 86_400_000;
        } else if (key.toLowerCase() === "before") {
          parsed.before = day;
        } else {
          parsed.on = [day, day + 86_400_000];
        }
        break;
      }
    }
  }
  return parsed;
}

// Accepts #name, name, <#C123|name>, <#C123>, @name, <@U123> and returns the id
// or name inside.
function stripReference(value: string, sigil: "#" | "@"): string {
  const link = /^<[#@]([A-Z0-9]+)(?:\|[^>]*)?>$/i.exec(value);
  if (link) return link[1];
  return value.startsWith(sigil) ? value.slice(1) : value;
}

// The text a reader sees: the message text plus every text node in its blocks
// and attachments, since messages posted as Block Kit often leave `text` empty.
function searchableText(msg: SlackMessage): string {
  const parts = [msg.text ?? ""];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === "object") {
      const record = node as Record<string, unknown>;
      if (typeof record.text === "string") parts.push(record.text);
      for (const value of Object.values(record)) {
        if (value && typeof value === "object") walk(value);
      }
    }
  };
  walk(msg.blocks ?? []);
  walk(msg.attachments ?? []);
  return parts.join("\n").toLowerCase();
}

function tsMillis(ts: string): number {
  return Math.floor(Number(ts) * 1000);
}

function paging(total: number, count: number, page: number) {
  const pages = Math.max(1, Math.ceil(total / count));
  return {
    pagination: {
      total_count: total,
      page,
      per_page: count,
      page_count: pages,
      first: total === 0 ? 0 : (page - 1) * count + 1,
      last: Math.min(page * count, total),
    },
    paging: { count, total, page, pages },
  };
}

export function searchRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const ss = () => getSlackStore(store);

  const getAuthSlackUser = (authUser: { login: string }) =>
    ss().users.findOneBy("user_id", authUser.login) ?? ss().users.findOneBy("name", authUser.login);

  const isMember = (ch: SlackChannel, user: SlackUser | undefined, userId: string) => {
    const aliases = new Set([userId, user?.name].filter((value): value is string => Boolean(value)));
    return ch.members.some((member) => aliases.has(member));
  };

  const findMessages = async (c: Context) => {
    const authUser = c.get("authUser");
    if (!authUser) return { error: slackError(c, "not_authed") };
    const scopeError = requireSlackScopes(c, store, ["search:read"]);
    if (scopeError) return { error: scopeError };

    const body = await parseSlackBody(c);
    const query = typeof body.query === "string" ? body.query : "";
    if (!query.trim()) return { error: slackError(c, "no_query") };
    const count = Math.min(Math.max(Number(body.count) || DEFAULT_COUNT, 1), MAX_COUNT);
    const page = Math.max(Number(body.page) || 1, 1);
    const sort = body.sort === "timestamp" ? "timestamp" : "score";
    const ascending = body.sort_dir === "asc";

    const authSlackUser = getAuthSlackUser(authUser);
    const authUserId = authSlackUser?.user_id ?? authUser.login;
    const parsed = parseSlackSearchQuery(query);

    const channels = new Map(
      ss()
        .channels.all()
        .map((ch) => [ch.channel_id, ch]),
    );
    const users = ss().users.all();
    const userIdsFor = (value: string) =>
      new Set(
        users.filter((u) => u.user_id === value || u.name.toLowerCase() === value.toLowerCase()).map((u) => u.user_id),
      );
    const fromIds = parsed.fromUsers.map(userIdsFor);
    const inChannelIds = parsed.inChannels.map(
      (value) =>
        new Set(
          [...channels.values()]
            .filter((ch) => ch.channel_id === value || ch.name.toLowerCase() === value.toLowerCase())
            .map((ch) => ch.channel_id),
        ),
    );

    const matches = ss()
      .messages.all()
      .filter((msg) => {
        const ch = channels.get(msg.channel_id);
        if (!ch) return false;
        if (ch.is_private || ch.is_im || ch.is_mpim) {
          if (!isMember(ch, authSlackUser, authUserId)) return false;
        }
        if (inChannelIds.some((ids) => !ids.has(msg.channel_id))) return false;
        if (fromIds.some((ids) => !ids.has(msg.user))) return false;
        const at = tsMillis(msg.ts);
        if (parsed.after !== undefined && at < parsed.after) return false;
        if (parsed.before !== undefined && at >= parsed.before) return false;
        if (parsed.on && (at < parsed.on[0] || at >= parsed.on[1])) return false;
        const text = searchableText(msg);
        return parsed.terms.every((term) => text.includes(term));
      })
      .map((msg) => {
        const text = searchableText(msg);
        const score = parsed.terms.reduce((total, term) => total + text.split(term).length - 1, 0);
        return { msg, score };
      });

    // Compare the full ts: its fractional part orders messages within a second.
    matches.sort((a, b) => {
      const byTime = Number(a.msg.ts) - Number(b.msg.ts);
      if (sort === "score" && a.score !== b.score) return ascending ? a.score - b.score : b.score - a.score;
      return ascending ? byTime : -byTime;
    });

    const pageMatches = matches.slice((page - 1) * count, page * count).map(({ msg, score }, index) => {
      const ch = channels.get(msg.channel_id)!;
      const author = users.find((u) => u.user_id === msg.user);
      return {
        iid: `${msg.channel_id}-${msg.ts}`,
        team: ch.team_id,
        score,
        channel: {
          id: ch.channel_id,
          name: ch.name,
          is_channel: ch.is_channel && !ch.is_private,
          is_group: ch.is_private && !ch.is_im && !ch.is_mpim,
          is_im: ch.is_im ?? false,
          is_mpim: ch.is_mpim ?? false,
          is_private: ch.is_private,
          is_shared: false,
          is_org_shared: false,
          is_ext_shared: false,
          pending_shared: [],
        },
        type: "message",
        user: msg.user,
        username: author?.name ?? "",
        ts: msg.ts,
        text: msg.text,
        ...(msg.blocks !== undefined ? { blocks: msg.blocks } : {}),
        ...(msg.thread_ts ? { thread_ts: msg.thread_ts } : {}),
        permalink: formatSlackPermalink(baseUrl, ch.channel_id, msg),
        index: (page - 1) * count + index,
      };
    });

    return {
      query,
      messages: { total: matches.length, ...paging(matches.length, count, page), matches: pageMatches },
      count,
      page,
    };
  };

  // search.messages
  app.post("/api/search.messages", async (c) => {
    const result = await findMessages(c);
    if ("error" in result) return result.error;
    return slackOk(c, { query: result.query, messages: result.messages });
  });

  // search.all: message results only; files are not searched by this emulator.
  app.post("/api/search.all", async (c) => {
    const result = await findMessages(c);
    if ("error" in result) return result.error;
    return slackOk(c, {
      query: result.query,
      messages: result.messages,
      files: { total: 0, ...paging(0, result.count, result.page), matches: [] },
      posts: { total: 0, matches: [] },
    });
  });
}
