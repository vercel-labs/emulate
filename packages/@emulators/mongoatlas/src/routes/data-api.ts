import type { RouteContext } from "@emulators/core";
import { getMongoAtlasStore } from "../store.js";
import { generateObjectId, mongoOk, mongoError } from "../helpers.js";

/**
 * MongoDB Atlas Data API endpoints.
 * These emulate the Atlas Data API v1 for CRUD operations on documents.
 * See: https://www.mongodb.com/docs/atlas/api/data-api-resources/
 */
export function dataApiRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ms = () => getMongoAtlasStore(store);

  // Find a single document
  app.post("/app/data-api/v1/action/findOne", async (c) => {
    const body = await c.req.json<{
      dataSource?: string;
      database?: string;
      collection?: string;
      filter?: Record<string, unknown>;
      projection?: Record<string, unknown>;
    }>();

    if (!body.dataSource || !body.database || !body.collection) {
      return mongoError(c, "InvalidParameter", "dataSource, database, and collection are required");
    }

    const cluster = ms().clusters.findOneBy("name", body.dataSource);
    if (!cluster) {
      return mongoError(c, "ClusterNotFound", `Cluster '${body.dataSource}' not found`, 404);
    }

    const docs = ms()
      .documents.all()
      .filter(
        (d) => d.cluster_id === cluster.cluster_id && d.database === body.database && d.collection === body.collection,
      );

    const matched = matchFilter(docs, body.filter) ?? docs;
    const doc = matched[0] ?? null;
    const projected = doc ? applyProjection(doc.data, body.projection) : null;

    return mongoOk(c, { document: projected });
  });

  // Find multiple documents
  app.post("/app/data-api/v1/action/find", async (c) => {
    const body = await c.req.json<{
      dataSource?: string;
      database?: string;
      collection?: string;
      filter?: Record<string, unknown>;
      projection?: Record<string, unknown>;
      sort?: Record<string, number>;
      limit?: number;
      skip?: number;
    }>();

    if (!body.dataSource || !body.database || !body.collection) {
      return mongoError(c, "InvalidParameter", "dataSource, database, and collection are required");
    }

    const cluster = ms().clusters.findOneBy("name", body.dataSource);
    if (!cluster) {
      return mongoError(c, "ClusterNotFound", `Cluster '${body.dataSource}' not found`, 404);
    }

    let docs = ms()
      .documents.all()
      .filter(
        (d) => d.cluster_id === cluster.cluster_id && d.database === body.database && d.collection === body.collection,
      );

    docs = matchFilter(docs, body.filter) ?? docs;

    if (body.sort) {
      docs = sortBySpec(docs, body.sort, (d) => d.data);
    }

    if (body.skip) {
      docs = docs.slice(body.skip);
    }

    if (body.limit) {
      docs = docs.slice(0, body.limit);
    }

    const documents = docs.map((d) => applyProjection(d.data, body.projection));
    return mongoOk(c, { documents });
  });

  // Insert a single document
  app.post("/app/data-api/v1/action/insertOne", async (c) => {
    const body = await c.req.json<{
      dataSource?: string;
      database?: string;
      collection?: string;
      document?: Record<string, unknown>;
    }>();

    if (!body.dataSource || !body.database || !body.collection || !body.document) {
      return mongoError(c, "InvalidParameter", "dataSource, database, collection, and document are required");
    }

    const cluster = ms().clusters.findOneBy("name", body.dataSource);
    if (!cluster) {
      return mongoError(c, "ClusterNotFound", `Cluster '${body.dataSource}' not found`, 404);
    }

    ensureCollectionExists(ms, cluster.cluster_id, body.database, body.collection);

    const docId = (body.document._id as string) ?? generateObjectId();
    const data = { ...body.document, _id: docId };

    ms().documents.insert({
      cluster_id: cluster.cluster_id,
      database: body.database,
      collection: body.collection,
      doc_id: docId,
      data,
    });

    return mongoOk(c, { insertedId: docId }, 201);
  });

  // Insert multiple documents
  app.post("/app/data-api/v1/action/insertMany", async (c) => {
    const body = await c.req.json<{
      dataSource?: string;
      database?: string;
      collection?: string;
      documents?: Array<Record<string, unknown>>;
    }>();

    if (!body.dataSource || !body.database || !body.collection || !body.documents) {
      return mongoError(c, "InvalidParameter", "dataSource, database, collection, and documents are required");
    }

    const cluster = ms().clusters.findOneBy("name", body.dataSource);
    if (!cluster) {
      return mongoError(c, "ClusterNotFound", `Cluster '${body.dataSource}' not found`, 404);
    }

    ensureCollectionExists(ms, cluster.cluster_id, body.database, body.collection);

    const insertedIds: string[] = [];
    for (const doc of body.documents) {
      const docId = (doc._id as string) ?? generateObjectId();
      const data = { ...doc, _id: docId };

      ms().documents.insert({
        cluster_id: cluster.cluster_id,
        database: body.database,
        collection: body.collection,
        doc_id: docId,
        data,
      });
      insertedIds.push(docId);
    }

    return mongoOk(c, { insertedIds }, 201);
  });

  // Update a single document
  app.post("/app/data-api/v1/action/updateOne", async (c) => {
    const body = await c.req.json<{
      dataSource?: string;
      database?: string;
      collection?: string;
      filter?: Record<string, unknown>;
      update?: Record<string, unknown>;
      upsert?: boolean;
    }>();

    if (!body.dataSource || !body.database || !body.collection || !body.update) {
      return mongoError(c, "InvalidParameter", "dataSource, database, collection, and update are required");
    }

    const cluster = ms().clusters.findOneBy("name", body.dataSource);
    if (!cluster) {
      return mongoError(c, "ClusterNotFound", `Cluster '${body.dataSource}' not found`, 404);
    }

    const docs = ms()
      .documents.all()
      .filter(
        (d) => d.cluster_id === cluster.cluster_id && d.database === body.database && d.collection === body.collection,
      );

    const matched = matchFilter(docs, body.filter) ?? docs;
    const doc = matched[0];

    if (doc) {
      const updatedData = applyUpdate(doc.data, body.update);
      ms().documents.update(doc.id, { data: updatedData });
      return mongoOk(c, { matchedCount: 1, modifiedCount: 1 });
    }

    if (body.upsert) {
      ensureCollectionExists(ms, cluster.cluster_id, body.database, body.collection);
      const docId = generateObjectId();
      const baseDoc = extractEqualityFields(body.filter ?? {});
      const data = applyUpdate({ _id: docId, ...baseDoc }, body.update);
      ms().documents.insert({
        cluster_id: cluster.cluster_id,
        database: body.database,
        collection: body.collection,
        doc_id: docId,
        data,
      });
      return mongoOk(c, { matchedCount: 0, modifiedCount: 0, upsertedId: docId });
    }

    return mongoOk(c, { matchedCount: 0, modifiedCount: 0 });
  });

  // Update multiple documents
  app.post("/app/data-api/v1/action/updateMany", async (c) => {
    const body = await c.req.json<{
      dataSource?: string;
      database?: string;
      collection?: string;
      filter?: Record<string, unknown>;
      update?: Record<string, unknown>;
      upsert?: boolean;
    }>();

    if (!body.dataSource || !body.database || !body.collection || !body.update) {
      return mongoError(c, "InvalidParameter", "dataSource, database, collection, and update are required");
    }

    const cluster = ms().clusters.findOneBy("name", body.dataSource);
    if (!cluster) {
      return mongoError(c, "ClusterNotFound", `Cluster '${body.dataSource}' not found`, 404);
    }

    const docs = ms()
      .documents.all()
      .filter(
        (d) => d.cluster_id === cluster.cluster_id && d.database === body.database && d.collection === body.collection,
      );

    const matched = matchFilter(docs, body.filter) ?? docs;
    let modifiedCount = 0;

    for (const doc of matched) {
      const updatedData = applyUpdate(doc.data, body.update);
      ms().documents.update(doc.id, { data: updatedData });
      modifiedCount++;
    }

    if (matched.length === 0 && body.upsert) {
      ensureCollectionExists(ms, cluster.cluster_id, body.database, body.collection);
      const docId = generateObjectId();
      const baseDoc = extractEqualityFields(body.filter ?? {});
      const data = applyUpdate({ _id: docId, ...baseDoc }, body.update);
      ms().documents.insert({
        cluster_id: cluster.cluster_id,
        database: body.database,
        collection: body.collection,
        doc_id: docId,
        data,
      });
      return mongoOk(c, { matchedCount: 0, modifiedCount: 0, upsertedId: docId });
    }

    return mongoOk(c, { matchedCount: matched.length, modifiedCount });
  });

  // Delete a single document
  app.post("/app/data-api/v1/action/deleteOne", async (c) => {
    const body = await c.req.json<{
      dataSource?: string;
      database?: string;
      collection?: string;
      filter?: Record<string, unknown>;
    }>();

    if (!body.dataSource || !body.database || !body.collection) {
      return mongoError(c, "InvalidParameter", "dataSource, database, and collection are required");
    }

    const cluster = ms().clusters.findOneBy("name", body.dataSource);
    if (!cluster) {
      return mongoError(c, "ClusterNotFound", `Cluster '${body.dataSource}' not found`, 404);
    }

    const docs = ms()
      .documents.all()
      .filter(
        (d) => d.cluster_id === cluster.cluster_id && d.database === body.database && d.collection === body.collection,
      );

    const matched = matchFilter(docs, body.filter) ?? docs;
    const doc = matched[0];

    if (doc) {
      ms().documents.delete(doc.id);
      return mongoOk(c, { deletedCount: 1 });
    }

    return mongoOk(c, { deletedCount: 0 });
  });

  // Delete multiple documents
  app.post("/app/data-api/v1/action/deleteMany", async (c) => {
    const body = await c.req.json<{
      dataSource?: string;
      database?: string;
      collection?: string;
      filter?: Record<string, unknown>;
    }>();

    if (!body.dataSource || !body.database || !body.collection) {
      return mongoError(c, "InvalidParameter", "dataSource, database, and collection are required");
    }

    const cluster = ms().clusters.findOneBy("name", body.dataSource);
    if (!cluster) {
      return mongoError(c, "ClusterNotFound", `Cluster '${body.dataSource}' not found`, 404);
    }

    const docs = ms()
      .documents.all()
      .filter(
        (d) => d.cluster_id === cluster.cluster_id && d.database === body.database && d.collection === body.collection,
      );

    const matched = matchFilter(docs, body.filter) ?? docs;
    let deletedCount = 0;

    for (const doc of matched) {
      ms().documents.delete(doc.id);
      deletedCount++;
    }

    return mongoOk(c, { deletedCount });
  });

  // Aggregate (simplified)
  app.post("/app/data-api/v1/action/aggregate", async (c) => {
    const body = await c.req.json<{
      dataSource?: string;
      database?: string;
      collection?: string;
      pipeline?: Array<Record<string, unknown>>;
    }>();

    if (!body.dataSource || !body.database || !body.collection) {
      return mongoError(c, "InvalidParameter", "dataSource, database, and collection are required");
    }

    const cluster = ms().clusters.findOneBy("name", body.dataSource);
    if (!cluster) {
      return mongoError(c, "ClusterNotFound", `Cluster '${body.dataSource}' not found`, 404);
    }

    const docs = ms()
      .documents.all()
      .filter(
        (d) => d.cluster_id === cluster.cluster_id && d.database === body.database && d.collection === body.collection,
      );

    // Process simplified pipeline stages
    const pipeline = body.pipeline ?? [];
    let results: Record<string, unknown>[] = docs.map((d) => d.data);

    for (const stage of pipeline) {
      if ("$match" in stage) {
        const filter = stage.$match as Record<string, unknown>;
        results = results.filter((d) => matchesFilter(d, filter));
      } else if ("$limit" in stage) {
        results = results.slice(0, stage.$limit as number);
      } else if ("$skip" in stage) {
        results = results.slice(stage.$skip as number);
      } else if ("$sort" in stage) {
        const sortSpec = stage.$sort as Record<string, number>;
        results = sortBySpec(results, sortSpec, (d) => d);
      } else if ("$project" in stage) {
        const projection = stage.$project as Record<string, unknown>;
        results = results.map((d) => applyProjection(d, projection));
      } else if ("$count" in stage) {
        const fieldName = stage.$count as string;
        results = [{ [fieldName]: results.length }];
      }
    }

    return mongoOk(c, { documents: results });
  });
}

