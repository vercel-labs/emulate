import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { RouteContext } from "@emulators/core";
import { ApiError, parseJsonBody } from "@emulators/core";
export { ApiError };
import { getVercelStore } from "../store.js";
import type { VercelStore } from "../store.js";
import type { VercelDomain } from "../entities.js";
import {
  applyCursorPagination,
  formatDomain,
  generateUid,
  lookupProject,
  parseCursorPagination,
  resolveTeamScope,
} from "../helpers.js";

function vercelErr(c: Context, status: ContentfulStatusCode, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

function extractApexName(domain: string): string {
  const parts = domain.toLowerCase().split(".").filter((p) => p.length > 0);
  if (parts.length === 0) return domain;
  if (parts.length === 1) return parts[0];
  return parts.slice(-2).join(".");
}

function isVercelAppDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return d === "vercel.app" || d.endsWith(".vercel.app");
}

function normalizeDomainName(raw: string): string {
  return raw.trim().toLowerCase();
}

function parseRedirectStatusCode(raw: unknown): 301 | 302 | 307 | 308 | null | "invalid" {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isInteger(raw)) return "invalid";
  if (raw === 301 || raw === 302 || raw === 307 || raw === 308) return raw;
  return "invalid";
}

function findDomainInProject(
  vs: VercelStore,
  projectUid: string,
  domainName: string
): VercelDomain | undefined {
  const normalized = normalizeDomainName(domainName);
  return vs.domains
    .findBy("projectId", projectUid as VercelDomain["projectId"])
    .find((d) => d.name.toLowerCase() === normalized);
}

function decodeDomainParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function domainsRoutes({ app, store }: RouteContext): void {
  const vs = getVercelStore(store);

  app.post("/v10/projects/:idOrName/domains", async (c) => {
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

    const body = await parseJsonBody(c);
    const nameRaw = typeof body.name === "string" ? body.name.trim() : "";
    if (!nameRaw) {
      return vercelErr(c, 400, "bad_request", "Missing required field: name");
    }

    const name = normalizeDomainName(nameRaw);
    const apexName = extractApexName(name);

    if (findDomainInProject(vs, project.uid, name)) {
      return vercelErr(c, 409, "domain_already_exists", "A domain with this name already exists on the project");
    }

    const redirect =
      body.redirect === null ? null : typeof body.redirect === "string" ? body.redirect.trim() || null : null;
    const redirectStatusCode = parseRedirectStatusCode(body.redirectStatusCode);
    if (redirectStatusCode === "invalid") {
      return vercelErr(c, 400, "bad_request", "Invalid redirectStatusCode");
    }

    const gitBranch =
      body.gitBranch === null ? null : typeof body.gitBranch === "string" ? body.gitBranch : null;
    const customEnvironmentId =
      body.customEnvironmentId === null
        ? null
        : typeof body.customEnvironmentId === "string"
          ? body.customEnvironmentId
          : null;

    const uid = generateUid();
    const autoVerified = isVercelAppDomain(name);
    const verified = autoVerified;
    const verification: VercelDomain["verification"] = autoVerified
      ? []
      : [
          {
            type: "TXT",
            domain: `_vercel.${apexName}`,
            value: `vc-domain-verify=${name},${uid}`,
            reason: "Add the TXT record above to verify domain ownership",
          },
        ];

    const row = vs.domains.insert({
      uid,
      projectId: project.uid,
      name,
      apexName,
      redirect,
      redirectStatusCode,
      gitBranch,
      customEnvironmentId,
      verified,
      verification,
    });

    return c.json(formatDomain(row));
  });

  app.get("/v9/projects/:idOrName/domains", (c) => {
    const scope = resolveTeamScope(c, vs);
    if (!scope) {
      return vercelErr(c, 401, "not_authenticated", "Authentication required");
    }

    const project = lookupProject(vs, c.req.param("idOrName"), scope.accountId);
    if (!project) {
      return vercelErr(c, 404, "not_found", "Project not found");
    }

    const pagination = parseCursorPagination(c);
    const list = vs.domains.findBy("projectId", project.uid as VercelDomain["projectId"]);
    const { items, pagination: pageMeta } = applyCursorPagination(list, pagination);
    return c.json({
      domains: items.map((d) => formatDomain(d)),
      pagination: pageMeta,
    });
  });

  app.post("/v9/projects/:idOrName/domains/:domain/verify", (c) => {
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

    const domainName = decodeDomainParam(c.req.param("domain"));
    const existing = findDomainInProject(vs, project.uid, domainName);
    if (!existing) {
      return vercelErr(c, 404, "not_found", "Domain not found");
    }

    const updated = vs.domains.update(existing.id, {
      verified: true,
      verification: [],
    });
    if (!updated) {
      return vercelErr(c, 500, "internal_error", "Failed to update domain");
    }
    return c.json(formatDomain(updated));
  });

  app.get("/v9/projects/:idOrName/domains/:domain", (c) => {
    const scope = resolveTeamScope(c, vs);
    if (!scope) {
      return vercelErr(c, 401, "not_authenticated", "Authentication required");
    }

    const project = lookupProject(vs, c.req.param("idOrName"), scope.accountId);
    if (!project) {
      return vercelErr(c, 404, "not_found", "Project not found");
    }

    const domainName = decodeDomainParam(c.req.param("domain"));
    const existing = findDomainInProject(vs, project.uid, domainName);
    if (!existing) {
      return vercelErr(c, 404, "not_found", "Domain not found");
    }

    return c.json(formatDomain(existing));
  });

  app.patch("/v9/projects/:idOrName/domains/:domain", async (c) => {
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

    const domainName = decodeDomainParam(c.req.param("domain"));
    const existing = findDomainInProject(vs, project.uid, domainName);
    if (!existing) {
      return vercelErr(c, 404, "not_found", "Domain not found");
    }

    const body = await parseJsonBody(c);
    const patch: Partial<Omit<VercelDomain, "id" | "created_at" | "updated_at">> = {};

    if ("gitBranch" in body) {
      patch.gitBranch =
        body.gitBranch === null ? null : typeof body.gitBranch === "string" ? body.gitBranch : existing.gitBranch;
    }
    if ("redirect" in body) {
      patch.redirect =
        body.redirect === null ? null : typeof body.redirect === "string" ? body.redirect.trim() || null : existing.redirect;
    }
    if ("redirectStatusCode" in body) {
      const code = parseRedirectStatusCode(body.redirectStatusCode);
      if (code === "invalid") {
        return vercelErr(c, 400, "bad_request", "Invalid redirectStatusCode");
      }
      patch.redirectStatusCode = code;
    }
    if ("customEnvironmentId" in body) {
      patch.customEnvironmentId =
        body.customEnvironmentId === null
          ? null
          : typeof body.customEnvironmentId === "string"
            ? body.customEnvironmentId
            : existing.customEnvironmentId;
    }

    const updated = vs.domains.update(existing.id, patch);
    if (!updated) {
      return vercelErr(c, 500, "internal_error", "Failed to update domain");
    }
    return c.json(formatDomain(updated));
  });

  app.delete("/v9/projects/:idOrName/domains/:domain", (c) => {
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

    const domainName = decodeDomainParam(c.req.param("domain"));
    const existing = findDomainInProject(vs, project.uid, domainName);
    if (!existing) {
      return vercelErr(c, 404, "not_found", "Domain not found");
    }

    vs.domains.delete(existing.id);
    return c.json({}, 200);
  });
}
