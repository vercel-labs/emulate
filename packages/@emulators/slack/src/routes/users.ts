import type { Context, RouteContext } from "@emulators/core";
import { getSlackStore } from "../store.js";
import {
  generateTs,
  slackOk,
  slackError,
  parseSlackBody,
  requireSlackScopes,
  isSlackStrictScopes,
  hasSlackScope,
  onGetOrPost,
} from "../helpers.js";
import type { SlackManualPresence, SlackPresence, SlackUser, SlackUserProfile } from "../entities.js";

export function usersRoutes(ctx: RouteContext): void {
  const { app, store, webhooks } = ctx;
  const ss = () => getSlackStore(store);
  const getAuthSlackUser = (authUser: { login: string }) =>
    ss().users.findOneBy("user_id", authUser.login) ?? ss().users.findOneBy("name", authUser.login);
  const getAuthUserId = (authUser: { login: string }) => getAuthSlackUser(authUser)?.user_id ?? authUser.login;

  // users.list
  onGetOrPost(app, "/api/users.list", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["users:read"]);
    if (scopeError) return scopeError;

    const body = await parseSlackBody(c);
    const limit = Math.min(Number(body.limit) || 100, 1000);
    const cursor = typeof body.cursor === "string" ? body.cursor : "";

    const allUsers = ss()
      .users.all()
      .filter((u) => !u.deleted);

    let startIndex = 0;
    if (cursor) {
      const idx = allUsers.findIndex((u) => u.user_id === cursor);
      if (idx >= 0) startIndex = idx;
    }

    const page = allUsers.slice(startIndex, startIndex + limit);
    const nextCursor = startIndex + limit < allUsers.length ? allUsers[startIndex + limit].user_id : "";

    return slackOk(c, {
      members: page.map((user) => formatUser(user, canExposeEmail(c))),
      response_metadata: { next_cursor: nextCursor },
    });
  });

  // users.info
  onGetOrPost(app, "/api/users.info", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["users:read"]);
    if (scopeError) return scopeError;

    const body = await parseSlackBody(c);
    const userId = typeof body.user === "string" ? body.user : "";

    const user = ss().users.findOneBy("user_id", userId);
    if (!user) return slackError(c, "user_not_found");

    return slackOk(c, { user: formatUser(user, canExposeEmail(c)) });
  });

  // users.lookupByEmail
  onGetOrPost(app, "/api/users.lookupByEmail", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["users:read.email"]);
    if (scopeError) return scopeError;

    const body = await parseSlackBody(c);
    const email = typeof body.email === "string" ? body.email : "";

    if (!email) return slackError(c, "users_not_found");

    const user = ss().users.findOneBy("email", email);
    if (!user) return slackError(c, "users_not_found");

    return slackOk(c, { user: formatUser(user, true) });
  });

  async function profileGet(c: Context) {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["users.profile:read"]);
    if (scopeError) return scopeError;

    const body = await parseSlackRequest(c);
    const requestedUserId = typeof body.user === "string" && body.user ? body.user : getAuthUserId(authUser);
    const user = ss().users.findOneBy("user_id", requestedUserId);
    if (!user || user.deleted) return slackError(c, "user_not_found");

    return slackOk(c, { profile: formatProfile(user.profile, canExposeEmail(c)) });
  }

  async function profileSet(c: Context) {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["users.profile:write"]);
    if (scopeError) return scopeError;

    const body = await parseSlackBody(c);
    const requestedUserId = typeof body.user === "string" && body.user ? body.user : getAuthUserId(authUser);
    const user = ss().users.findOneBy("user_id", requestedUserId);
    if (!user || user.deleted) return slackError(c, "user_not_found");

    const updates = parseProfileUpdates(body);
    if (!updates) return slackError(c, "invalid_arguments");

    const nextProfile = mergeProfile(user.profile, updates);
    const userUpdates: Partial<SlackUser> = { profile: nextProfile };
    if (updates.real_name !== undefined) userUpdates.real_name = nextProfile.real_name;
    if (updates.email !== undefined) userUpdates.email = nextProfile.email;

    const updated = ss().users.update(user.id, userUpdates)!;
    await webhooks.dispatch(
      "user_change",
      undefined,
      {
        type: "event_callback",
        event: {
          type: "user_change",
          user: formatUser(updated),
          cache_ts: Number(generateTs().replace(".", "")),
        },
      },
      "slack",
    );

    return slackOk(c, { profile: formatProfile(updated.profile, canExposeEmail(c)) });
  }

  async function getPresence(c: Context) {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["users:read"]);
    if (scopeError) return scopeError;

    const body = await parseSlackRequest(c);
    const authUserId = getAuthUserId(authUser);
    const requestedUserId = typeof body.user === "string" && body.user ? body.user : authUserId;
    const user = ss().users.findOneBy("user_id", requestedUserId);
    if (!user || user.deleted) return slackError(c, "user_not_found");

    const presence = user.presence ?? "active";
    if (requestedUserId !== authUserId) {
      return slackOk(c, { presence });
    }

    const manualPresence = user.manual_presence ?? (presence === "away" ? "away" : "auto");
    return slackOk(c, {
      presence,
      online: presence === "active",
      auto_away: false,
      manual_away: manualPresence === "away",
      connection_count: user.connection_count ?? (presence === "active" ? 1 : 0),
      ...(user.last_activity ? { last_activity: user.last_activity } : {}),
    });
  }

  async function setPresence(c: Context) {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["users:write"]);
    if (scopeError) return scopeError;

    const body = await parseSlackBody(c);
    const presence = typeof body.presence === "string" ? body.presence : "";
    if (presence !== "auto" && presence !== "away") return slackError(c, "invalid_presence");

    const authUserId = getAuthUserId(authUser);
    const user = ss().users.findOneBy("user_id", authUserId);
    if (!user || user.deleted) return slackError(c, "user_not_found");

    const now = Math.floor(Date.now() / 1000);
    const nextPresence: SlackPresence = presence === "away" ? "away" : "active";
    const manualPresence: SlackManualPresence = presence === "away" ? "away" : "auto";
    const updated = ss().users.update(user.id, {
      presence: nextPresence,
      manual_presence: manualPresence,
      connection_count: nextPresence === "active" ? 1 : 0,
      last_activity: nextPresence === "active" ? now : user.last_activity,
    })!;

    await webhooks.dispatch(
      "presence_change",
      undefined,
      {
        type: "event_callback",
        event: {
          type: "presence_change",
          user: updated.user_id,
          presence: nextPresence,
        },
      },
      "slack",
    );

    return slackOk(c, {});
  }

  function canExposeEmail(c: Context): boolean {
    return !isSlackStrictScopes(store) || hasSlackScope(c, "users:read.email");
  }

  app.get("/api/users.profile.get", profileGet);
  app.post("/api/users.profile.get", profileGet);
  onGetOrPost(app, "/api/users.profile.set", profileSet);
  app.get("/api/users.getPresence", getPresence);
  app.post("/api/users.getPresence", getPresence);
  onGetOrPost(app, "/api/users.setPresence", setPresence);
}

