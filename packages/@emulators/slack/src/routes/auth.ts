import type { RouteContext } from "@emulators/core";
import { getSlackStore } from "../store.js";
import { slackOk, slackError } from "../helpers.js";

export function authRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ss = () => getSlackStore(store);

  // auth.test - verify token, return user/team info
  app.post("/api/auth.test", (c) => {
    const authUser = c.get("authUser");
    if (!authUser) {
      return slackError(c, "not_authed");
    }

    // Look up by user_id first, then fall back to name (for token-based auth
    // where the token login may be the username rather than the user_id)
    const user = ss().users.findOneBy("user_id", authUser.login)
      ?? ss().users.all().find((u) => u.name === authUser.login);
    if (!user) {
      return slackError(c, "invalid_auth");
    }

    const team = ss().teams.all()[0];
    return slackOk(c, {
      url: `https://${team?.domain ?? "emulate"}.slack.com/`,
      team: team?.name ?? "Emulate",
      user: user.name,
      team_id: team?.team_id ?? "T000000001",
      user_id: user.user_id,
      bot_id: user.is_bot ? user.user_id : undefined,
    });
  });
}
