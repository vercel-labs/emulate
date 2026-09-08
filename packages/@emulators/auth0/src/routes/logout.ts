import type { RouteContext } from "@emulators/core";
import { parseCookies } from "@emulators/core";

export function logoutRoutes({ app }: RouteContext): void {
  app.get("/v2/logout", (c) => {
    const returnTo = c.req.query("returnTo");
    const cookies = parseCookies(c.req.header("Cookie") ?? "");
    for (const name of Object.keys(cookies)) {
      if (name.startsWith("auth0") || name === "sid") {
        c.header("Set-Cookie", `${name}=; Path=/; Max-Age=0; HttpOnly`, { append: true });
      }
    }
    c.header("Set-Cookie", "auth0_session=; Path=/; Max-Age=0; HttpOnly", { append: true });
    if (returnTo) return c.redirect(returnTo, 302);
    return c.json({ ok: true });
  });
}
