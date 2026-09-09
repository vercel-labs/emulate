import { api, badRequest, emailValid, first, notFound, parseBody, route } from "../helpers.js";
import { accountId } from "../store.js";
import type { MailgunRouteContext } from "../route-utils.js";

export function miscRoutes(rc: MailgunRouteContext): void {
  const { app, ms } = rc;
  const sandboxes = () => ms.domains.all().filter((domain) => domain.type === "sandbox");

  route(
    app,
    "get",
    "/v3/ips",
    api(ms, (c) => c.json({ items: ["127.0.0.1"], total_count: 1 })),
  );

  route(
    app,
    "get",
    "/v3/ips/:ip",
    api(ms, (c) => {
      const ip = c.req.param("ip");
      if (ip !== "127.0.0.1") throw notFound("IP not found");
      return c.json({ ip, dedicated: true, rdns: "mail.emulate.local" });
    }),
  );

  route(
    app,
    "get",
    "/v5/sandbox/auth_recipients",
    api(ms, (c) => {
      const recipients = [...new Set(sandboxes().flatMap((domain) => domain.authorized_recipients))].sort();
      return c.json({ recipients: recipients.map((email) => ({ email, activated: true })) });
    }),
  );

  route(
    app,
    "post",
    "/v5/sandbox/auth_recipients",
    api(ms, async (c) => {
      const body = await parseBody(c);
      const email = (c.req.query("email") ?? first(body, "email"))?.trim().toLowerCase();
      if (!email || !emailValid(email)) throw badRequest("'email' parameter is missing or invalid");
      const targets = sandboxes();
      if (targets.length === 0) throw badRequest("No sandbox domain is configured");
      for (const domain of targets) {
        if (domain.authorized_recipients.length >= 5 && !domain.authorized_recipients.includes(email))
          throw badRequest("Sandbox domains allow at most 5 authorized recipients");
        if (!domain.authorized_recipients.includes(email))
          ms.domains.update(domain.id, { authorized_recipients: [...domain.authorized_recipients, email] });
      }
      return c.json({ recipient: { email, activated: true } });
    }),
  );

  route(
    app,
    "delete",
    "/v5/sandbox/auth_recipients/:email",
    api(ms, (c) => {
      const email = decodeURIComponent(c.req.param("email")).toLowerCase();
      let removed = false;
      for (const domain of sandboxes()) {
        if (!domain.authorized_recipients.includes(email)) continue;
        ms.domains.update(domain.id, {
          authorized_recipients: domain.authorized_recipients.filter((item) => item !== email),
        });
        removed = true;
      }
      if (!removed) throw notFound("Authorized recipient not found");
      return c.json({ message: "Authorized recipient deleted" });
    }),
  );

  route(
    app,
    "get",
    "/v5/accounts",
    api(ms, (c) =>
      c.json({
        id: accountId(ms),
        name: "Emulate Account",
        plan: "emulate",
        status: "active",
        region: "us",
        domains_count: ms.domains.count(),
        created_at: ms.domains.all()[0]?.created_at ?? new Date().toISOString(),
      }),
    ),
  );

  route(
    app,
    "get",
    "/v3/domains/:domain/limits/tag",
    api(
      ms,
      (c) => {
        const domain = ms.domains.findOneBy("name", c.req.param("domain").toLowerCase());
        if (!domain) throw notFound(`Domain not found: ${c.req.param("domain")}`);
        return c.json({ limit: 4000, count: ms.tags.findBy("domain", domain.name).length });
      },
      "domain",
    ),
  );
}