function formatUser(u: SlackUser, includeEmail = true) {
  const profile = formatProfile(u.profile, includeEmail);
  return {
    id: u.user_id,
    team_id: u.team_id,
    name: u.name,
    real_name: u.real_name,
    is_admin: u.is_admin,
    is_bot: u.is_bot,
    deleted: u.deleted,
    profile,
  };
}

function formatProfile(profile: SlackUserProfile, includeEmail = true) {
  const formatted = normalizeProfile(profile);
  return includeEmail ? formatted : omitEmail(formatted);
}

function normalizeProfile(profile: SlackUserProfile): SlackUserProfile {
  return {
    title: "",
    phone: "",
    skype: "",
    ...profile,
    real_name_normalized: profile.real_name_normalized ?? profile.real_name,
    display_name_normalized: profile.display_name_normalized ?? profile.display_name,
    status_text: profile.status_text ?? "",
    status_emoji: profile.status_emoji ?? "",
    status_emoji_display_info: profile.status_emoji_display_info ?? [],
    status_expiration: profile.status_expiration ?? 0,
    huddle_state: profile.huddle_state ?? "default_unset",
    huddle_state_expiration_ts: profile.huddle_state_expiration_ts ?? 0,
  };
}

function omitEmail(profile: SlackUserProfile): Omit<SlackUserProfile, "email"> {
  const { email: _email, ...rest } = profile;
  return rest;
}

async function parseSlackRequest(c: Context): Promise<Record<string, unknown>> {
  if (c.req.method === "GET") {
    return Object.fromEntries(new URL(c.req.url).searchParams.entries());
  }
  return parseSlackBody(c);
}

function parseProfileUpdates(body: Record<string, unknown>): Partial<SlackUserProfile> | undefined {
  const profile = parseProfileObject(body.profile);
  if (profile) return profile;

  const name = typeof body.name === "string" ? body.name : "";
  if (!name) return undefined;
  if (!Object.prototype.hasOwnProperty.call(body, "value")) return undefined;
  return { [name]: String(body.value ?? "") } as Partial<SlackUserProfile>;
}

function parseProfileObject(value: unknown): Partial<SlackUserProfile> | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isProfileObject(parsed) ? (parsed as Partial<SlackUserProfile>) : undefined;
    } catch {
      return undefined;
    }
  }
  return isProfileObject(value) ? (value as Partial<SlackUserProfile>) : undefined;
}

function isProfileObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeProfile(profile: SlackUserProfile, updates: Partial<SlackUserProfile>): SlackUserProfile {
  const next: SlackUserProfile = normalizeProfile({ ...profile, ...updates });

  if (updates.real_name !== undefined) {
    next.real_name = String(updates.real_name);
    next.real_name_normalized = next.real_name;
    const [firstName = "", ...rest] = next.real_name.trim().split(/\s+/);
    next.first_name = firstName;
    next.last_name = rest.join(" ");
  }
  if (updates.display_name !== undefined) {
    next.display_name = String(updates.display_name);
    next.display_name_normalized = next.display_name;
  }
  if (updates.email !== undefined) {
    next.email = String(updates.email);
  }
  if (updates.fields !== undefined) {
    next.fields = updates.fields;
  }

  return next;
}
