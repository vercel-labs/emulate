import type { D360Article, D360ArticleVersion } from "../entities.js";
import { formatArticle, formatArticleVersion } from "../formatters.js";
import {
  api,
  badRequest,
  bool,
  envelope,
  guid,
  markdownToHtml,
  notFound,
  nowIso,
  num,
  parseJsonBody,
  route,
  slugify,
  str,
  strOrNull,
  stringArray,
  uniqueSlug,
} from "../helpers.js";
import { logEvent } from "../store.js";
import { findArticle, findVersion, mainVersion, resolveLanguage, type D360RouteContext } from "../route-utils.js";

export function articleRoutes(rc: D360RouteContext): void {
  const { app, ds, fmt } = rc;

  const articleSlug = (versionId: string, langCode: string, base: string, excludeId?: string) =>
    uniqueSlug(slugify(base), (slug) =>
      ds.articles
        .findBy("project_version_id", versionId)
        .some(
          (candidate) =>
            candidate.language_code === langCode &&
            candidate.slug === slug &&
            candidate.d360_id !== excludeId &&
            !candidate.deleted,
        ),
    );

  const versionsOf = (article: D360Article) =>
    ds.articleVersions
      .findBy("article_id", article.d360_id)
      .filter((version) => version.language_code === article.language_code)
      .sort((a, b) => a.version_number - b.version_number);

  const defaultAuthor = () =>
    ds.teamAccounts.all().find((account) => account.portal_role === "owner")?.d360_id ??
    ds.teamAccounts.all()[0]?.d360_id ??
    "system";

  function resolveContent(
    body: Record<string, unknown>,
    fallbackContent: string,
    fallbackHtml: string,
  ): { content: string; html: string } {
    const content = str(body.content);
    const html = str(body.html_content);
    if (content !== undefined) return { content, html: html ?? markdownToHtml(content) };
    if (html !== undefined) return { content: html.replace(/<[^>]+>/g, ""), html };
    return { content: fallbackContent, html: fallbackHtml };
  }

  function insertVersion(
    article: D360Article,
    versionNumber: number,
    title: string,
    content: string,
    html: string,
    author: string,
  ): D360ArticleVersion {
    return ds.articleVersions.insert({
      article_id: article.d360_id,
      language_code: article.language_code,
      version_number: versionNumber,
      title,
      content,
      html_content: html,
      created_by: author,
      published: false,
      published_at: null,
      publish_message: null,
      status: 0,
    });
  }

  route(
    app,
    "post",
    "/v2/Articles",
    api(ds, async (c) => {
      const body = await parseJsonBody(c);
      const title = str(body.title)?.trim();
      if (!title) throw badRequest("title is required", "validation_error");
      const categoryId = str(body.category_id);
      if (!categoryId) throw badRequest("category_id is required", "validation_error");
      const category = ds.categories.findOneBy("d360_id", categoryId);
      if (!category) throw badRequest("Category not found", "category_not_found");
      const version = body.project_version_id
        ? findVersion(ds, String(body.project_version_id))
        : (ds.projectVersions.findOneBy("d360_id", category.project_version_id) ?? mainVersion(ds));
      if (category.project_version_id !== version.d360_id)
        throw badRequest("Category does not belong to the project version", "category_not_found");
      const langCode = resolveLanguage(ds, version.d360_id, str(body.language_code) ?? str(body.lang_code));
      const author = str(body.user_id) ?? str(body.created_by) ?? defaultAuthor();
      const { content, html } = resolveContent(body, "", "");
      const siblings = ds.articles
        .findBy("category_id", category.d360_id)
        .filter((candidate) => candidate.language_code === langCode && !candidate.deleted);
      const article = ds.articles.insert({
        d360_id: str(body.id) ?? guid(),
        project_version_id: version.d360_id,
        language_code: langCode,
        category_id: category.d360_id,
        title,
        slug: articleSlug(version.d360_id, langCode, str(body.slug) ?? title),
        description: strOrNull(body.description),
        content,
        html_content: html,
        content_type: num(body.content_type) ?? 0,
        order: num(body.order) ?? siblings.length,
        hidden: bool(body.hidden) ?? false,
        exclude_from_search: bool(body.exclude_from_search) ?? false,
        allow_comments: bool(body.allow_comments) ?? true,
        show_table_of_contents: bool(body.show_table_of_contents) ?? true,
        feature_image_url: strOrNull(body.feature_image_url),
        seo_title: strOrNull(body.seo_title),
        tags: stringArray(body.tags) ?? [],
        related_articles: stringArray(body.related_articles) ?? [],
        created_by: author,
        authors: [author],
        latest_version: 1,
        public_version: null,
        status_indicator: 0,
        deleted: false,
        review_reminder_at: null,
      });
      const first = insertVersion(article, 1, title, content, html, author);
      let stored = article;
      if (bool(body.publish) === true) {
        ds.articleVersions.update(first.id, { published: true, published_at: nowIso(), status: 3 });
        stored = ds.articles.update(article.id, { public_version: 1 })!;
      }
      logEvent(ds, "article.created", stored.d360_id, {
        title: stored.title,
        category_id: stored.category_id,
        language_code: langCode,
      });
      return c.json(envelope(formatArticle(fmt, stored, ds.articleVersions.get(first.id)!)));
    }),
  );

  route(
    app,
    "get",
    "/v2/Articles/:id/:lang",
    api(ds, (c) => {
      const { entity, fallback } = findArticle(ds, c.req.param("id"), c.req.param("lang"));
      const forDisplay = bool(c.req.query("isForDisplay")) ?? false;
      const versions = versionsOf(entity);
      const version =
        forDisplay && entity.public_version !== null
          ? versions.find((candidate) => candidate.version_number === entity.public_version)
          : versions[versions.length - 1];
      if (forDisplay && entity.public_version === null)
        throw notFound("Article is not published", "article_not_published");
      return c.json(envelope(formatArticle(fmt, entity, version ?? null, fallback)));
    }),
  );

  route(
    app,
    "put",
    "/v2/Articles/:id/:lang",
    api(ds, async (c) => {
      const { entity } = findArticle(ds, c.req.param("id"), undefined);
      const langCode = resolveLanguage(ds, entity.project_version_id, c.req.param("lang"));
      const body = await parseJsonBody(c);
      let target = ds.articles
        .findBy("d360_id", entity.d360_id)
        .find((candidate) => candidate.language_code === langCode && !candidate.deleted);
      const author = str(body.user_id) ?? entity.created_by;
      if (!target) {
        const { id: _id, created_at: _c, updated_at: _u, ...rest } = entity;
        target = ds.articles.insert({
          ...rest,
          language_code: langCode,
          latest_version: 1,
          public_version: null,
          authors: [author],
        });
        insertVersion(target, 1, target.title, target.content, target.html_content, author);
      }
      if (body.category_id !== undefined) {
        const category = ds.categories.findOneBy("d360_id", String(body.category_id));
        if (!category || category.project_version_id !== target.project_version_id)
          throw badRequest("Category not found", "category_not_found");
      }
      const title = body.title !== undefined ? (str(body.title)?.trim() ?? "") : target.title;
      if (!title) throw badRequest("title cannot be empty", "validation_error");
      const versions = versionsOf(target);
      const latest = versions[versions.length - 1];
      const { content, html } = resolveContent(
        body,
        latest?.content ?? target.content,
        latest?.html_content ?? target.html_content,
      );
      let latestVersion = target.latest_version;
      if (latest && latest.published) {
        latestVersion = target.latest_version + 1;
        insertVersion(target, latestVersion, title, content, html, author);
      } else if (latest) {
        ds.articleVersions.update(latest.id, { title, content, html_content: html });
      } else {
        insertVersion(target, 1, title, content, html, author);
        latestVersion = 1;
      }
      const updated = ds.articles.update(target.id, {
        title,
        content,
        html_content: html,
        category_id: body.category_id !== undefined ? String(body.category_id) : target.category_id,
        hidden: bool(body.hidden) ?? target.hidden,
        order: num(body.order) ?? target.order,
        slug:
          body.slug !== undefined
            ? articleSlug(target.project_version_id, langCode, String(body.slug), target.d360_id)
            : target.slug,
        description: body.description !== undefined ? strOrNull(body.description) : target.description,
        exclude_from_search: bool(body.exclude_from_search) ?? target.exclude_from_search,
        tags: stringArray(body.tags) ?? target.tags,
        related_articles: stringArray(body.related_articles) ?? target.related_articles,
        content_type: num(body.content_type) ?? target.content_type,
        latest_version: latestVersion,
        authors: target.authors.includes(author) ? target.authors : [...target.authors, author],
      })!;
      let stored = updated;
      if (bool(body.publish) === true) {
        const toPublish = versionsOf(updated).find((candidate) => candidate.version_number === latestVersion);
        if (toPublish)
          ds.articleVersions.update(toPublish.id, {
            published: true,
            published_at: nowIso(),
            status: 3,
            publish_message: strOrNull(body.publish_message),
          });
        stored = ds.articles.update(updated.id, { public_version: latestVersion })!;
        logEvent(ds, "article.published", stored.d360_id, {
          title: stored.title,
          version_number: latestVersion,
          language_code: langCode,
        });
      }
      logEvent(ds, "article.updated", stored.d360_id, {
        title: stored.title,
        language_code: langCode,
        version_number: latestVersion,
      });
      const current = versionsOf(stored).find((candidate) => candidate.version_number === latestVersion) ?? null;
      return c.json(envelope(formatArticle(fmt, stored, current)));
    }),
  );

  route(
    app,
    "delete",
    "/v2/Articles/:id/:lang",
    api(ds, (c) => {
      const { entity } = findArticle(ds, c.req.param("id"), undefined);
      const langCode = c.req.param("lang");
      const translations = ds.articles.findBy("d360_id", entity.d360_id).filter((candidate) => !candidate.deleted);
      const targets = translations.filter(
        (candidate) => translations.length === 1 || candidate.language_code.toLowerCase() === langCode.toLowerCase(),
      );
      if (targets.length === 0) throw notFound("Article translation not found", "article_not_found");
      for (const target of targets) {
        for (const version of ds.articleVersions
          .findBy("article_id", target.d360_id)
          .filter((candidate) => candidate.language_code === target.language_code))
          ds.articleVersions.delete(version.id);
        ds.articles.delete(target.id);
      }
      logEvent(ds, "article.deleted", entity.d360_id, { title: entity.title, language_code: langCode });
      return c.json(envelope({ id: entity.d360_id, language_code: langCode }));
    }),
  );

  route(
    app,
    "get",
    "/v2/Articles/:id/:lang/versions",
    api(ds, (c) => {
      const { entity } = findArticle(ds, c.req.param("id"), c.req.param("lang"));
      return c.json(envelope(versionsOf(entity).map(formatArticleVersion)));
    }),
  );

  route(
    app,
    "get",
    "/v2/Articles/:id/:lang/versions/:number",
    api(ds, (c) => {
      const { entity } = findArticle(ds, c.req.param("id"), c.req.param("lang"));
      const version = versionsOf(entity).find(
        (candidate) => candidate.version_number === Number(c.req.param("number")),
      );
      if (!version) throw notFound("Article version not found", "article_version_not_found");
      return c.json(envelope(formatArticle(fmt, entity, version)));
    }),
  );

  route(
    app,
    "delete",
    "/v2/Articles/:id/:lang/versions/:number",
    api(ds, (c) => {
      const { entity } = findArticle(ds, c.req.param("id"), c.req.param("lang"));
      const versions = versionsOf(entity);
      const version = versions.find((candidate) => candidate.version_number === Number(c.req.param("number")));
      if (!version) throw notFound("Article version not found", "article_version_not_found");
      if (version.published) throw badRequest("A published version cannot be deleted", "version_published");
      if (versions.length === 1) throw badRequest("The only version of an article cannot be deleted", "last_version");
      ds.articleVersions.delete(version.id);
      const remaining = versionsOf(entity);
      const latest = remaining[remaining.length - 1];
      ds.articles.update(entity.id, {
        latest_version: latest.version_number,
        title: latest.title,
        content: latest.content,
        html_content: latest.html_content,
      });
      return c.json(envelope({ version_number: version.version_number }));
    }),
  );

  route(
    app,
    "post",
    "/v2/Articles/:id/:lang/fork",
    api(ds, async (c) => {
      const { entity } = findArticle(ds, c.req.param("id"), c.req.param("lang"));
      const body = await parseJsonBody(c);
      const source = versionsOf(entity).find(
        (candidate) => candidate.version_number === (num(body.version_number) ?? entity.latest_version),
      );
      if (!source) throw notFound("Article version not found", "article_version_not_found");
      const author = str(body.user_id) ?? entity.created_by;
      const nextNumber = entity.latest_version + 1;
      const forked = insertVersion(entity, nextNumber, source.title, source.content, source.html_content, author);
      const updated = ds.articles.update(entity.id, {
        latest_version: nextNumber,
        title: source.title,
        content: source.content,
        html_content: source.html_content,
      })!;
      logEvent(ds, "article.forked", updated.d360_id, {
        from_version: source.version_number,
        version_number: nextNumber,
      });
      return c.json(envelope({ ...formatArticleVersion(forked), article_id: updated.d360_id }));
    }),
  );

  route(
    app,
    "post",
    "/v2/Articles/:id/:lang/publish",
    api(ds, async (c) => {
      const { entity } = findArticle(ds, c.req.param("id"), c.req.param("lang"));
      const body = await parseJsonBody(c);
      const versionNumber = num(body.version_number) ?? entity.latest_version;
      const version = versionsOf(entity).find((candidate) => candidate.version_number === versionNumber);
      if (!version) throw notFound("Article version not found", "article_version_not_found");
      ds.articleVersions.update(version.id, {
        published: true,
        published_at: nowIso(),
        publish_message: strOrNull(body.publish_message),
        status: 3,
      });
      for (const other of versionsOf(entity))
        if (other.id !== version.id && other.published) ds.articleVersions.update(other.id, { published: false });
      const updated = ds.articles.update(entity.id, {
        public_version: versionNumber,
        title: version.title,
        content: version.content,
        html_content: version.html_content,
      })!;
      logEvent(ds, "article.published", updated.d360_id, {
        title: updated.title,
        version_number: versionNumber,
        language_code: updated.language_code,
      });
      return c.json(envelope(formatArticle(fmt, updated, ds.articleVersions.get(version.id)!)));
    }),
  );

  route(
    app,
    "put",
    "/v2/Articles/:id/:lang/settings",
    api(ds, async (c) => {
      const { entity } = findArticle(ds, c.req.param("id"), c.req.param("lang"));
      const body = await parseJsonBody(c);
      const updated = ds.articles.update(entity.id, {
        slug:
          body.slug !== undefined
            ? articleSlug(entity.project_version_id, entity.language_code, String(body.slug), entity.d360_id)
            : entity.slug,
        seo_title: body.seo_title !== undefined ? strOrNull(body.seo_title) : entity.seo_title,
        description: body.description !== undefined ? strOrNull(body.description) : entity.description,
        exclude_from_search: bool(body.exclude_from_search) ?? entity.exclude_from_search,
        allow_comments: bool(body.allow_comments) ?? entity.allow_comments,
        show_table_of_contents: bool(body.show_table_of_contents) ?? entity.show_table_of_contents,
        feature_image_url:
          body.feature_image_url !== undefined ? strOrNull(body.feature_image_url) : entity.feature_image_url,
        tags: stringArray(body.tags) ?? entity.tags,
        related_articles: stringArray(body.related_articles) ?? entity.related_articles,
        status_indicator: num(body.status_indicator) ?? entity.status_indicator,
        hidden: bool(body.hidden) ?? entity.hidden,
      })!;
      return c.json(envelope(formatArticle(fmt, updated, versionsOf(updated).at(-1) ?? null)));
    }),
  );

  route(
    app,
    "get",
    "/v2/Articles/:id/:lang/reviewreminder",
    api(ds, (c) => {
      const { entity } = findArticle(ds, c.req.param("id"), c.req.param("lang"));
      return c.json(envelope({ article_id: entity.d360_id, review_reminder_at: entity.review_reminder_at }));
    }),
  );

  route(
    app,
    "put",
    "/v2/Articles/:id/:lang/reviewreminder",
    api(ds, async (c) => {
      const { entity } = findArticle(ds, c.req.param("id"), c.req.param("lang"));
      const body = await parseJsonBody(c);
      const raw = str(body.review_reminder_at) ?? str(body.reminder_date);
      if (!raw || Number.isNaN(Date.parse(raw)))
        throw badRequest("review_reminder_at must be a valid date", "validation_error");
      const updated = ds.articles.update(entity.id, { review_reminder_at: new Date(raw).toISOString() })!;
      return c.json(envelope({ article_id: updated.d360_id, review_reminder_at: updated.review_reminder_at }));
    }),
  );

  route(
    app,
    "delete",
    "/v2/Articles/:id/:lang/reviewreminder",
    api(ds, (c) => {
      const { entity } = findArticle(ds, c.req.param("id"), c.req.param("lang"));
      ds.articles.update(entity.id, { review_reminder_at: null });
      return c.json(envelope({ article_id: entity.d360_id }));
    }),
  );
}
