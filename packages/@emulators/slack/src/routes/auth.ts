import type { RouteContext } from "@emulators/core";
import { getSlackStore } from "../store.js";
import { parseSlackBody, slackOk, slackError, onGetOrPost } from "../helpers.js";

export function authRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ss = () => getSlackStore(store);

  // api.test - no auth; echoes the arguments back, the way Slack's ping does
  onGetOrPost(app, "/api/api.test", async (c) => {
    const args = await parseSlackBody(c);
    if (typeof args.error === "string" && args.error) {
      return slackError(c, args.error);
    }
    return slackOk(c, { args });
  });

  // auth.test - verify token, return user/team info
  onGetOrPost(app, "/api/auth.test", (c) => {
    const authUser = c.get("authUser");
    if (!authUser) {
      return slackError(c, "not_authed");
    }

    // Look up by user_id first, then fall back to name (for token-based auth
    // where the token login may be the username rather than the user_id)
    const user =
      ss().users.findOneBy("user_id", authUser.login) ??
      ss()
        .users.all()
        .find((u) => u.name === authUser.login);
    if (!user) {
      return slackError(c, "invalid_auth");
    }

    const team = ss().teams.all()[0];
    const token = c.get("authToken");
    const tokenRecord = token ? ss().tokens.findOneBy("token", token) : undefined;
    const bot =
      (tokenRecord?.bot_id ? ss().bots.findOneBy("bot_id", tokenRecord.bot_id) : undefined) ??
      (user.is_bot
        ? ss()
            .bots.all()
            .find((item) => item.user_id === user.user_id)
        : undefined);
    const installation = tokenRecord?.installation_id
      ? ss().installations.findOneBy("installation_id", tokenRecord.installation_id)
      : undefined;

    return slackOk(c, {
      url: `https://${team?.domain ?? "emulate"}.slack.com/`,
      team: team?.name ?? "Emulate",
      user: user.name,
      team_id: team?.team_id ?? "T000000001",
      user_id: user.user_id,
      bot_id: bot?.bot_id,
      app_id: tokenRecord?.app_id,
      app_name: installation?.app_name,
    });
  });
}
