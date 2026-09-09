import type { MailgunDomain } from "../entities.js";
import { formatCredential, formatDomain, formatDomainResponse } from "../formatters.js";
import { api, badRequest, first, limitParam, notFound, parseBody, route, skipParam, yesNo } from "../helpers.js";
import { token } from "../ids.js";
import { findDomain, type MailgunRouteContext } from "../route-utils.js";

export function domainRoutes(rc: MailgunRouteContext): void {
  const { app, ms } = rc;

  const list = api(ms, (c, key) => {
    let domains = ms.domains.all();
    if (key.kind === "domain") domains = domains.filter((domain) => domain.name === key.domain);
    const state = c.req.query("state");
    if (state) domains = domains.filter((domain) => domain.state === state);
    const limit = limitParam(c, 100);
    const skip = skipParam(c);
    return c.json({
      items: domains.slice(skip, skip + limit).map((domain) => formatDomain(domain)),
      total_count: domains.length,
    });
  });
  route(app, "get", "/v4/domains", list);
  route(app, "get", "/v3/domains", list);

  const create = api(ms, async (c) => {
    const body = await parseBody(c);
    const name = first(body, "name")?.trim().toLowerCase();
    if (!name) throw badRequest("'name' parameter is missing");
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(name)) throw badRequest("'name' parameter is not a valid domain name");
    if (ms.domains.findOneBy("name", name)) throw badRequest("This domain name is already taken");
    const domain = ms.domains.insert({
      name,
      type: name.endsWith(".mailgun.org") ? "sandbox" : "custom",
      state: yesNo(first(body, "skip_verification"), false) ? "active" : "active",
      smtp_password: first(body, "smtp_password") ?? token(32),
      spam_action: (first(body, "spam_action") as MailgunDomain["spam_action"]) ?? "disabled",
      wildcard: yesNo(first(body, "wildcard"), false),
      web_scheme: (first(body, "web_scheme") as MailgunDomain["web_scheme"]) ?? "http",
      web_prefix: first(body, "web_prefix") ?? "email",
      require_tls: yesNo(first(body, "require_tls"), false),
      skip_verification: yesNo(first(body, "skip_verification"), false),
      is_disabled: false,
      tracking: { open: false, click: false, unsubscribe: false },
      authorized_recipients: [],
      dkim_key_size: Number(first(body, "dkim_key_size") ?? 1024),
    });
    return c.json({ message: "Domain DNS records have been created", ...formatDomainResponse(domain, true) });
  });
  route(app, "post", "/v4/domains", create);
  route(app, "post", "/v3/domains", create);

  const show = api(
    ms,
    (c) => {
      const domain = findDomain(ms, c.req.param("domain"));
      return c.json(formatDomainResponse(domain));
    },
    "domain",
  );
  route(app, "get", "/v4/domains/:domain", show);
  route(app, "get", "/v3/domains/:domain", show);

  const update = api(
    ms,
    async (c) => {
      const domain = findDomain(ms, c.req.param("domain"));
      const body = await parseBody(c);
      const updated = ms.domains.update(domain.id, {
        spam_action: (first(body, "spam_action") as MailgunDomain["spam_action"]) ?? domain.spam_action,
        web_scheme: (first(body, "web_scheme") as MailgunDomain["web_scheme"]) ?? domain.web_scheme,
        web_prefix: first(body, "web_prefix") ?? domain.web_prefix,
        wildcard: yesNo(first(body, "wildcard"), domain.wildcard),
        require_tls: yesNo(first(body, "require_tls"), domain.require_tls),
        skip_verification: yesNo(first(body, "skip_verification"), domain.skip_verification),
        smtp_password: first(body, "smtp_password") ?? domain.smtp_password,
      })!;
      return c.json({ message: "Domain has been updated", ...formatDomainResponse(updated) });
    },
    "domain",
  );
  route(app, "put", "/v4/domains/:domain", update);
  route(app, "put", "/v3/domains/:domain", update);

  const destroy = api(ms, (c) => {
    const domain = findDomain(ms, c.req.param("domain"));
    ms.domains.delete(domain.id);
    for (const webhook of ms.webhooks.findBy("domain", domain.name)) ms.webhooks.delete(webhook.id);
    for (const suppression of ms.suppressions.findBy("domain", domain.name)) ms.suppressions.delete(suppression.id);
    return c.json({ message: "Domain has been deleted" });
  });
  route(app, "delete", "/v4/domains/:domain", destroy);
  route(app, "delete", "/v3/domains/:domain", destroy);

  route(
    app,
    "put",
    "/v4/domains/:domain/verify",
    api(
      ms,
      (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        const updated = ms.domains.update(domain.id, { state: "active" })!;
        return c.json({ message: "Domain DNS records have been updated", ...formatDomainResponse(updated) });
      },
      "domain",
    ),
  );

  route(
    app,
    "get",
    "/v3/domains/:domain/connection",
    api(
      ms,
      (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        return c.json({ connection: { require_tls: domain.require_tls, skip_verification: domain.skip_verification } });
      },
      "domain",
    ),
  );

  route(
    app,
    "put",
    "/v3/domains/:domain/connection",
    api(
      ms,
      async (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        const body = await parseBody(c);
        const updated = ms.domains.update(domain.id, {
          require_tls: yesNo(first(body, "require_tls"), domain.require_tls),
          skip_verification: yesNo(first(body, "skip_verification"), domain.skip_verification),
        })!;
        return c.json({
          message: "Domain connection settings have been updated, may take 10 minutes to fully propagate",
          require_tls: updated.require_tls,
          skip_verification: updated.skip_verification,
        });
      },
      "domain",
    ),
  );

  route(
    app,
    "get",
    "/v3/domains/:domain/tracking",
    api(
      ms,
      (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        return c.json({
          tracking: {
            open: { active: domain.tracking.open },
            click: { active: domain.tracking.click },
            unsubscribe: { active: domain.tracking.unsubscribe, html_footer: "", text_footer: "" },
          },
        });
      },
      "domain",
    ),
  );

  route(
    app,
    "put",
    "/v3/domains/:domain/tracking/:type",
    api(
      ms,
      async (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        const type = c.req.param("type");
        if (type !== "open" && type !== "click" && type !== "unsubscribe")
          throw notFound(`Tracking type not found: ${type}`);
        const body = await parseBody(c);
        const activeRaw = first(body, "active");
        const active = activeRaw === "htmlonly" ? true : yesNo(activeRaw, domain.tracking[type]);
        const updated = ms.domains.update(domain.id, { tracking: { ...domain.tracking, [type]: active } })!;
        return c.json({
          message: "Domain tracking settings have been updated",
          [type]: { active: updated.tracking[type] },
        });
      },
      "domain",
    ),
  );

  route(
    app,
    "get",
    "/v3/domains/:domain/credentials",
    api(
      ms,
      (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        const items = ms.credentials.findBy("domain", domain.name);
        const limit = limitParam(c, 100);
        const skip = skipParam(c);
        return c.json({ items: items.slice(skip, skip + limit).map(formatCredential), total_count: items.length });
      },
      "domain",
    ),
  );

  route(
    app,
    "post",
    "/v3/domains/:domain/credentials",
    api(
      ms,
      async (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        const body = await parseBody(c);
        const rawLogin = first(body, "login");
        const password = first(body, "password");
        if (!rawLogin) throw badRequest("'login' parameter is missing");
        if (!password || password.length < 5 || password.length > 32)
          throw badRequest("'password' parameter must be between 5 and 32 characters");
        const login = rawLogin.includes("@") ? rawLogin.toLowerCase() : `${rawLogin.toLowerCase()}@${domain.name}`;
        if (ms.credentials.findBy("domain", domain.name).some((credential) => credential.login === login))
          throw badRequest("Credentials already exist");
        ms.credentials.insert({ domain: domain.name, login, password });
        return c.json({ message: "Created 1 credentials pair(s)" });
      },
      "domain",
    ),
  );

  route(
    app,
    "put",
    "/v3/domains/:domain/credentials/:login",
    api(
      ms,
      async (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        const login = decodeURIComponent(c.req.param("login")).toLowerCase();
        const credential = ms.credentials
          .findBy("domain", domain.name)
          .find((candidate) => candidate.login === login || candidate.login === `${login}@${domain.name}`);
        if (!credential) throw notFound("Credentials not found");
        const body = await parseBody(c);
        const password = first(body, "password");
        if (!password) throw badRequest("'password' parameter is missing");
        ms.credentials.update(credential.id, { password });
        return c.json({ message: "Password changed" });
      },
      "domain",
    ),
  );

  route(
    app,
    "delete",
    "/v3/domains/:domain/credentials/:login",
    api(
      ms,
      (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        const login = decodeURIComponent(c.req.param("login")).toLowerCase();
        const credential = ms.credentials
          .findBy("domain", domain.name)
          .find((candidate) => candidate.login === login || candidate.login === `${login}@${domain.name}`);
        if (!credential) throw notFound("Credentials not found");
        ms.credentials.delete(credential.id);
        return c.json({ message: "Domain credential has been deleted", spec: credential.login });
      },
      "domain",
    ),
  );

  route(
    app,
    "get",
    "/v3/domains/:domain/sending_queues",
    api(
      ms,
      (c) => {
        findDomain(ms, c.req.param("domain"));
        return c.json({
          regular: { is_disabled: false, disabled: { until: "", reason: "" } },
          scheduled: { is_disabled: false, disabled: { until: "", reason: "" } },
        });
      },
      "domain",
    ),
  );

  route(
    app,
    "get",
    "/v3/domains/:domain/ips",
    api(
      ms,
      (c) => {
        findDomain(ms, c.req.param("domain"));
        return c.json({ items: ["127.0.0.1"], total_count: 1 });
      },
      "domain",
    ),
  );
}
