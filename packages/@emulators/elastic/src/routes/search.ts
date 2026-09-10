import type { AppEnv, Context, Hono } from "@emulators/core";
import type { EsDocument } from "../entities.js";
import { elasticsearch, esBadRequest, esNotFound, EsError, guid, num, str, type Json } from "../helpers.js";
import { matchesQuery, projectSource, runAggregations, sortDocs } from "../query.js";
import { cluster, logEvent, type EsStore } from "../store.js";

function indexPatternMatches(pattern: string, name: string): boolean {
  if (pattern === "_all" || pattern === "*") return true;
  const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  return regex.test(name);
}

export function resolveIndices(es: EsStore, expression: string, allowMissing = false): string[] {
  const names = es.indices.all().flatMap((index) => [index.name, ...index.aliases]);
  const resolved = new Set<string>();
  for (const part of expression
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)) {
    const negate = part.startsWith("-");
    const pattern = negate ? part.slice(1) : part;
    const matched = names
      .filter((name) => indexPatternMatches(pattern, name))
      .map((name) => es.indices.all().find((index) => index.name === name || index.aliases.includes(name))!.name);
    if (matched.length === 0 && !pattern.includes("*") && pattern !== "_all" && !allowMissing)
      throw esNotFound(pattern);
    for (const name of matched)
      if (negate) resolved.delete(name);
      else resolved.add(name);
  }
  return [...resolved];
}

export function ensureIndex(es: EsStore, name: string): void {
  if (!es.indices.findOneBy("name", name))
    es.indices.insert({
      name,
      mappings: { properties: {} },
      settings: { index: { number_of_shards: "1", number_of_replicas: "1" } },
      aliases: [],
    });
}

export function indexDocument(
  es: EsStore,
  index: string,
  source: Json,
  docId?: string,
  mode: "index" | "create" = "index",
): { doc: EsDocument; created: boolean } {
  ensureIndex(es, index);
  const existing = docId ? es.documents.findBy("index", index).find((doc) => doc.doc_id === docId) : undefined;
  if (existing && mode === "create")
    throw new EsError(
      409,
      "version_conflict_engine_exception",
      `[${docId}]: version conflict, document already exists (current version [${existing.version}])`,
      { index, shard: "0", index_uuid: "_na_" },
    );
  if (existing)
    return { doc: es.documents.update(existing.id, { source, version: existing.version + 1 })!, created: false };
  return { doc: es.documents.insert({ index, doc_id: docId ?? guid(), source, version: 1 }), created: true };
}

async function readBody(c: Context): Promise<Json> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw esBadRequest("Failed to parse request body as JSON", "json_parse_exception");
  }
}

function hitOf(doc: EsDocument, sourceSpec: unknown, withScore: boolean): Json {
  const source = projectSource(doc.source, sourceSpec);
  return {
    _index: doc.index,
    _id: doc.doc_id,
    _score: withScore ? 1 : null,
    ...(source === false ? {} : { _source: source }),
  };
}