type MongoAtlasDocEntity = { data: Record<string, unknown>; id: number };

function ensureCollectionExists(
  ms: () => ReturnType<typeof getMongoAtlasStore>,
  clusterId: string,
  database: string,
  collection: string,
): void {
  const existing = ms()
    .collections.all()
    .find((col) => col.cluster_id === clusterId && col.database === database && col.name === collection);
  if (!existing) {
    // Auto-create database entry if needed
    const dbExists = ms()
      .databases.all()
      .find((db) => db.cluster_id === clusterId && db.name === database);
    if (!dbExists) {
      ms().databases.insert({ cluster_id: clusterId, name: database });
    }
    ms().collections.insert({ cluster_id: clusterId, database, name: collection });
  }
}

function matchesFilter(data: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (key === "$and") {
      const conditions = value as Record<string, unknown>[];
      if (!conditions.every((cond) => matchesFilter(data, cond))) return false;
      continue;
    }
    if (key === "$or") {
      const conditions = value as Record<string, unknown>[];
      if (!conditions.some((cond) => matchesFilter(data, cond))) return false;
      continue;
    }
    if (key === "$nor") {
      const conditions = value as Record<string, unknown>[];
      if (conditions.some((cond) => matchesFilter(data, cond))) return false;
      continue;
    }

    const docValue = getNestedValue(data, key);

    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const ops = value as Record<string, unknown>;
      for (const [op, opVal] of Object.entries(ops)) {
        switch (op) {
          case "$eq":
            if (docValue !== opVal) return false;
            break;
          case "$ne":
            if (docValue === opVal) return false;
            break;
          case "$gt":
            if (typeof docValue !== "number" || typeof opVal !== "number" || docValue <= opVal) return false;
            break;
          case "$gte":
            if (typeof docValue !== "number" || typeof opVal !== "number" || docValue < opVal) return false;
            break;
          case "$lt":
            if (typeof docValue !== "number" || typeof opVal !== "number" || docValue >= opVal) return false;
            break;
          case "$lte":
            if (typeof docValue !== "number" || typeof opVal !== "number" || docValue > opVal) return false;
            break;
          case "$in":
            if (!Array.isArray(opVal) || !opVal.includes(docValue)) return false;
            break;
          case "$nin":
            if (!Array.isArray(opVal) || opVal.includes(docValue)) return false;
            break;
          case "$exists":
            if (opVal && docValue === undefined) return false;
            if (!opVal && docValue !== undefined) return false;
            break;
          case "$regex": {
            const pattern = opVal as string;
            const flags = (ops.$options as string) ?? "";
            try {
              if (pattern.length > 1000) return false;
              const re = new RegExp(pattern, flags);
              if (typeof docValue !== "string" || !re.test(docValue)) return false;
            } catch {
              return false;
            }
            break;
          }
        }
      }
    } else {
      if (docValue !== value) return false;
    }
  }
  return true;
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  if (hasDangerousKey(parts)) return undefined;
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function matchFilter<T extends MongoAtlasDocEntity>(docs: T[], filter?: Record<string, unknown>): T[] | null {
  if (!filter || Object.keys(filter).length === 0) return null;
  return docs.filter((d) => matchesFilter(d.data, filter));
}

