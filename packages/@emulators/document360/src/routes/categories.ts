import type { CategoryType, D360Category } from "../entities.js";
import { formatArticleSummary, formatCategory } from "../formatters.js";
import {
  api,
  badRequest,
  bool,
  envelope,
  guid,
  num,
  parseJsonBody,
  route,
  slugify,
  str,
  strOrNull,
  uniqueSlug,
} from "../helpers.js";
import { logEvent } from "../store.js";
import { findCategory, findVersion, mainVersion, resolveLanguage, type D360RouteContext } from "../route-utils.js";

export function categoryRoutes(rc: D360RouteContext): void {
  const { app, ds, fmt } = rc;

  const categorySlug = (versionId: string, langCode: string, base: string, excludeId?: string) =>
    uniqueSlug(slugify(base), (slug) =>
      ds.categories
        .findBy("project_version_id", versionId)
        .some(
          (candidate) =>
            candidate.language_code === langCode && candidate.slug === slug && candidate.d360_id !== excludeId,
        ),
    );

  route(
    app,
    "post",
    "/v2/Categories",
    api(ds, async (c) => {
      const body = await parseJsonBody(c);
      const name = str(body.name)?.trim();
      if (!name) throw badRequest("name is required", "validation_error");
      const version = body.project_version_id ? findVersion(ds, String(body.project_version_id)) : mainVersion(ds);
      const langCode = resolveLanguage(ds, version.d360_id, str(body.language_code) ?? str(body.lang_code));
      const parentId = strOrNull(body.parent_category_id);
      if (parentId) {
        const parent = ds.categories.findOneBy("d360_id", parentId);
        if (!parent || parent.project_version_id !== version.d360_id)
          throw badRequest("Parent category not found", "category_not_found");
        if (parent.category_type === 1)
          throw badRequest("A page category cannot contain sub categories", "invalid_parent");
      }
      const categoryType = (num(body.category_type) ?? 0) as CategoryType;
      if (![0, 1, 2].includes(categoryType))
        throw badRequest("category_type must be 0 (folder), 1 (page) or 2 (index)", "validation_error");
      const siblings = ds.categories
        .findBy("project_version_id", version.d360_id)
        .filter((candidate) => candidate.language_code === langCode && candidate.parent_category_id === parentId);
      const category = ds.categories.insert({
        d360_id: str(body.id) ?? guid(),
        project_version_id: version.d360_id,
        language_code: langCode,
        name,
        description: strOrNull(body.description),
        content: strOrNull(body.content),
        parent_category_id: parentId,
        order: num(body.order) ?? siblings.length,
        hidden: bool(body.hidden) ?? false,
        icon: strOrNull(body.icon),
        slug: str(body.slug)
          ? uniqueSlug(slugify(String(body.slug)), () => false)
          : categorySlug(version.d360_id, langCode, name),
        category_type: categoryType,
        status: 0,
        content_type: num(body.content_type) ?? 0,
      });
      logEvent(ds, "category.created", category.d360_id, { name: category.name, project_version_id: version.d360_id });
      return c.json(envelope(formatCategory(fmt, category)));
    }),
  );

  route(
    app,
    "get",
    "/v2/Categories/:id/:lang",
    api(ds, (c) => {
      const { entity, fallback } = findCategory(ds, c.req.param("id"), c.req.param("lang"));
      return c.json(envelope(formatCategory(fmt, entity, { includeChildren: true, includeArticles: true, fallback })));
    }),
  );

  route(
    app,
    "get",
    "/v2/Categories/:id/:lang/articles",
    api(ds, (c) => {
      const { entity } = findCategory(ds, c.req.param("id"), c.req.param("lang"));
      const articles = ds.articles
        .findBy("category_id", entity.d360_id)
        .filter((article) => article.language_code === entity.language_code && !article.deleted)
        .sort((a, b) => a.order - b.order || a.id - b.id);
      return c.json(envelope(articles.map((article) => formatArticleSummary(fmt, article))));
    }),
  );

  route(
    app,
    "put",
    "/v2/Categories/:id/:lang",
    api(ds, async (c) => {
      const { entity } = findCategory(ds, c.req.param("id"), undefined);
      const langCode = resolveLanguage(ds, entity.project_version_id, c.req.param("lang"));
      const body = await parseJsonBody(c);
      let target = ds.categories
        .findBy("d360_id", entity.d360_id)
        .find((candidate) => candidate.language_code === langCode);
      if (!target) {
        target = ds.categories.insert({
          d360_id: entity.d360_id,
          project_version_id: entity.project_version_id,
          language_code: langCode,
          name: entity.name,
          description: entity.description,
          content: entity.content,
          parent_category_id: entity.parent_category_id,
          order: entity.order,
          hidden: entity.hidden,
          icon: entity.icon,
          slug: entity.slug,
          category_type: entity.category_type,
          status: entity.status,
          content_type: entity.content_type,
        });
      }
      const parentId =
        body.parent_category_id !== undefined ? strOrNull(body.parent_category_id) : target.parent_category_id;
      if (parentId) {
        if (parentId === target.d360_id) throw badRequest("A category cannot be its own parent", "invalid_parent");
        const parent = ds.categories.findOneBy("d360_id", parentId);
        if (!parent || parent.project_version_id !== target.project_version_id)
          throw badRequest("Parent category not found", "category_not_found");
      }
      const name = body.name !== undefined ? (str(body.name)?.trim() ?? "") : target.name;
      if (!name) throw badRequest("name cannot be empty", "validation_error");
      const updates: Partial<D360Category> = {
        name,
        description: body.description !== undefined ? strOrNull(body.description) : target.description,
        content: body.content !== undefined ? strOrNull(body.content) : target.content,
        parent_category_id: parentId,
        order: num(body.order) ?? target.order,
        hidden: bool(body.hidden) ?? target.hidden,
        icon: body.icon !== undefined ? strOrNull(body.icon) : target.icon,
        slug:
          body.slug !== undefined
            ? categorySlug(target.project_version_id, langCode, String(body.slug), target.d360_id)
            : target.slug,
        category_type: (num(body.category_type) as CategoryType | undefined) ?? target.category_type,
        content_type: num(body.content_type) ?? target.content_type,
      };
      const updated = ds.categories.update(target.id, updates)!;
      if (body.parent_category_id !== undefined || body.order !== undefined) {
        for (const sibling of ds.categories.findBy("d360_id", updated.d360_id)) {
          if (sibling.id !== updated.id)
            ds.categories.update(sibling.id, { parent_category_id: updated.parent_category_id, order: updated.order });
        }
      }
      logEvent(ds, "category.updated", updated.d360_id, { name: updated.name, language_code: langCode });
      return c.json(envelope(formatCategory(fmt, updated)));
    }),
  );

  route(
    app,
    "delete",
    "/v2/Categories/:id/:lang",
    api(ds, (c) => {
      const { entity } = findCategory(ds, c.req.param("id"), undefined);
      const removeTree = (categoryId: string) => {
        for (const child of ds.categories.findBy("parent_category_id", categoryId)) removeTree(child.d360_id);
        for (const article of ds.articles.findBy("category_id", categoryId)) {
          for (const version of ds.articleVersions.findBy("article_id", article.d360_id))
            ds.articleVersions.delete(version.id);
          ds.articles.delete(article.id);
        }
        for (const translation of ds.categories.findBy("d360_id", categoryId)) ds.categories.delete(translation.id);
      };
      removeTree(entity.d360_id);
      logEvent(ds, "category.deleted", entity.d360_id, { name: entity.name });
      return c.json(envelope({ id: entity.d360_id }));
    }),
  );
}