export function searchRoutes(app: Hono<AppEnv>, es: EsStore): void {
  const productInfo = (c: Context) =>
    c.json({
      name: cluster(es).name,
      cluster_name: cluster(es).name,
      cluster_uuid: cluster(es).uuid,
      version: {
        number: cluster(es).version,
        build_flavor: "default",
        build_type: "docker",
        build_hash: "emulate",
        build_date: "2026-01-01T00:00:00.000Z",
        build_snapshot: false,
        lucene_version: "10.2.2",
        minimum_wire_compatibility_version: "8.19.0",
        minimum_index_compatibility_version: "8.0.0",
      },
      tagline: "You Know, for Search",
    });
  app.get("/", elasticsearch(es, productInfo));
  app.get("/es", elasticsearch(es, productInfo));
  app.get("/es/", elasticsearch(es, productInfo));

  const search = elasticsearch(es, async (c) => {
    const index = c.req.param("index") ?? c.req.query("index") ?? "*";
    const body = await readBody(c);
    const query = (c.req.query("q")
      ? { query_string: { query: c.req.query("q") } }
      : (body.query as Json | undefined)) ?? { match_all: {} };
    const indices = resolveIndices(
      es,
      index,
      bool(c.req.query("ignore_unavailable")) || bool(c.req.query("allow_no_indices")),
    );
    const size = num(body.size) ?? num(c.req.query("size")) ?? 10;
    const from = num(body.from) ?? num(c.req.query("from")) ?? 0;
    if (size > 10000)
      throw esBadRequest(
        "Result window is too large, from + size must be less than or equal to: [10000]",
        "illegal_argument_exception",
      );
    const started = Date.now();
    const candidates = indices.flatMap((name) => es.documents.findBy("index", name)).sort((a, b) => a.id - b.id);
    const rows = candidates.map((doc, sequence) => ({
      doc,
      view: { ...doc.source, _index: doc.index, _id: doc.doc_id, _source: doc.source, _sequence: sequence },
    }));
    const matched = rows.filter((row) => matchesQuery(row.view, query));
    const sorted = sortDocs(
      matched.map((row) => row.view),
      body.sort ??
        c.req
          .query("sort")
          ?.split(",")
          .map((part) => {
            const [field, order] = part.split(":");
            return { [field]: order ?? "asc" };
          }),
    );
    const ordered = sorted.map((view) => matched.find((row) => row.view === view)!.doc);
    const hits = ordered
      .slice(from, from + size)
      .map((doc) => hitOf(doc, body._source ?? c.req.query("_source"), !body.sort));
    const aggregations = runAggregations(
      matched.map((row) => row.view),
      (body.aggs ?? body.aggregations) as Json | undefined,
    );
    const trackTotal = body.track_total_hits;
    const total = trackTotal === false ? Math.min(matched.length, 10000) : matched.length;
    logEvent(es, "search", index, {
      query: JSON.stringify(query).slice(0, 500),
      hits: matched.length,
      aggregations: Object.keys(aggregations),
    });
    return c.json({
      took: Math.max(1, Date.now() - started),
      timed_out: false,
      _shards: { total: Math.max(indices.length, 1), successful: Math.max(indices.length, 1), skipped: 0, failed: 0 },
      hits: {
        total: { value: total, relation: trackTotal === false && matched.length > 10000 ? "gte" : "eq" },
        max_score: hits.length > 0 && !body.sort ? 1 : null,
        hits,
      },
      ...(Object.keys(aggregations).length > 0 ? { aggregations } : {}),
    });
  });
  app.post("/_search", search);
  app.get("/_search", search);
  app.post("/:index/_search", search);
  app.get("/:index/_search", search);

  const count = elasticsearch(es, async (c) => {
    const index = c.req.param("index") ?? "*";
    const body = await readBody(c);
    const indices = resolveIndices(es, index, true);
    const query = (body.query as Json | undefined) ?? { match_all: {} };
    const total = indices
      .flatMap((name) => es.documents.findBy("index", name))
      .filter((doc) => matchesQuery({ ...doc.source, _id: doc.doc_id, _index: doc.index }, query)).length;
    return c.json({
      count: total,
      _shards: { total: Math.max(indices.length, 1), successful: Math.max(indices.length, 1), skipped: 0, failed: 0 },
    });
  });
  app.post("/_count", count);
  app.get("/_count", count);
  app.post("/:index/_count", count);
  app.get("/:index/_count", count);

  app.post(
    "/:index/_doc",
    elasticsearch(es, async (c) => {
      const { doc, created } = indexDocument(es, c.req.param("index"), await readBody(c));
      return c.json(
        {
          _index: doc.index,
          _id: doc.doc_id,
          _version: doc.version,
          result: created ? "created" : "updated",
          _shards: { total: 2, successful: 1, failed: 0 },
          _seq_no: doc.id,
          _primary_term: 1,
        },
        201,
      );
    }),
  );

  for (const method of ["put", "post"] as const) {
    app[method](
      "/:index/_doc/:id",
      elasticsearch(es, async (c) => {
        const { doc, created } = indexDocument(
          es,
          c.req.param("index"),
          await readBody(c),
          c.req.param("id"),
          c.req.query("op_type") === "create" ? "create" : "index",
        );
        return c.json(
          {
            _index: doc.index,
            _id: doc.doc_id,
            _version: doc.version,
            result: created ? "created" : "updated",
            _shards: { total: 2, successful: 1, failed: 0 },
            _seq_no: doc.id,
            _primary_term: 1,
          },
          created ? 201 : 200,
        );
      }),
    );
    app[method](
      "/:index/_create/:id",
      elasticsearch(es, async (c) => {
        const { doc } = indexDocument(es, c.req.param("index"), await readBody(c), c.req.param("id"), "create");
        return c.json(
          {
            _index: doc.index,
            _id: doc.doc_id,
            _version: doc.version,
            result: "created",
            _shards: { total: 2, successful: 1, failed: 0 },
            _seq_no: doc.id,
            _primary_term: 1,
          },
          201,
        );
      }),
    );
  }

  app.get(
    "/:index/_doc/:id",
    elasticsearch(es, (c) => {
      const doc = es.documents
        .findBy("index", c.req.param("index"))
        .find((candidate) => candidate.doc_id === c.req.param("id"));
      if (!doc) {
        if (!es.indices.findOneBy("name", c.req.param("index"))) throw esNotFound(c.req.param("index"));
        return c.json({ _index: c.req.param("index"), _id: c.req.param("id"), found: false }, 404);
      }
      return c.json({
        _index: doc.index,
        _id: doc.doc_id,
        _version: doc.version,
        _seq_no: doc.id,
        _primary_term: 1,
        found: true,
        _source: doc.source,
      });
    }),
  );

  app.delete(
    "/:index/_doc/:id",
    elasticsearch(es, (c) => {
      const doc = es.documents
        .findBy("index", c.req.param("index"))
        .find((candidate) => candidate.doc_id === c.req.param("id"));
      if (!doc)
        return c.json(
          {
            _index: c.req.param("index"),
            _id: c.req.param("id"),
            _version: 1,
            result: "not_found",
            _shards: { total: 2, successful: 1, failed: 0 },
          },
          404,
        );
      es.documents.delete(doc.id);
      return c.json({
        _index: doc.index,
        _id: doc.doc_id,
        _version: doc.version + 1,
        result: "deleted",
        _shards: { total: 2, successful: 1, failed: 0 },
      });
    }),
  );

  app.post(
    "/:index/_update/:id",
    elasticsearch(es, async (c) => {
      const body = await readBody(c);
      const doc = es.documents
        .findBy("index", c.req.param("index"))
        .find((candidate) => candidate.doc_id === c.req.param("id"));
      if (!doc) {
        if (body.doc_as_upsert === true || body.upsert) {
          const { doc: created } = indexDocument(
            es,
            c.req.param("index"),
            ((body.upsert ?? body.doc) as Json) ?? {},
            c.req.param("id"),
          );
          return c.json(
            { _index: created.index, _id: created.doc_id, _version: created.version, result: "created" },
            201,
          );
        }
        throw new EsError(404, "document_missing_exception", `[${c.req.param("id")}]: document missing`, {
          index: c.req.param("index"),
        });
      }
      const updated = es.documents.update(doc.id, {
        source: { ...doc.source, ...((body.doc as Json) ?? {}) },
        version: doc.version + 1,
      })!;
      return c.json({ _index: updated.index, _id: updated.doc_id, _version: updated.version, result: "updated" });
    }),
  );

  const bulk = elasticsearch(es, async (c) => {
    const defaultIndex = c.req.param("index");
    const lines = (await c.req.text()).split("\n").filter((line) => line.trim());
    const items: Json[] = [];
    let errors = false;
    for (let i = 0; i < lines.length; i++) {
      let action: Json;
      try {
        action = JSON.parse(lines[i]);
      } catch {
        throw esBadRequest("Malformed action/metadata line", "illegal_argument_exception");
      }
      const [operation, meta] = Object.entries(action)[0] as [string, Json];
      const index = str(meta._index) ?? defaultIndex;
      if (!index) throw esBadRequest("explicit index in bulk is not allowed", "action_request_validation_exception");
      const id = str(meta._id);
      try {
        if (operation === "delete") {
          const doc = es.documents.findBy("index", index).find((candidate) => candidate.doc_id === id);
          if (doc) es.documents.delete(doc.id);
          items.push({
            delete: {
              _index: index,
              _id: id,
              _version: doc ? doc.version + 1 : 1,
              result: doc ? "deleted" : "not_found",
              status: doc ? 200 : 404,
            },
          });
          continue;
        }
        const payload = JSON.parse(lines[++i] ?? "{}") as Json;
        if (operation === "update") {
          const doc = es.documents.findBy("index", index).find((candidate) => candidate.doc_id === id);
          if (!doc && !payload.doc_as_upsert && !payload.upsert) {
            errors = true;
            items.push({
              update: {
                _index: index,
                _id: id,
                status: 404,
                error: { type: "document_missing_exception", reason: `[${id}]: document missing`, index },
              },
            });
            continue;
          }
          const result = doc
            ? es.documents.update(doc.id, {
                source: { ...doc.source, ...((payload.doc as Json) ?? {}) },
                version: doc.version + 1,
              })!
            : indexDocument(es, index, ((payload.upsert ?? payload.doc) as Json) ?? {}, id).doc;
          items.push({
            update: {
              _index: index,
              _id: result.doc_id,
              _version: result.version,
              result: doc ? "updated" : "created",
              status: doc ? 200 : 201,
            },
          });
          continue;
        }
        const { doc, created } = indexDocument(es, index, payload, id, operation === "create" ? "create" : "index");
        items.push({
          [operation === "create" ? "create" : "index"]: {
            _index: doc.index,
            _id: doc.doc_id,
            _version: doc.version,
            result: created ? "created" : "updated",
            status: created ? 201 : 200,
          },
        });
      } catch (error) {
        if (error instanceof EsError) {
          errors = true;
          items.push({
            [operation]: {
              _index: index,
              _id: id,
              status: error.status,
              error: { type: error.type, reason: error.reason },
            },
          });
          continue;
        }
        throw error;
      }
    }
    logEvent(es, "bulk", defaultIndex ?? "*", { operations: items.length, errors });
    return c.json({ took: 5, errors, items });
  });
  app.post("/_bulk", bulk);
  app.put("/_bulk", bulk);
  app.post("/:index/_bulk", bulk);
  app.put("/:index/_bulk", bulk);

  app.put(
    "/:index",
    elasticsearch(es, async (c) => {
      const name = c.req.param("index");
      if (es.indices.findOneBy("name", name))
        throw new EsError(400, "resource_already_exists_exception", `index [${name}/emulate] already exists`, {
          index: name,
          index_uuid: "emulate",
        });
      const body = await readBody(c);
      es.indices.insert({
        name,
        mappings: (body.mappings as Json) ?? { properties: {} },
        settings: (body.settings as Json) ?? { index: { number_of_shards: "1", number_of_replicas: "1" } },
        aliases: Object.keys((body.aliases as Json) ?? {}),
      });
      logEvent(es, "index.created", name, {});
      return c.json({ acknowledged: true, shards_acknowledged: true, index: name });
    }),
  );

  app.delete(
    "/:index",
    elasticsearch(es, (c) => {
      const indices = resolveIndices(es, c.req.param("index"));
      for (const name of indices) {
        for (const doc of es.documents.findBy("index", name)) es.documents.delete(doc.id);
        const index = es.indices.findOneBy("name", name);
        if (index) es.indices.delete(index.id);
      }
      logEvent(es, "index.deleted", c.req.param("index"), { count: indices.length });
      return c.json({ acknowledged: true });
    }),
  );

  app.get(
    "/:index",
    elasticsearch(es, (c) => {
      const indices = resolveIndices(es, c.req.param("index"));
      return c.json(
        Object.fromEntries(
          indices.map((name) => {
            const index = es.indices.findOneBy("name", name)!;
            return [
              name,
              {
                aliases: Object.fromEntries(index.aliases.map((alias) => [alias, {}])),
                mappings: index.mappings,
                settings: index.settings,
              },
            ];
          }),
        ),
      );
    }),
  );

  app.get(
    "/:index/_mapping",
    elasticsearch(es, (c) =>
      c.json(
        Object.fromEntries(
          resolveIndices(es, c.req.param("index")).map((name) => [
            name,
            { mappings: es.indices.findOneBy("name", name)!.mappings },
          ]),
        ),
      ),
    ),
  );
  app.post(
    "/:index/_refresh",
    elasticsearch(es, (c) => c.json({ _shards: { total: 2, successful: 1, failed: 0 } })),
  );
  app.post(
    "/_refresh",
    elasticsearch(es, (c) => c.json({ _shards: { total: 2, successful: 1, failed: 0 } })),
  );

  app.get(
    "/_cat/indices",
    elasticsearch(es, (c) => {
      const rows = es.indices.all().map((index) => ({
        health: "green",
        status: "open",
        index: index.name,
        uuid: "emulate",
        pri: "1",
        rep: "1",
        "docs.count": String(es.documents.findBy("index", index.name).length),
        "docs.deleted": "0",
        "store.size": "1kb",
        "pri.store.size": "1kb",
      }));
      if (c.req.query("format") === "json") return c.json(rows);
      return c.text(
        rows
          .map(
            (row) =>
              `${row.health} ${row.status} ${row.index} ${row.uuid} ${row.pri} ${row.rep} ${row["docs.count"]} 0 1kb 1kb`,
          )
          .join("\n"),
      );
    }),
  );

  app.get(
    "/_cluster/health",
    elasticsearch(es, (c) =>
      c.json({
        cluster_name: cluster(es).name,
        status: "green",
        timed_out: false,
        number_of_nodes: 1,
        number_of_data_nodes: 1,
        active_primary_shards: es.indices.count(),
        active_shards: es.indices.count(),
        relocating_shards: 0,
        initializing_shards: 0,
        unassigned_shards: 0,
        delayed_unassigned_shards: 0,
        number_of_pending_tasks: 0,
        number_of_in_flight_fetch: 0,
        task_max_waiting_in_queue_millis: 0,
        active_shards_percent_as_number: 100,
      }),
    ),
  );
  app.get(
    "/_cluster/state",
    elasticsearch(es, (c) =>
      c.json({
        cluster_name: cluster(es).name,
        cluster_uuid: cluster(es).uuid,
        metadata: { indices: Object.fromEntries(es.indices.all().map((index) => [index.name, { state: "open" }])) },
      }),
    ),
  );
  app.get(
    "/_security/_authenticate",
    elasticsearch(es, (c, key) =>
      c.json({
        username: key.name,
        roles: ["superuser"],
        full_name: key.name,
        email: null,
        metadata: {},
        enabled: true,
        authentication_realm: { name: "_es_api_key", type: "_es_api_key" },
        lookup_realm: { name: "_es_api_key", type: "_es_api_key" },
        authentication_type: "api_key",
        api_key: { id: key.key_id, name: key.name },
      }),
    ),
  );
  app.get(
    "/_xpack",
    elasticsearch(es, (c) =>
      c.json({
        build: { hash: "emulate", date: "2026-01-01T00:00:00.000Z" },
        license: { uid: "emulate", type: "trial", mode: "trial", status: "active" },
        features: { security: { available: true, enabled: true } },
        tagline: "You know, for X",
      }),
    ),
  );
}

function bool(value: string | undefined): boolean {
  return value === "true";
}