function applyProjection(data: Record<string, unknown>, projection?: Record<string, unknown>): Record<string, unknown> {
  if (!projection || Object.keys(projection).length === 0) return data;

  const hasInclusions = Object.values(projection).some((v) => v === 1 || v === true);

  if (hasInclusions) {
    const result: Record<string, unknown> = {};
    if (projection._id !== 0 && projection._id !== false) {
      result._id = data._id;
    }
    for (const [key, val] of Object.entries(projection)) {
      if (key === "_id") continue;
      if (val === 1 || val === true) {
        result[key] = data[key];
      }
    }
    return result;
  }

  const result = { ...data };
  for (const [key, val] of Object.entries(projection)) {
    if (val === 0 || val === false) {
      delete result[key];
    }
  }
  return result;
}

function applyUpdate(data: Record<string, unknown>, update: Record<string, unknown>): Record<string, unknown> {
  const result = { ...data };

  if ("$set" in update) {
    const setFields = update.$set as Record<string, unknown>;
    for (const [key, value] of Object.entries(setFields)) {
      setNestedValue(result, key, value);
    }
  }

  if ("$unset" in update) {
    const unsetFields = update.$unset as Record<string, unknown>;
    for (const key of Object.keys(unsetFields)) {
      const parts = key.split(".");
      if (hasDangerousKey(parts)) continue;
      if (parts.length === 1) {
        delete result[key];
      } else {
        let current: Record<string, unknown> = result;
        for (let i = 0; i < parts.length - 1; i++) {
          if (current[parts[i]] === null || current[parts[i]] === undefined || typeof current[parts[i]] !== "object")
            break;
          current = current[parts[i]] as Record<string, unknown>;
        }
        delete current[parts[parts.length - 1]];
      }
    }
  }

  if ("$inc" in update) {
    const incFields = update.$inc as Record<string, number>;
    for (const [key, value] of Object.entries(incFields)) {
      const current = (getNestedValue(result, key) as number) ?? 0;
      setNestedValue(result, key, current + value);
    }
  }

  if ("$push" in update) {
    const pushFields = update.$push as Record<string, unknown>;
    for (const [key, value] of Object.entries(pushFields)) {
      const current = getNestedValue(result, key);
      if (!Array.isArray(current)) {
        setNestedValue(result, key, [value]);
      } else {
        setNestedValue(result, key, [...current, value]);
      }
    }
  }

  if ("$pull" in update) {
    const pullFields = update.$pull as Record<string, unknown>;
    for (const [key, value] of Object.entries(pullFields)) {
      const current = getNestedValue(result, key);
      if (Array.isArray(current)) {
        setNestedValue(
          result,
          key,
          current.filter((item) => item !== value),
        );
      }
    }
  }

  if ("$rename" in update) {
    const renameFields = update.$rename as Record<string, string>;
    for (const [oldKey, newKey] of Object.entries(renameFields)) {
      const oldParts = oldKey.split(".");
      const newParts = newKey.split(".");
      if (hasDangerousKey(oldParts) || hasDangerousKey(newParts)) continue;
      const value = getNestedValue(result, oldKey);
      if (value !== undefined) {
        setNestedValue(result, newKey, value);
        if (oldParts.length === 1) {
          delete result[oldKey];
        } else {
          let current: Record<string, unknown> = result;
          for (let i = 0; i < oldParts.length - 1; i++) {
            if (typeof current[oldParts[i]] !== "object" || current[oldParts[i]] === null) break;
            current = current[oldParts[i]] as Record<string, unknown>;
          }
          delete current[oldParts[oldParts.length - 1]];
        }
      }
    }
  }

  // If no operators found, treat the entire update as a replacement (minus _id)
  const hasOperators = Object.keys(update).some((k) => k.startsWith("$"));
  if (!hasOperators) {
    const id = result._id;
    for (const key of Object.keys(result)) {
      delete result[key];
    }
    result._id = id;
    Object.assign(result, update);
  }

  return result;
}

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function hasDangerousKey(parts: string[]): boolean {
  return parts.some((p) => DANGEROUS_KEYS.has(p));
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  if (hasDangerousKey(parts)) return;
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current) || typeof current[parts[i]] !== "object") {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

function sortBySpec<T>(
  docs: T[],
  sortSpec: Record<string, number>,
  accessor: (doc: T) => Record<string, unknown>,
): T[] {
  return [...docs].sort((a, b) => {
    for (const [key, direction] of Object.entries(sortSpec)) {
      const aVal = getNestedValue(accessor(a), key);
      const bVal = getNestedValue(accessor(b), key);
      if (aVal === bVal) continue;
      if (aVal === undefined) return direction;
      if (bVal === undefined) return -direction;
      if ((aVal as number) < (bVal as number)) return -direction;
      if ((aVal as number) > (bVal as number)) return direction;
    }
    return 0;
  });
}

/**
 * Extract simple equality fields from a filter for use as a base document during upsert.
 * Strips out query operators (keys starting with $) and fields with operator-object values.
 */
function extractEqualityFields(filter: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filter)) {
    if (key.startsWith("$")) continue;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const ops = value as Record<string, unknown>;
      if (Object.keys(ops).some((k) => k.startsWith("$"))) continue;
    }
    result[key] = value;
  }
  return result;
}
