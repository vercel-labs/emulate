import { articleUrl, highlight } from "../formatters.js";
import { api, envelope, route, skipTake } from "../helpers.js";
import { knowledgeBaseUrl, projectId, projectName } from "../store.js";
import { findVersion, resolveLanguage, type D360RouteContext } from "../route-utils.js";

export function miscRoutes(rc: D360RouteContext): void {
  const { app, ds, fmt } = rc;

  route(
    app,
    "get",
    "/v2/Search/:versionId",
    api(ds, (c) => {
      const version = findVersion(ds, c.req.param("versionId"));
      const query = (c.req.query("searchQuery") ?? c.req.query("search_query") ?? c.req.query("q") ?? "").trim();
      const langCode = resolveLanguage(
        ds,
        version.d360_id,
        c.req.query("langCode") ?? c.req.query("lang_code") ?? undefined,
      );
      const { skip, take } = skipTake(c, 10);
      const lowered = query.toLowerCase();
      const results = ds.articles
        .findBy("project_version_id", version.d360_id)
        .filter(
          (article) =>
            article.language_code === langCode &&
            !article.deleted &&
            !article.hidden &&
            !article.exclude_from_search &&
            article.public_version !== null,
        )
        .filter(
          (article) =>
            !lowered ||
            article.title.toLowerCase().includes(lowered) ||
            article.content.toLowerCase().includes(lowered) ||
            article.tags.some((tag) => tag.toLowerCase().includes(lowered)),
        )
        .sort(
          (a, b) =>
            Number(b.title.toLowerCase().includes(lowered)) - Number(a.title.toLowerCase().includes(lowered)) ||
            a.id - b.id,
        );
      const page = results.slice(skip, skip + take).map((article) => {
        const category = ds.categories
          .findBy("d360_id", article.category_id)
          .find((candidate) => candidate.language_code === langCode);
        return {
          id: article.d360_id,
          title: article.title,
          highlighted_title: highlight(article.title, query),
          highlighted_content: highlight(article.content, query),
          category_id: article.category_id,
          category_name: category?.name ?? null,
          slug: article.slug,
          url: articleUrl(fmt, article),
          language_code: langCode,
          project_version_id: version.d360_id,
          content_type: article.content_type,
        };
      });
      return c.json(envelope({ total_count: results.length, skip, take, results: page }));
    }),
  );

  route(
    app,
    "get",
    "/v2/Project",
    api(ds, (c) => {
      const versions = [...ds.projectVersions.all()].sort((a, b) => a.order - b.order);
      const main = versions.find((version) => version.is_main_version) ?? versions[0];
      return c.json(
        envelope({
          id: projectId(ds),
          name: projectName(ds),
          knowledge_base_url: knowledgeBaseUrl(ds),
          main_version_id: main?.d360_id ?? null,
          project_versions_count: versions.length,
          articles_count: ds.articles.count((article) => !article.deleted),
          categories_count: ds.categories.count(),
          readers_count: ds.readers.count(),
          team_accounts_count: ds.teamAccounts.count(),
        }),
      );
    }),
  );

  route(
    app,
    "get",
    "/v2/Project/tokens",
    api(ds, (c) =>
      c.json(
        envelope(
          ds.apiTokens.all().map((token) => ({
            token: `${token.token.slice(0, 4)}...${token.token.slice(-4)}`,
            description: token.description,
            created_at: token.created_at,
          })),
        ),
      ),
    ),
  );

  app.get("/_document360/events", (c) => {
    const type = c.req.query("type");
    const { skip, take } = skipTake(c, 100);
    const events = [...ds.events.all()]
      .filter((event) => !type || event.type === type)
      .sort((a, b) => b.id - a.id)
      .slice(skip, skip + take);
    return c.json({
      events: events.map((event) => ({
        id: event.id,
        type: event.type,
        subject: event.subject,
        detail: event.detail,
        created_at: event.created_at,
      })),
    });
  });

  app.delete("/_document360/events", (c) => {
    ds.events.clear();
    return c.json({ ok: true });
  });
}
