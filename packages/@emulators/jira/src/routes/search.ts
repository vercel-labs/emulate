import type { RouteContext } from "@emulators/core";
import { API_V, intParam, JiraError, listParam, makeHandler, READ, readJson, type JiraRequest } from "../context.js";
import { formatIssue, parseFieldSelection } from "../issue-format.js";
import { JqlError, parseJql, runQuery } from "../jql.js";
import type { JiraIssue } from "../entities.js";

interface SearchParams {
  jql: string;
  fields: string[];
  expand: string[];
  maxResults?: number;
  startAt?: number;
  nextPageToken?: string;
}

async function searchParams(r: JiraRequest): Promise<SearchParams> {
  if (r.c.req.method === "POST") {
    const body = await readJson(r.c);
    const list = (value: unknown) =>
      Array.isArray(value)
        ? value.map(String)
        : typeof value === "string"
          ? value
              .split(",")
              .map((part) => part.trim())
              .filter(Boolean)
          : [];
    return {
      jql: typeof body.jql === "string" ? body.jql : "",
      fields: list(body.fields),
      expand: list(body.expand),
      maxResults: typeof body.maxResults === "number" ? body.maxResults : undefined,
      startAt: typeof body.startAt === "number" ? body.startAt : undefined,
      nextPageToken: typeof body.nextPageToken === "string" ? body.nextPageToken : undefined,
    };
  }
  const q = (name: string) => r.c.req.query(name);
  return {
    jql: q("jql") ?? "",
    fields: listParam(r.c, "fields"),
    expand: listParam(r.c, "expand"),
    maxResults: q("maxResults") !== undefined ? intParam(q("maxResults"), 50) : undefined,
    startAt: q("startAt") !== undefined ? intParam(q("startAt"), 0) : undefined,
    nextPageToken: q("nextPageToken"),
  };
}

function runJql(r: JiraRequest, jql: string, requireRestriction: boolean): JiraIssue[] {
  try {
    const query = parseJql(jql);
    if (requireRestriction && !query.where) {
      throw new JiraError(400, [
        "Unbounded JQL queries are not allowed here. Please add a search restriction to your query.",
      ]);
    }
    return runQuery(r.js, query, r.user);
  } catch (err) {
    if (err instanceof JqlError) throw new JiraError(400, [err.message]);
    throw err;
  }
}

function encodeToken(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf-8").toString("base64url");
}

function decodeToken(token: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf-8"));
    if (typeof parsed.offset === "number" && parsed.offset >= 0) return parsed.offset;
  } catch {
    // fall through
  }
  throw new JiraError(400, ["The provided next page token is invalid or expired."]);
}

function namesAndSchema(r: JiraRequest, expand: string[], issues: Array<Record<string, unknown>>) {
  const extra: Record<string, unknown> = {};
  if (issues.length === 0) return extra;
  const sample = issues[0];
  if (expand.includes("names") && sample.names) extra.names = sample.names;
  if (expand.includes("schema") && sample.schema) extra.schema = sample.schema;
  return extra;
}

export function searchRoutes({ app, store, baseUrl }: RouteContext): void {
  const handle = makeHandler(store, baseUrl);

  const enhanced = handle(
    async (r) => {
      const params = await searchParams(r);
      const issues = runJql(r, params.jql, true);
      const idsOnly = params.fields.length === 0 || params.fields.every((field) => field === "id" || field === "key");
      const maxResults = Math.min(Math.max(params.maxResults ?? 50, 1), idsOnly ? 5000 : 100);
      const offset = params.nextPageToken ? decodeToken(params.nextPageToken) : 0;
      const page = issues.slice(offset, offset + maxResults);
      const selection = parseFieldSelection(
        params.fields.filter((field) => field !== "id"),
        false,
      );
      const formatted = page.map((issue) => formatIssue(r, issue, { fields: selection, expand: params.expand }));
      const isLast = offset + page.length >= issues.length;
      return r.c.json({
        issues: formatted,
        ...(isLast ? {} : { nextPageToken: encodeToken(offset + page.length) }),
        isLast,
        ...namesAndSchema(r, params.expand, formatted),
      });
    },
    { scopes: READ },
  );
  app.get(`${API_V}/search/jql`, enhanced);
  app.post(`${API_V}/search/jql`, enhanced);

  app.post(
    `${API_V}/search/approximate-count`,
    handle(
      async (r) => {
        const body = await readJson(r.c);
        const issues = runJql(r, typeof body.jql === "string" ? body.jql : "", true);
        return r.c.json({ count: issues.length });
      },
      { scopes: READ },
    ),
  );

  const legacy = handle(
    async (r) => {
      const params = await searchParams(r);
      const issues = runJql(r, params.jql, false);
      const startAt = params.startAt ?? 0;
      const maxResults = Math.min(Math.max(params.maxResults ?? 50, 0), 100);
      const selection = parseFieldSelection(params.fields, true);
      const formatted = issues
        .slice(startAt, startAt + maxResults)
        .map((issue) => formatIssue(r, issue, { fields: selection, expand: params.expand }));
      return r.c.json({
        expand: "schema,names",
        startAt,
        maxResults,
        total: issues.length,
        issues: formatted,
        ...namesAndSchema(r, params.expand, formatted),
      });
    },
    { scopes: READ },
  );
  app.get(`${API_V}/search`, legacy);
  app.post(`${API_V}/search`, legacy);

  app.get(
    `${API_V}/issue/picker`,
    handle(
      (r) => {
        const query = (r.c.req.query("query") ?? "").toLowerCase();
        const currentJql = r.c.req.query("currentJQL");
        const pool = currentJql ? runJql(r, currentJql, false) : r.js.issues.all().sort((a, b) => b.id - a.id);
        const matches = pool
          .filter(
            (issue) => !query || issue.key.toLowerCase().includes(query) || issue.summary.toLowerCase().includes(query),
          )
          .slice(0, 20);
        return r.c.json({
          sections: [
            {
              label: "History Search",
              sub: `Showing ${matches.length} of ${matches.length} matching issues`,
              id: "hs",
              issues: matches.map((issue) => ({
                id: issue.id,
                key: issue.key,
                keyHtml: issue.key,
                img: `${r.siteUrl}/images/icons/issuetypes/task.svg`,
                summary: issue.summary,
                summaryText: issue.summary,
              })),
            },
          ],
        });
      },
      { scopes: READ },
    ),
  );
}
