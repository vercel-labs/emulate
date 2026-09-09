import type { D360Language } from "../entities.js";
import { formatArticleSummary, formatCategory, formatLanguage, formatProjectVersion } from "../formatters.js";
import {
  api,
  badRequest,
  bool,
  envelope,
  guid,
  notFound,
  num,
  parseJsonBody,
  route,
  str,
  uniqueSlug,
} from "../helpers.js";
import { logEvent } from "../store.js";
import { findVersion, resolveLanguage, type D360RouteContext } from "../route-utils.js";

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  "en-us": "English (US)",
  "en-gb": "English (UK)",
  fr: "French",
  de: "German",
  es: "Spanish",
  it: "Italian",
  nl: "Dutch",
  pt: "Portuguese",
  "pt-br": "Portuguese (Brazil)",
  ja: "Japanese",
  zh: "Chinese",
  ko: "Korean",
  ar: "Arabic",
  he: "Hebrew",
  pl: "Polish",
  sv: "Swedish",
  da: "Danish",
  fi: "Finnish",
  nb: "Norwegian",
  ru: "Russian",
  tr: "Turkish",
};

export function languageName(code: string): string {
  return LANGUAGE_NAMES[code.toLowerCase()] ?? code.toUpperCase();
}

export function projectVersionRoutes(rc: D360RouteContext): void {
  const { app, ds, fmt } = rc;

  route(
    app,
    "get",
    "/v2/ProjectVersions",
    api(ds, (c) =>
      c.json(
        envelope(
          [...ds.projectVersions.all()].sort((a, b) => a.order - b.order || a.id - b.id).map(formatProjectVersion),
        ),
      ),
    ),
  );

  route(
    app,
    "post",
    "/v2/ProjectVersions",
    api(ds, async (c) => {
      const body = await parseJsonBody(c);
      const versionNumber = num(body.version_number);
      if (versionNumber === undefined) throw badRequest("version_number is required", "validation_error");
      if (ds.projectVersions.all().some((candidate) => candidate.version_number === versionNumber)) {
        throw badRequest(`Project version ${versionNumber} already exists`, "duplicate_version");
      }
      const baseId = str(body.base_version_id) ?? str(body.base_project_version_id);
      const base = baseId ? ds.projectVersions.findOneBy("d360_id", baseId) : undefined;
      if (baseId && !base) throw badRequest("Base project version not found", "project_version_not_found");
      const languages: D360Language[] = base
        ? base.languages.map((language) => ({ ...language }))
        : [{ code: "en", name: "English", is_default: true, hidden: false, enable_rtl: false }];
      const version = ds.projectVersions.insert({
        d360_id: str(body.id) ?? guid(),
        version_number: versionNumber,
        base_version_number: base?.version_number ?? null,
        version_code_name: str(body.version_code_name) ?? "",
        is_main_version: bool(body.is_main_version) ?? ds.projectVersions.count() === 0,
        is_beta: bool(body.is_beta) ?? false,
        is_public: bool(body.is_public) ?? true,
        is_deprecated: bool(body.is_deprecated) ?? false,
        slug: uniqueSlug(str(body.slug) ?? `v${versionNumber}`, (slug) =>
          ds.projectVersions.all().some((candidate) => candidate.slug === slug),
        ),
        order: num(body.order) ?? ds.projectVersions.count(),
        languages,
        version_type: num(body.version_type) ?? 0,
      });
      if (version.is_main_version) {
        for (const other of ds.projectVersions.all())
          if (other.id !== version.id && other.is_main_version)
            ds.projectVersions.update(other.id, { is_main_version: false });
      }
      if (base) {
        const idMap = new Map<string, string>();
        for (const category of ds.categories.findBy("project_version_id", base.d360_id)) {
          const newId = idMap.get(category.d360_id) ?? guid();
          idMap.set(category.d360_id, newId);
          ds.categories.insert({
            ...stripEntity(category),
            d360_id: newId,
            project_version_id: version.d360_id,
            parent_category_id: null,
          });
        }
        for (const category of ds.categories.findBy("project_version_id", version.d360_id)) {
          const original = ds.categories
            .findBy("project_version_id", base.d360_id)
            .find(
              (candidate) =>
                idMap.get(candidate.d360_id) === category.d360_id && candidate.language_code === category.language_code,
            );
          if (original?.parent_category_id)
            ds.categories.update(category.id, { parent_category_id: idMap.get(original.parent_category_id) ?? null });
        }
        for (const article of ds.articles.findBy("project_version_id", base.d360_id)) {
          const newId = idMap.get(article.d360_id) ?? guid();
          idMap.set(article.d360_id, newId);
          ds.articles.insert({
            ...stripEntity(article),
            d360_id: newId,
            project_version_id: version.d360_id,
            category_id: idMap.get(article.category_id) ?? article.category_id,
          });
          for (const articleVersion of ds.articleVersions
            .findBy("article_id", article.d360_id)
            .filter((candidate) => candidate.language_code === article.language_code)) {
            ds.articleVersions.insert({ ...stripEntity(articleVersion), article_id: newId });
          }
        }
      }
      logEvent(ds, "project_version.created", version.d360_id, { version_number: version.version_number });
      return c.json(envelope(formatProjectVersion(version)));
    }),
  );

  route(
    app,
    "get",
    "/v2/ProjectVersions/:id",
    api(ds, (c) => c.json(envelope(formatProjectVersion(findVersion(ds, c.req.param("id")))))),
  );

  route(
    app,
    "put",
    "/v2/ProjectVersions/:id",
    api(ds, async (c) => {
      const version = findVersion(ds, c.req.param("id"));
      const body = await parseJsonBody(c);
      const makeMain = bool(body.is_main_version);
      if (makeMain)
        for (const other of ds.projectVersions.all())
          if (other.id !== version.id && other.is_main_version)
            ds.projectVersions.update(other.id, { is_main_version: false });
      const updated = ds.projectVersions.update(version.id, {
        version_code_name: str(body.version_code_name) ?? version.version_code_name,
        is_main_version: makeMain ?? version.is_main_version,
        is_beta: bool(body.is_beta) ?? version.is_beta,
        is_public: bool(body.is_public) ?? version.is_public,
        is_deprecated: bool(body.is_deprecated) ?? version.is_deprecated,
        order: num(body.order) ?? version.order,
        slug: str(body.slug) ?? version.slug,
      })!;
      return c.json(envelope(formatProjectVersion(updated)));
    }),
  );

  route(
    app,
    "delete",
    "/v2/ProjectVersions/:id",
    api(ds, (c) => {
      const version = findVersion(ds, c.req.param("id"));
      if (version.is_main_version)
        throw badRequest("The main project version cannot be deleted", "main_version_delete");
      for (const category of ds.categories.findBy("project_version_id", version.d360_id))
        ds.categories.delete(category.id);
      for (const article of ds.articles.findBy("project_version_id", version.d360_id)) {
        for (const articleVersion of ds.articleVersions.findBy("article_id", article.d360_id))
          ds.articleVersions.delete(articleVersion.id);
        ds.articles.delete(article.id);
      }
      ds.projectVersions.delete(version.id);
      logEvent(ds, "project_version.deleted", version.d360_id, { version_number: version.version_number });
      return c.json(envelope({ id: version.d360_id }));
    }),
  );

  route(
    app,
    "get",
    "/v2/ProjectVersions/:id/categories",
    api(ds, (c) => {
      const version = findVersion(ds, c.req.param("id"));
      const langCode = resolveLanguage(
        ds,
        version.d360_id,
        c.req.query("langCode") ?? c.req.query("lang_code") ?? undefined,
      );
      const excludeArticles = bool(c.req.query("excludeArticles")) ?? false;
      const roots = ds.categories
        .findBy("project_version_id", version.d360_id)
        .filter((category) => category.language_code === langCode && category.parent_category_id === null)
        .sort((a, b) => a.order - b.order || a.id - b.id);
      return c.json(
        envelope(
          roots.map((category) =>
            formatCategory(fmt, category, { includeChildren: true, includeArticles: !excludeArticles }),
          ),
        ),
      );
    }),
  );

  route(
    app,
    "get",
    "/v2/ProjectVersions/:id/articles",
    api(ds, (c) => {
      const version = findVersion(ds, c.req.param("id"));
      const langCode = resolveLanguage(
        ds,
        version.d360_id,
        c.req.query("langCode") ?? c.req.query("lang_code") ?? undefined,
      );
      const articles = ds.articles
        .findBy("project_version_id", version.d360_id)
        .filter((article) => article.language_code === langCode && !article.deleted)
        .sort((a, b) => a.order - b.order || a.id - b.id);
      return c.json(envelope(articles.map((article) => formatArticleSummary(fmt, article))));
    }),
  );

  route(
    app,
    "get",
    "/v2/Language/:versionId",
    api(ds, (c) => {
      const version = findVersion(ds, c.req.param("versionId"));
      return c.json(envelope(version.languages.map((language) => formatLanguage(language, version.d360_id))));
    }),
  );

  route(
    app,
    "post",
    "/v2/Language/:versionId",
    api(ds, async (c) => {
      const version = findVersion(ds, c.req.param("versionId"));
      const body = await parseJsonBody(c);
      const code = str(body.language_code) ?? str(body.code);
      if (!code) throw badRequest("language_code is required", "validation_error");
      if (version.languages.some((language) => language.code.toLowerCase() === code.toLowerCase()))
        throw badRequest("Language already exists", "duplicate_language");
      const setDefault = bool(body.set_as_default) ?? bool(body.is_default) ?? false;
      const language: D360Language = {
        code,
        name: str(body.language_name) ?? languageName(code),
        is_default: setDefault,
        hidden: bool(body.hidden) ?? false,
        enable_rtl: bool(body.enable_rtl) ?? false,
      };
      const languages = [
        ...version.languages.map((existing) => (setDefault ? { ...existing, is_default: false } : existing)),
        language,
      ];
      const updated = ds.projectVersions.update(version.id, { languages })!;
      logEvent(ds, "language.created", version.d360_id, { language_code: code });
      return c.json(envelope(formatLanguage(language, updated.d360_id)));
    }),
  );

  route(
    app,
    "put",
    "/v2/Language/:versionId/:code",
    api(ds, async (c) => {
      const version = findVersion(ds, c.req.param("versionId"));
      const code = c.req.param("code");
      const existing = version.languages.find((language) => language.code.toLowerCase() === code.toLowerCase());
      if (!existing) throw notFound("Language not found", "language_not_found");
      const body = await parseJsonBody(c);
      const setDefault = bool(body.set_as_default) ?? bool(body.is_default);
      const languages = version.languages.map((language) => {
        if (language.code !== existing.code) return setDefault ? { ...language, is_default: false } : language;
        return {
          ...language,
          name: str(body.language_name) ?? language.name,
          is_default: setDefault ?? language.is_default,
          hidden: bool(body.hidden) ?? language.hidden,
          enable_rtl: bool(body.enable_rtl) ?? language.enable_rtl,
        };
      });
      ds.projectVersions.update(version.id, { languages });
      return c.json(
        envelope(formatLanguage(languages.find((language) => language.code === existing.code)!, version.d360_id)),
      );
    }),
  );

  route(
    app,
    "delete",
    "/v2/Language/:versionId/:code",
    api(ds, (c) => {
      const version = findVersion(ds, c.req.param("versionId"));
      const code = c.req.param("code");
      const existing = version.languages.find((language) => language.code.toLowerCase() === code.toLowerCase());
      if (!existing) throw notFound("Language not found", "language_not_found");
      if (existing.is_default) throw badRequest("The default language cannot be deleted", "default_language_delete");
      ds.projectVersions.update(version.id, {
        languages: version.languages.filter((language) => language.code !== existing.code),
      });
      for (const category of ds.categories
        .findBy("project_version_id", version.d360_id)
        .filter((candidate) => candidate.language_code === existing.code))
        ds.categories.delete(category.id);
      for (const article of ds.articles
        .findBy("project_version_id", version.d360_id)
        .filter((candidate) => candidate.language_code === existing.code)) {
        for (const articleVersion of ds.articleVersions
          .findBy("article_id", article.d360_id)
          .filter((candidate) => candidate.language_code === existing.code))
          ds.articleVersions.delete(articleVersion.id);
        ds.articles.delete(article.id);
      }
      return c.json(envelope({ language_code: existing.code }));
    }),
  );
}

function stripEntity<T extends { id: number; created_at: string; updated_at: string }>(
  entity: T,
): Omit<T, "id" | "created_at" | "updated_at"> {
  const { id: _id, created_at: _created, updated_at: _updated, ...rest } = entity;
  return rest;
}
