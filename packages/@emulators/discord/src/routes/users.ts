import type { Context } from "hono";
import type { RouteContext } from "@emulators/core";
import { getDiscordStore } from "../store.js";
import { formatUser, getAuthedUser, requireDiscordAuth } from "../helpers.js";

export function usersRoutes(ctx: RouteContext): void {
  const { app } = ctx;

  app.use("/api/v10/users/*", requireDiscordAuth(ctx));
  app.use("/api/users/*", requireDiscordAuth(ctx));

  const handler = (c: Context) => {
    const user = getAuthedUser(c, ctx) ?? getDiscordStore(ctx.store).users.all()[0];
    if (!user) return c.json({ message: "401: Unauthorized", code: 0 }, 401);
    return c.json(formatUser(user));
  };

  app.get("/api/v10/users/@me", handler);
  app.get("/api/users/@me", handler);
}
