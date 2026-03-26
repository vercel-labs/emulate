import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { RouteContext } from "@emulators/core";
import { ApiError, parseJsonBody } from "@emulators/core";
export { ApiError };
import { getVercelStore } from "../store.js";
import type { VercelStore } from "../store.js";
import type { VercelEnvVar } from "../entities.js";
import {
  applyCursorPagination,
  formatEnvVar,
  generateUid,
  lookupProject,
  parseCursorPagination,
  resolveTeamScope,
} from "../helpers.js";

const ENV_TYPES = new Set<VercelEnvVar["type"]>(["system", "encrypted", "plain", "secret", "sensitive"]);

const TARGET_ENVS: readonly VercelEnvVar["target"][number][] = ["production", "preview", "development"];

function isTargetEnv(t: string): t is VercelEnvVar["target"][number] {
  return (TARGET_ENVS as readonly string[]).includes(t);
}

function vercelErr(c: Context, status: ContentfulStatusCode, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

function parseQueryBoolean(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

function targetsOverlap(
  a: VercelEnvVar["target"],
  b: VercelEnvVar["target"]
): boolean {
  const set = new Set(a);
  return b.some((t) => set.has(t));
}

function findEnvByKeyAndTargetsOverlap(
  vs: VercelStore,
  projectUid: string,
  key: string,
  targets: VercelEnvVar["target"],
  excludeId?: number
): VercelEnvVar | undefined {
  const list = vs.envVars.findBy("projectId", projectUid as VercelEnvVar["projectId"]);
  return list.find(
    (e) =>
      e.key === key &&
      (excludeId === undefined || e.id !== excludeId) &&
      targetsOverlap(e.target, targets)
  );
}

function parseTarget(raw: unknown): VercelEnvVar["target"] | "invalid" {
  if (!Array.isArray(raw) || raw.length === 0) return "invalid";
  const out: VercelEnvVar["target"] = [];
  for (const t of raw) {
    if (typeof t !== "string" || !isTargetEnv(t)) return "invalid";
    out.push(t);
  }
  return out;
}

function parseType(raw: unknown): VercelEnvVar["type"] | "invalid" {
  if (typeof raw !== "string" || !ENV_TYPES.has(raw as VercelEnvVar["type"])) return "invalid";
  return raw as VercelEnvVar["type"];
}

function parseCustomEnvironmentIds(raw: unknown): string[] | "invalid" {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return "invalid";
  const ids: string[] = [];
  for (const x of raw) {
    if (typeof x !== "string") return "invalid";
    ids.push(x);
  }
  return ids;
}

function parseEnvRow(
  body: Record<string, unknown>
): { row: Omit<VercelEnvVar, "id" | "uid" | "projectId" | "created_at" | "updated_at">; error: string | null } {
  const key = typeof body.key === "string" ? body.key : "";
  if (!key.trim()) {
    return { row: {} as never, error: "Missing required field: key" };
  }

  if (body.value === undefined) {
    return { row: {} as never, error: "Missing required field: value" };
  }
  if (typeof body.value !== "string") {
    return { row: {} as never, error: "Invalid value: value must be a string" };
  }

  const type = parseType(body.type);
  if (type === "invalid") {
    return { row: {} as never, error: "Invalid value: type must be one of system, encrypted, plain, secret, sensitive" };
  }

  const target = parseTarget(body.target);
  if (target === "invalid") {
    return { row: {} as never, error: "Invalid value: target must be a non-empty array of production, preview, development" };
  }

  const customEnvironmentIds = parseCustomEnvironmentIds(body.customEnvironmentIds);
  if (customEnvironmentIds === "invalid") {
    return { row: {} as never, error: "Invalid value: customEnvironmentIds must be an array of strings" };
  }

  let gitBranch: string | null;
  if (!("gitBranch" in body)) {
    gitBranch = null;
  } else if (body.gitBranch === null) {
    gitBranch = null;
  } else if (typeof body.gitBranch === "string") {
    gitBranch = body.gitBranch;
  } else {
    return { row: {} as never, error: "Invalid value: gitBranch must be a string or null" };
  }

  let comment: string | null;
  if (!("comment" in body)) {
    comment = null;
  } else if (body.comment === null) {
    comment = null;
  } else if (typeof body.comment === "string") {
    comment = body.comment;
  } else {
    return { row: {} as never, error: "Invalid value: comment must be a string or null" };
  }

  return {
    row: {
      key,
      value: body.value,
      type,
      target,
      gitBranch,
      customEnvironmentIds,
      comment,
      decrypted: false,
    },
    error: null,
  };
}

function findEnvByUidInProject(
  vs: VercelStore,
  projectUid: string,
  uid: string
): VercelEnvVar | undefined {
  const list = vs.envVars.findBy("projectId", projectUid as VercelEnvVar["projectId"]);
  return list.find((e) => e.uid === uid);
}

export function envRoutes({ app, store }: RouteContext): void {
  const vs = getVercelStore(store);

  app.get("/v10/projects/:idOrName/env", (c) => {
    const scope = resolveTeamScope(c, vs);
    if (!scope) {
      return vercelErr(c, 401, "not_authenticated", "Authentication required");
    }

    const project = lookupProject(vs, c.req.param("idOrName"), scope.accountId);
    if (!project) {
      return vercelErr(c, 404, "not_found", "Project not found");
    }

    const decrypt = parseQueryBoolean(c.req.query("decrypt"));
    const gitBranchQ = c.req.query("gitBranch");
    const customEnvironmentId = c.req.query("customEnvironmentId");
    const customEnvironmentSlug = c.req.query("customEnvironmentSlug");

    let list = vs.envVars.findBy("projectId", project.uid as VercelEnvVar["projectId"]);

    if (gitBranchQ !== undefined) {
      list = list.filter((e) => e.gitBranch === gitBranchQ);
    }
    if (customEnvironmentId !== undefined && customEnvironmentId !== "") {
      list = list.filter((e) => e.customEnvironmentIds.includes(customEnvironmentId));
    }
    if (customEnvironmentSlug !== undefined && customEnvironmentSlug !== "") {
      list = list.filter((e) => e.customEnvironmentIds.includes(customEnvironmentSlug));
    }

    const pagination = parseCursorPagination(c);
    const { items, pagination: pageMeta } = applyCursorPagination(list, pagination);
    return c.json({
      envs: items.map((i) => formatEnvVar(i, decrypt)),
      pagination: pageMeta,
    });
  });

  app.post("/v10/projects/:idOrName/env", async (c) => {
    const auth = c.get("authUser");
    if (!auth) {
      return vercelErr(c, 401, "not_authenticated", "Authentication required");
    }

    const scope = resolveTeamScope(c, vs);
    if (!scope) {
      return vercelErr(c, 400, "bad_request", "Could not resolve team or account scope");
    }

    const project = lookupProject(vs, c.req.param("idOrName"), scope.accountId);
    if (!project) {
      return vercelErr(c, 404, "not_found", "Project not found");
    }

    const upsert = parseQueryBoolean(c.req.query("upsert"));
    const rawBody = await c.req.json().catch(() => null);

    let items: Record<string, unknown>[] = [];
    if (Array.isArray(rawBody)) {
      items = rawBody as Record<string, unknown>[];
    } else if (rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)) {
      items = [rawBody as Record<string, unknown>];
    } else {
      return vercelErr(c, 400, "bad_request", "Invalid JSON body");
    }

    const created: VercelEnvVar[] = [];
    const pending: VercelEnvVar[] = [];

    for (const body of items) {
      const parsed = parseEnvRow(body);
      if (parsed.error) {
        return vercelErr(c, 400, "bad_request", parsed.error);
      }
      const { row } = parsed;

      const existingDb = findEnvByKeyAndTargetsOverlap(vs, project.uid, row.key, row.target);
      const existingPending = pending.find(
        (e) => e.key === row.key && targetsOverlap(e.target, row.target)
      );

      if (upsert) {
        const toUpdate = existingDb ?? existingPending;
        if (toUpdate) {
          const updated = vs.envVars.update(toUpdate.id, {
            key: row.key,
            value: row.value,
            type: row.type,
            target: row.target,
            gitBranch: row.gitBranch,
            customEnvironmentIds: row.customEnvironmentIds,
            comment: row.comment,
          });
          if (!updated) {
            return vercelErr(c, 500, "internal_error", "Failed to update environment variable");
          }
          const idx = pending.findIndex((p) => p.id === updated.id);
          if (idx >= 0) pending[idx] = updated;
          else pending.push(updated);
          created.push(updated);
          continue;
        }
      } else {
        if (existingDb || existingPending) {
          return vercelErr(
            c,
            409,
            "env_already_exists",
            `An environment variable with key "${row.key}" and overlapping targets already exists`
          );
        }
      }

      const inserted = vs.envVars.insert({
        uid: generateUid("env"),
        projectId: project.uid,
        key: row.key,
        value: row.value,
        type: row.type,
        target: row.target,
        gitBranch: row.gitBranch,
        customEnvironmentIds: row.customEnvironmentIds,
        comment: row.comment,
        decrypted: row.decrypted,
      });
      pending.push(inserted);
      created.push(inserted);
    }

    return c.json({ envs: created.map((e) => formatEnvVar(e, true)) });
  });

  app.get("/v10/projects/:idOrName/env/:id", (c) => {
    const scope = resolveTeamScope(c, vs);
    if (!scope) {
      return vercelErr(c, 401, "not_authenticated", "Authentication required");
    }

    const project = lookupProject(vs, c.req.param("idOrName"), scope.accountId);
    if (!project) {
      return vercelErr(c, 404, "not_found", "Project not found");
    }

    const env = findEnvByUidInProject(vs, project.uid, c.req.param("id"));
    if (!env) {
      return vercelErr(c, 404, "not_found", "Environment variable not found");
    }

    const decrypt = parseQueryBoolean(c.req.query("decrypt"));
    return c.json(formatEnvVar(env, decrypt));
  });

  app.patch("/v9/projects/:idOrName/env/:id", async (c) => {
    const auth = c.get("authUser");
    if (!auth) {
      return vercelErr(c, 401, "not_authenticated", "Authentication required");
    }

    const scope = resolveTeamScope(c, vs);
    if (!scope) {
      return vercelErr(c, 400, "bad_request", "Could not resolve team or account scope");
    }

    const project = lookupProject(vs, c.req.param("idOrName"), scope.accountId);
    if (!project) {
      return vercelErr(c, 404, "not_found", "Project not found");
    }

    const existing = findEnvByUidInProject(vs, project.uid, c.req.param("id"));
    if (!existing) {
      return vercelErr(c, 404, "not_found", "Environment variable not found");
    }

    const body = await parseJsonBody(c);
    const patch: Partial<
      Pick<VercelEnvVar, "key" | "value" | "type" | "target" | "gitBranch" | "customEnvironmentIds" | "comment">
    > = {};

    if ("key" in body) {
      if (typeof body.key !== "string" || !body.key.trim()) {
        return vercelErr(c, 400, "bad_request", "Invalid value: key must be a non-empty string");
      }
      patch.key = body.key;
    }
    if ("value" in body) {
      if (typeof body.value !== "string") {
        return vercelErr(c, 400, "bad_request", "Invalid value: value must be a string");
      }
      patch.value = body.value;
    }
    if ("type" in body) {
      const t = parseType(body.type);
      if (t === "invalid") {
        return vercelErr(c, 400, "bad_request", "Invalid value: type must be one of system, encrypted, plain, secret, sensitive");
      }
      patch.type = t;
    }
    if ("target" in body) {
      const t = parseTarget(body.target);
      if (t === "invalid") {
        return vercelErr(c, 400, "bad_request", "Invalid value: target must be a non-empty array of production, preview, development");
      }
      patch.target = t;
    }
    if ("gitBranch" in body) {
      if (body.gitBranch === null) {
        patch.gitBranch = null;
      } else if (typeof body.gitBranch === "string") {
        patch.gitBranch = body.gitBranch;
      } else {
        return vercelErr(c, 400, "bad_request", "Invalid value: gitBranch must be a string or null");
      }
    }
    if ("customEnvironmentIds" in body) {
      const ids = parseCustomEnvironmentIds(body.customEnvironmentIds);
      if (ids === "invalid") {
        return vercelErr(c, 400, "bad_request", "Invalid value: customEnvironmentIds must be an array of strings");
      }
      patch.customEnvironmentIds = ids;
    }
    if ("comment" in body) {
      if (body.comment === null) {
        patch.comment = null;
      } else if (typeof body.comment === "string") {
        patch.comment = body.comment;
      } else {
        return vercelErr(c, 400, "bad_request", "Invalid value: comment must be a string or null");
      }
    }

    const nextKey = patch.key ?? existing.key;
    const nextTarget = patch.target ?? existing.target;

    const conflict = findEnvByKeyAndTargetsOverlap(vs, project.uid, nextKey, nextTarget, existing.id);
    if (conflict) {
      return vercelErr(
        c,
        409,
        "env_already_exists",
        `An environment variable with key "${nextKey}" and overlapping targets already exists`
      );
    }

    const updated = vs.envVars.update(existing.id, patch);
    if (!updated) {
      return vercelErr(c, 500, "internal_error", "Failed to update environment variable");
    }
    return c.json(formatEnvVar(updated, true));
  });

  app.delete("/v9/projects/:idOrName/env/:id", (c) => {
    const auth = c.get("authUser");
    if (!auth) {
      return vercelErr(c, 401, "not_authenticated", "Authentication required");
    }

    const scope = resolveTeamScope(c, vs);
    if (!scope) {
      return vercelErr(c, 400, "bad_request", "Could not resolve team or account scope");
    }

    const project = lookupProject(vs, c.req.param("idOrName"), scope.accountId);
    if (!project) {
      return vercelErr(c, 404, "not_found", "Project not found");
    }

    const existing = findEnvByUidInProject(vs, project.uid, c.req.param("id"));
    if (!existing) {
      return vercelErr(c, 404, "not_found", "Environment variable not found");
    }

    const snapshot = formatEnvVar(existing, true);
    vs.envVars.delete(existing.id);
    return c.json(snapshot, 200);
  });
}
