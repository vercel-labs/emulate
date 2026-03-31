import type { RouteContext } from "@emulators/core";
import { getSlackStore } from "../store.js";
import { slackOk, slackError, parseSlackBody } from "../helpers.js";

export function teamRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ss = () => getSlackStore(store);

  // team.info
  app.post("/api/team.info", (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const team = ss().teams.all()[0];
    if (!team) return slackError(c, "team_not_found");

    return slackOk(c, {
      team: {
        id: team.team_id,
        name: team.name,
        domain: team.domain,
      },
    });
  });

  // bots.info
  app.post("/api/bots.info", async (c) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");

    const body = await parseSlackBody(c);
    const botId = typeof body.bot === "string" ? body.bot : "";

    const bot = ss().bots.findOneBy("bot_id", botId);
    if (!bot) return slackError(c, "bot_not_found");

    return slackOk(c, {
      bot: {
        id: bot.bot_id,
        name: bot.name,
        deleted: bot.deleted,
        icons: bot.icons,
      },
    });
  });
}
