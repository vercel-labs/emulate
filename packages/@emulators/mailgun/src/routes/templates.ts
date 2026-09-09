import type { MailgunTemplate, MailgunTemplateVersion } from "../entities.js";
import { formatTemplate, formatTemplateVersion } from "../formatters.js";
import { api, badRequest, first, notFound, pagedItems, parseBody, parseJson, route, yesNo } from "../helpers.js";
import { templateVersionId } from "../ids.js";
import { findDomain, type MailgunRouteContext } from "../route-utils.js";

export function templateRoutes(rc: MailgunRouteContext): void {
  const { app, ms, fmt } = rc;

  const templatesOf = (domain: string) =>
    [...ms.templates.findBy("domain", domain)].sort((a, b) => a.name.localeCompare(b.name));
  const versionsOf = (template: MailgunTemplate) =>
    ms.templateVersions
      .findBy("domain", template.domain)
      .filter((version) => version.template_name === template.name)
      .sort((a, b) => a.id - b.id);
  const activeVersion = (template: MailgunTemplate) => versionsOf(template).find((version) => version.active) ?? null;

  function findTemplate(domain: string, name: string): MailgunTemplate {
    const template = templatesOf(domain).find((candidate) => candidate.name === decodeURIComponent(name).toLowerCase());
    if (!template) throw notFound("template not found");
    return template;
  }

  function findVersion(template: MailgunTemplate, tag: string): MailgunTemplateVersion {
    const version = versionsOf(template).find((candidate) => candidate.tag === decodeURIComponent(tag));
    if (!version) throw notFound("template version not found");
    return version;
  }

  function parseHeaders(raw: string | undefined): Record<string, string> {
    const parsed = raw ? parseJson<Record<string, unknown>>(raw) : undefined;
    return parsed ? Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)])) : {};
  }

  route(
    app,
    "get",
    "/v3/:domain/templates",
    api(
      ms,
      (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        const paged = pagedItems(c, templatesOf(domain.name), {
          anchorKey: "p",
          anchor: (template) => template.name,
          defaultLimit: 10,
        });
        return c.json({
          items: paged.items.map((template) => formatTemplate(fmt, template, null, false)),
          paging: paged.paging,
        });
      },
      "domain",
    ),
  );

  route(
    app,
    "post",
    "/v3/:domain/templates",
    api(
      ms,
      async (c, key) => {
        const domain = findDomain(ms, c.req.param("domain"));
        const body = await parseBody(c);
        const name = first(body, "name")?.trim().toLowerCase();
        if (!name) throw badRequest("'name' parameter is missing");
        if (!/^[a-z0-9._-]+$/.test(name)) throw badRequest("'name' parameter contains invalid characters");
        if (templatesOf(domain.name).some((template) => template.name === name))
          throw badRequest("template already exists");
        const template = ms.templates.insert({
          domain: domain.name,
          name,
          description: first(body, "description") ?? "",
          created_by: key.kind === "domain" ? `api@${domain.name}` : "api",
        });
        const content = first(body, "template");
        let version: MailgunTemplateVersion | null = null;
        if (content !== undefined) {
          const engine = (first(body, "engine") ?? "handlebars") as MailgunTemplateVersion["engine"];
          version = ms.templateVersions.insert({
            domain: domain.name,
            template_name: name,
            version_id: templateVersionId(),
            tag: first(body, "tag") ?? "initial",
            engine,
            comment: first(body, "comment") ?? "",
            active: true,
            content,
            headers: parseHeaders(first(body, "headers")),
          });
        }
        return c.json({ message: "template has been stored", template: formatTemplate(fmt, template, version) });
      },
      "domain",
    ),
  );

  route(
    app,
    "delete",
    "/v3/:domain/templates",
    api(
      ms,
      (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        for (const template of templatesOf(domain.name)) {
          for (const version of versionsOf(template)) ms.templateVersions.delete(version.id);
          ms.templates.delete(template.id);
        }
        return c.json({ message: "templates have been deleted" });
      },
      "domain",
    ),
  );

  route(
    app,
    "get",
    "/v3/:domain/templates/:name",
    api(
      ms,
      (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        const template = findTemplate(domain.name, c.req.param("name"));
        const wantsActive = yesNo(c.req.query("active"), false);
        return c.json({ template: formatTemplate(fmt, template, wantsActive ? activeVersion(template) : null) });
      },
      "domain",
    ),
  );

  route(
    app,
    "put",
    "/v3/:domain/templates/:name",
    api(
      ms,
      async (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        const template = findTemplate(domain.name, c.req.param("name"));
        const body = await parseBody(c);
        const description = first(body, "description");
        if (description === undefined) throw badRequest("'description' parameter is missing");
        ms.templates.update(template.id, { description });
        return c.json({ message: "template has been updated", template: { name: template.name } });
      },
      "domain",
    ),
  );

  route(
    app,
    "delete",
    "/v3/:domain/templates/:name",
    api(
      ms,
      (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        const template = findTemplate(domain.name, c.req.param("name"));
        for (const version of versionsOf(template)) ms.templateVersions.delete(version.id);
        ms.templates.delete(template.id);
        return c.json({ message: "template has been deleted", template: { name: template.name } });
      },
      "domain",
    ),
  );

  route(
    app,
    "get",
    "/v3/:domain/templates/:name/versions",
    api(
      ms,
      (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        const template = findTemplate(domain.name, c.req.param("name"));
        const paged = pagedItems(c, versionsOf(template), {
          anchorKey: "p",
          anchor: (version) => version.tag,
          defaultLimit: 10,
        });
        return c.json({
          template: {
            ...formatTemplate(fmt, template, null, false),
            versions: paged.items.map((version) => formatTemplateVersion(version, false)),
          },
          paging: paged.paging,
        });
      },
      "domain",
    ),
  );

  route(
    app,
    "post",
    "/v3/:domain/templates/:name/versions",
    api(
      ms,
      async (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        const template = findTemplate(domain.name, c.req.param("name"));
        const body = await parseBody(c);
        const content = first(body, "template");
        if (content === undefined) throw badRequest("'template' parameter is missing");
        const tag = first(body, "tag");
        if (!tag) throw badRequest("'tag' parameter is missing");
        if (versionsOf(template).some((version) => version.tag === tag))
          throw badRequest("template version already exists");
        const active = yesNo(first(body, "active"), versionsOf(template).length === 0);
        if (active)
          for (const version of versionsOf(template)) ms.templateVersions.update(version.id, { active: false });
        const version = ms.templateVersions.insert({
          domain: domain.name,
          template_name: template.name,
          version_id: templateVersionId(),
          tag,
          engine: (first(body, "engine") ?? "handlebars") as MailgunTemplateVersion["engine"],
          comment: first(body, "comment") ?? "",
          active,
          content,
          headers: parseHeaders(first(body, "headers")),
        });
        return c.json({
          message: "new version of the template has been stored",
          template: formatTemplate(fmt, template, version, false),
        });
      },
      "domain",
    ),
  );

  route(
    app,
    "get",
    "/v3/:domain/templates/:name/versions/:tag",
    api(
      ms,
      (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        const template = findTemplate(domain.name, c.req.param("name"));
        const version = findVersion(template, c.req.param("tag"));
        return c.json({ template: formatTemplate(fmt, template, version) });
      },
      "domain",
    ),
  );

  route(
    app,
    "put",
    "/v3/:domain/templates/:name/versions/:tag",
    api(
      ms,
      async (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        const template = findTemplate(domain.name, c.req.param("name"));
        const version = findVersion(template, c.req.param("tag"));
        const body = await parseBody(c);
        const active = yesNo(first(body, "active"), version.active);
        if (active && !version.active)
          for (const other of versionsOf(template)) ms.templateVersions.update(other.id, { active: false });
        const updated = ms.templateVersions.update(version.id, {
          content: first(body, "template") ?? version.content,
          comment: first(body, "comment") ?? version.comment,
          active,
          headers: first(body, "headers") !== undefined ? parseHeaders(first(body, "headers")) : version.headers,
        })!;
        return c.json({
          message: "version has been updated",
          template: { name: template.name, version: { tag: updated.tag } },
        });
      },
      "domain",
    ),
  );

  route(
    app,
    "delete",
    "/v3/:domain/templates/:name/versions/:tag",
    api(
      ms,
      (c) => {
        const domain = findDomain(ms, c.req.param("domain"));
        const template = findTemplate(domain.name, c.req.param("name"));
        const version = findVersion(template, c.req.param("tag"));
        ms.templateVersions.delete(version.id);
        return c.json({
          message: "version has been deleted",
          template: { name: template.name, version: { tag: version.tag } },
        });
      },
      "domain",
    ),
  );
}
