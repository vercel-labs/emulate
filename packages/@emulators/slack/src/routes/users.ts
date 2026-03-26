import type { RouteContext } from "@emulators/core";
import { getSlackStore } from "../store.js";
import { slackOk, slackError, parseSlackBody } from "../helpers.js";
import type { SlackUser } from "../entities.js";

export function usersRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ss = () => getSlackStore(store);

  // users.list
  app.post("/api/users.list", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const limit = Math.min(Number(body.limit) || 100, 1000);
    const cursor = typeof body.cursor === "string" ? body.cursor : "";

    const allUsers = ss().users.all().filter((u) => !u.deleted);

    let startIndex = 0;
    if (cursor) {
      const idx = allUsers.findIndex((u) => u.user_id === cursor);
      if (idx >= 0) startIndex = idx;
    }

    const page = allUsers.slice(startIndex, startIndex + limit);
    const nextCursor = startIndex + limit < allUsers.length
      ? allUsers[startIndex + limit].user_id
      : "";

    return slackOk(c, {
      members: page.map(formatUser),
      response_metadata: { next_cursor: nextCursor },
    });
  });

  // users.info
  app.post("/api/users.info", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const userId = typeof body.user === "string" ? body.user : "";

    const user = ss().users.findOneBy("user_id", userId);
    if (!user) return slackError(c, "user_not_found");

    return slackOk(c, { user: formatUser(user) });
  });

  // users.lookupByEmail
  app.post("/api/users.lookupByEmail", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const email = typeof body.email === "string" ? body.email : "";

    if (!email) return slackError(c, "users_not_found");

    const user = ss().users.findOneBy("email", email);
    if (!user) return slackError(c, "users_not_found");

    return slackOk(c, { user: formatUser(user) });
  });
}

function formatUser(u: SlackUser) {
  return {
    id: u.user_id,
    team_id: u.team_id,
    name: u.name,
    real_name: u.real_name,
    is_admin: u.is_admin,
    is_bot: u.is_bot,
    deleted: u.deleted,
    profile: u.profile,
  };
}
