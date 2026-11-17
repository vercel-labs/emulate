import type { RouteContext } from "@emulators/core";
import { getSlackStore } from "../store.js";
import { parseSlackBody, parseSlackBoolean, slackOk, slackError } from "../helpers.js";
import { invalidateSlackToken, isSlackTokenInvalidated, isSlackTokenRevoked, slackRequestToken } from "../tokens.js";

export function authRoutes(ctx: RouteContext): void {
  const { app, store, tokenMap } = ctx;
  const ss = () => getSlackStore(store);

  // auth.test - verify token, return user/team info
  app.post("/api/auth.test", (c) => {
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

  // auth.revoke - revoke the calling token
  app.post("/api/auth.revoke", async (c) => {
    const body = await parseSlackBody(c);
    const token = slackRequestToken(c) ?? (typeof body.token === "string" ? body.token.trim() : "");
    if (!token) return slackError(c, "not_authed");
    if (isSlackTokenRevoked(store, token)) return slackError(c, "token_revoked");
    if (isSlackTokenInvalidated(store, token)) return slackError(c, "invalid_auth");

    const record = ss().tokens.findOneBy("token", token);
    if (!record && !tokenMap?.has(token)) return slackError(c, "invalid_auth");

    if (parseSlackBoolean(body.test) === true) return slackOk(c, { revoked: false });

    invalidateSlackToken(store, token, tokenMap);
    return slackOk(c, { revoked: true });
  });
}
