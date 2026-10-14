import type { Context, RouteContext } from "@emulators/core";
import type { SlackUsergroup } from "../entities.js";
import { getSlackStore } from "../store.js";
import { generateSlackId, parseSlackBody, requireSlackScopes, slackError, slackOk } from "../helpers.js";

// Slack's mention handles are lowercase letters, digits, periods, hyphens and underscores.
const HANDLE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function usergroupsRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ss = () => getSlackStore(store);
  const getAuthUserId = (authUser: { login: string }) =>
    (ss().users.findOneBy("user_id", authUser.login) ?? ss().users.findOneBy("name", authUser.login))?.user_id ??
    authUser.login;

  app.post("/api/usergroups.list", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["usergroups:read"]);
    if (scopeError) return scopeError;

    const body = await parseSlackBody(c);
    const includeDisabled = booleanField(body.include_disabled);
    const options = { includeCount: booleanField(body.include_count), includeUsers: booleanField(body.include_users) };
    const usergroups = ss()
      .usergroups.all()
      .filter((group) => includeDisabled || group.date_delete === 0)
      .map((group) => formatUsergroup(group, options));

    return slackOk(c, { usergroups });
  });

  app.post("/api/usergroups.create", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["usergroups:write"]);
    if (scopeError) return scopeError;

    const body = await parseSlackBody(c);
    const name = stringField(body.name).trim();
    if (!name) return slackError(c, "missing_subteam_name");
    if (nameTaken(name)) return slackError(c, "name_already_exists");

    const handle = stringField(body.handle).trim();
    if (handle) {
      const handleError = checkHandle(handle);
      if (handleError) return slackError(c, handleError);
    }

    const channels = listField(body.channels);
    if (!channels.every(channelExists)) return slackError(c, "invalid_channel_provided");

    const now = Math.floor(Date.now() / 1000);
    const authUserId = getAuthUserId(authUser);
    const team = ss().teams.all()[0];
    const group = ss().usergroups.insert({
      usergroup_id: generateSlackId("S"),
      team_id: team?.team_id ?? "T000000001",
      name,
      handle,
      description: stringField(body.description),
      channels,
      users: [],
      date_create: now,
      date_update: now,
      date_delete: 0,
      created_by: authUserId,
      updated_by: authUserId,
      deleted_by: null,
    });

    return usergroupResponse(c, group, body);
  });

  app.post("/api/usergroups.update", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["usergroups:write"]);
    if (scopeError) return scopeError;

    const body = await parseSlackBody(c);
    const group = findUsergroup(body.usergroup);
    if (!group) return slackError(c, "no_such_subteam");

    const updates: Partial<SlackUsergroup> = {};
    const name = stringField(body.name).trim();
    if (name && name !== group.name) {
      if (nameTaken(name, group)) return slackError(c, "name_already_exists");
      updates.name = name;
    }
    const handle = stringField(body.handle).trim();
    if (handle && handle !== group.handle) {
      const handleError = checkHandle(handle, group);
      if (handleError) return slackError(c, handleError);
      updates.handle = handle;
    }
    if (Object.prototype.hasOwnProperty.call(body, "description")) {
      updates.description = stringField(body.description);
    }
    if (Object.prototype.hasOwnProperty.call(body, "channels")) {
      const channels = listField(body.channels);
      if (!channels.every(channelExists)) return slackError(c, "invalid_channel_provided");
      updates.channels = channels;
    }

    return usergroupResponse(c, touch(group, authUser, updates), body);
  });

  app.post("/api/usergroups.disable", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["usergroups:write"]);
    if (scopeError) return scopeError;

    const body = await parseSlackBody(c);
    const group = findUsergroup(body.usergroup);
    if (!group) return slackError(c, "no_such_subteam");

    const now = Math.floor(Date.now() / 1000);
    const updated = touch(group, authUser, { date_delete: now, deleted_by: getAuthUserId(authUser) }, now);
    return usergroupResponse(c, updated, body);
  });

  app.post("/api/usergroups.enable", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["usergroups:write"]);
    if (scopeError) return scopeError;

    const body = await parseSlackBody(c);
    const group = findUsergroup(body.usergroup);
    if (!group) return slackError(c, "no_such_subteam");

    return usergroupResponse(c, touch(group, authUser, { date_delete: 0, deleted_by: null }), body);
  });

  app.post("/api/usergroups.users.list", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["usergroups:read"]);
    if (scopeError) return scopeError;

    const body = await parseSlackBody(c);
    const group = findUsergroup(body.usergroup);
    if (!group || (group.date_delete !== 0 && !booleanField(body.include_disabled))) {
      return slackError(c, "no_such_subteam");
    }

    return slackOk(c, { users: [...group.users] });
  });

  app.post("/api/usergroups.users.update", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["usergroups:write"]);
    if (scopeError) return scopeError;

    const body = await parseSlackBody(c);
    const group = findUsergroup(body.usergroup);
    if (!group) return slackError(c, "no_such_subteam");

    const users = listField(body.users);
    if (users.length === 0) return slackError(c, "no_users_provided");
    const resolved = users.map(resolveActiveUserId);
    if (resolved.some((userId) => userId === undefined)) return slackError(c, "invalid_users");

    return usergroupResponse(c, touch(group, authUser, { users: [...new Set(resolved as string[])] }), body);
  });

  function usergroupResponse(c: Context, group: SlackUsergroup, body: Record<string, unknown>) {
    return slackOk(c, {
      usergroup: formatUsergroup(group, { includeCount: booleanField(body.include_count), includeUsers: true }),
    });
  }

  function touch(
    group: SlackUsergroup,
    authUser: { login: string },
    updates: Partial<SlackUsergroup>,
    now = Math.floor(Date.now() / 1000),
  ): SlackUsergroup {
    return ss().usergroups.update(group.id, { ...updates, date_update: now, updated_by: getAuthUserId(authUser) })!;
  }

  function findUsergroup(value: unknown): SlackUsergroup | undefined {
    const id = stringField(value);
    return id ? ss().usergroups.findOneBy("usergroup_id", id) : undefined;
  }

  function nameTaken(name: string, except?: SlackUsergroup): boolean {
    const wanted = name.toLowerCase();
    return ss()
      .usergroups.all()
      .some((group) => group.id !== except?.id && group.name.toLowerCase() === wanted);
  }

  // A handle is an @mention, so it must not collide with another group, a member or a channel.
  function checkHandle(handle: string, except?: SlackUsergroup): string | null {
    if (!HANDLE_PATTERN.test(handle)) return "bad_handle";
    const taken =
      ss()
        .usergroups.all()
        .some((group) => group.id !== except?.id && group.handle === handle) ||
      ss()
        .users.all()
        .some((user) => !user.deleted && user.name === handle) ||
      ss().channels.findOneBy("name", handle) !== undefined;
    return taken ? "handle_already_exists" : null;
  }

  function channelExists(channelId: string): boolean {
    return ss().channels.findOneBy("channel_id", channelId) !== undefined;
  }

  function resolveActiveUserId(userId: string): string | undefined {
    const user = ss().users.findOneBy("user_id", userId);
    return user && !user.deleted ? user.user_id : undefined;
  }
}

export function formatUsergroup(
  group: SlackUsergroup,
  { includeCount, includeUsers }: { includeCount: boolean; includeUsers: boolean },
) {
  return {
    id: group.usergroup_id,
    team_id: group.team_id,
    is_usergroup: true,
    name: group.name,
    description: group.description,
    handle: group.handle,
    is_external: false,
    date_create: group.date_create,
    date_update: group.date_update,
    date_delete: group.date_delete,
    auto_type: null,
    created_by: group.created_by,
    updated_by: group.updated_by,
    deleted_by: group.deleted_by,
    prefs: { channels: [...group.channels], groups: [] },
    ...(includeUsers ? { users: [...group.users] } : {}),
    ...(includeCount ? { user_count: group.users.length } : {}),
  };
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function booleanField(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value !== "string") return false;
  const normalized = value.toLowerCase();
  return normalized === "true" || normalized === "1";
}

function listField(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(items.map((item) => String(item).trim()).filter(Boolean))];
}
