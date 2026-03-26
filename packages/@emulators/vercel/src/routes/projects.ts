import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { RouteContext } from "@emulators/core";
import { ApiError, parseJsonBody } from "@emulators/core";
export { ApiError };
import { getVercelStore } from "../store.js";
import type { VercelStore } from "../store.js";
import type {
  VercelDeployment,
  VercelDeploymentAlias,
  VercelDeploymentEvent,
  VercelDeploymentFile,
  VercelDomain,
  VercelEnvVar,
  VercelProject,
  VercelProtectionBypass,
  VercelBuild,
  VercelUser,
} from "../entities.js";
import {
  applyCursorPagination,
  formatEnvVar,
  formatProject,
  generateSecret,
  generateUid,
  lookupProject,
  nowMs,
  parseCursorPagination,
  resolveTeamScope,
} from "../helpers.js";

function vercelErr(c: Context, status: ContentfulStatusCode, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

function parseGitLink(body: Record<string, unknown>): VercelProject["link"] {
  const gr = body.gitRepository;
  if (!gr || typeof gr !== "object") return null;
  const g = gr as Record<string, unknown>;
  const repo = typeof g.repo === "string" ? g.repo : "";
  if (!repo) return null;
  const t = nowMs();
  return {
    type: typeof g.type === "string" ? g.type : "github",
    repo,
    repoId: typeof g.repoId === "number" ? g.repoId : 0,
    org: typeof g.org === "string" ? g.org : "",
    gitCredentialId: typeof g.gitCredentialId === "string" ? g.gitCredentialId : "",
    productionBranch: typeof g.productionBranch === "string" ? g.productionBranch : "main",
    createdAt: t,
    updatedAt: t,
    deployHooks: [],
  };
}

function deleteProjectCascade(vs: VercelStore, project: VercelProject): void {
  const projectUid = project.uid;

  const deps = vs.deployments.findBy("projectId", projectUid as VercelDeployment["projectId"]);
  for (const dep of deps) {
    for (const b of vs.builds.findBy("deploymentId", dep.uid as VercelBuild["deploymentId"])) {
      vs.builds.delete(b.id);
    }
    for (const e of vs.deploymentEvents.findBy("deploymentId", dep.uid as VercelDeploymentEvent["deploymentId"])) {
      vs.deploymentEvents.delete(e.id);
    }
    for (const f of vs.deploymentFiles.findBy("deploymentId", dep.uid as VercelDeploymentFile["deploymentId"])) {
      vs.deploymentFiles.delete(f.id);
    }
    for (const a of vs.deploymentAliases.findBy("deploymentId", dep.uid as VercelDeploymentAlias["deploymentId"])) {
      vs.deploymentAliases.delete(a.id);
    }
    vs.deployments.delete(dep.id);
  }

  for (const d of vs.domains.findBy("projectId", projectUid as VercelDomain["projectId"])) {
    vs.domains.delete(d.id);
  }
  for (const ev of vs.envVars.findBy("projectId", projectUid as VercelEnvVar["projectId"])) {
    vs.envVars.delete(ev.id);
  }
  for (const pb of vs.protectionBypasses.findBy("projectId", projectUid as VercelProtectionBypass["projectId"])) {
    vs.protectionBypasses.delete(pb.id);
  }
  vs.projects.delete(project.id);
}

function protectionMetaForRow(
  row: VercelProtectionBypass
): { createdAt: number; createdBy: string; scope: string } {
  return {
    createdAt: new Date(row.created_at).getTime(),
    createdBy: row.createdBy,
    scope: row.scope,
  };
}

function syncProtectionRecordFromCollection(vs: VercelStore, project: VercelProject): VercelProject {
  const rows = vs.protectionBypasses.findBy("projectId", project.uid as VercelProtectionBypass["projectId"]);
  const record: VercelProject["protectionBypass"] = {};
  for (const row of rows) {
    record[row.secret] = protectionMetaForRow(row);
  }
  const updated = vs.projects.update(project.id, { protectionBypass: record });
  return updated ?? { ...project, protectionBypass: record };
}

export function projectsRoutes({ app, store, baseUrl }: RouteContext): void {
  const vs = getVercelStore(store);

  app.post("/v11/projects", async (c) => {
    const auth = c.get("authUser");
    if (!auth) {
      return vercelErr(c, 401, "not_authenticated", "Authentication required");
    }

    const scope = resolveTeamScope(c, vs);
    if (!scope) {
      return vercelErr(c, 400, "bad_request", "Could not resolve team or account scope");
    }

    const body = await parseJsonBody(c);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return vercelErr(c, 400, "bad_request", "Missing required field: name");
    }

    const existing = vs.projects.findBy("name", name as VercelProject["name"]).filter((p) => p.accountId === scope.accountId);
    if (existing.length > 0) {
      return vercelErr(c, 409, "project_already_exists", "A project with this name already exists");
    }

    const link = parseGitLink(body);

    const project = vs.projects.insert({
      uid: generateUid("prj"),
      name,
      accountId: scope.accountId,
      framework: typeof body.framework === "string" ? body.framework : null,
      buildCommand: typeof body.buildCommand === "string" ? body.buildCommand : null,
      devCommand: typeof body.devCommand === "string" ? body.devCommand : null,
      installCommand: typeof body.installCommand === "string" ? body.installCommand : null,
      outputDirectory: typeof body.outputDirectory === "string" ? body.outputDirectory : null,
      rootDirectory: typeof body.rootDirectory === "string" ? body.rootDirectory : null,
      commandForIgnoringBuildStep: null,
      nodeVersion: typeof body.nodeVersion === "string" ? body.nodeVersion : "20.x",
      serverlessFunctionRegion:
        typeof body.serverlessFunctionRegion === "string" ? body.serverlessFunctionRegion : null,
      publicSource: typeof body.publicSource === "boolean" ? body.publicSource : false,
      autoAssignCustomDomains: true,
      autoAssignCustomDomainsUpdatedBy: null,
      gitForkProtection: true,
      sourceFilesOutsideRootDirectory: false,
      live: true,
      link,
      latestDeployments: [],
      targets: {},
      protectionBypass: {},
      passwordProtection: null,
      ssoProtection: null,
      trustedIps: null,
      connectConfigurationId: null,
      gitComments: { onPullRequest: true, onCommit: false },
      webAnalytics: null,
      speedInsights: null,
      oidcTokenConfig: null,
      tier: "hobby",
    });

    const envIn = body.environmentVariables;
    if (Array.isArray(envIn)) {
      for (const raw of envIn) {
        if (!raw || typeof raw !== "object") continue;
        const ev = raw as Record<string, unknown>;
        const key = typeof ev.key === "string" ? ev.key : "";
        if (!key) continue;
        vs.envVars.insert({
          uid: generateUid("env"),
          projectId: project.uid,
          key,
          value: typeof ev.value === "string" ? ev.value : String(ev.value ?? ""),
          type:
            ev.type === "system" ||
            ev.type === "encrypted" ||
            ev.type === "plain" ||
            ev.type === "secret" ||
            ev.type === "sensitive"
              ? ev.type
              : "encrypted",
          target: Array.isArray(ev.target)
            ? (ev.target.filter((t) => t === "production" || t === "preview" || t === "development") as VercelEnvVar["target"])
            : ["production", "preview", "development"],
          gitBranch: typeof ev.gitBranch === "string" ? ev.gitBranch : null,
          customEnvironmentIds: Array.isArray(ev.customEnvironmentIds) ? (ev.customEnvironmentIds as string[]) : [],
          comment: typeof ev.comment === "string" ? ev.comment : null,
          decrypted: false,
        });
      }
    }

    return c.json(formatProject(project, baseUrl));
  });

  app.get("/v10/projects", (c) => {
    const scope = resolveTeamScope(c, vs);
    if (!scope) {
      return vercelErr(c, 401, "not_authenticated", "Authentication required");
    }

    const pagination = parseCursorPagination(c);
    const search = (c.req.query("search") ?? "").trim().toLowerCase();

    let list = vs.projects.all().filter((p) => p.accountId === scope.accountId);
    if (search) {
      list = list.filter((p) => p.name.toLowerCase().includes(search));
    }

    const { items, pagination: pageMeta } = applyCursorPagination(list, pagination);
    return c.json({
      projects: items.map((p) => formatProject(p, baseUrl)),
      pagination: pageMeta,
    });
  });

  app.get("/v9/projects/:idOrName", (c) => {
    const scope = resolveTeamScope(c, vs);
    if (!scope) {
      return vercelErr(c, 401, "not_authenticated", "Authentication required");
    }

    const project = lookupProject(vs, c.req.param("idOrName"), scope.accountId);
    if (!project) {
      return vercelErr(c, 404, "not_found", "Project not found");
    }

    const envs = vs.envVars.findBy("projectId", project.uid as VercelEnvVar["projectId"]);
    return c.json({
      ...formatProject(project, baseUrl),
      env: envs.map((e) => formatEnvVar(e)),
    });
  });

  app.patch("/v9/projects/:idOrName", async (c) => {
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
    const patch: Partial<VercelProject> = {};

    if ("name" in body && typeof body.name === "string") patch.name = body.name.trim();
    if ("buildCommand" in body) {
      patch.buildCommand = body.buildCommand === null ? null : typeof body.buildCommand === "string" ? body.buildCommand : project.buildCommand;
    }
    if ("devCommand" in body) {
      patch.devCommand = body.devCommand === null ? null : typeof body.devCommand === "string" ? body.devCommand : project.devCommand;
    }
    if ("installCommand" in body) {
      patch.installCommand =
        body.installCommand === null ? null : typeof body.installCommand === "string" ? body.installCommand : project.installCommand;
    }
    if ("outputDirectory" in body) {
      patch.outputDirectory =
        body.outputDirectory === null ? null : typeof body.outputDirectory === "string" ? body.outputDirectory : project.outputDirectory;
    }
    if ("framework" in body) {
      patch.framework = body.framework === null ? null : typeof body.framework === "string" ? body.framework : project.framework;
    }
    if ("rootDirectory" in body) {
      patch.rootDirectory =
        body.rootDirectory === null ? null : typeof body.rootDirectory === "string" ? body.rootDirectory : project.rootDirectory;
    }
    if ("gitForkProtection" in body && typeof body.gitForkProtection === "boolean") {
      patch.gitForkProtection = body.gitForkProtection;
    }
    if ("publicSource" in body && typeof body.publicSource === "boolean") {
      patch.publicSource = body.publicSource;
    }
    if ("nodeVersion" in body && typeof body.nodeVersion === "string") {
      patch.nodeVersion = body.nodeVersion;
    }
    if ("serverlessFunctionRegion" in body) {
      patch.serverlessFunctionRegion =
        body.serverlessFunctionRegion === null
          ? null
          : typeof body.serverlessFunctionRegion === "string"
            ? body.serverlessFunctionRegion
            : project.serverlessFunctionRegion;
    }
    if ("autoAssignCustomDomains" in body && typeof body.autoAssignCustomDomains === "boolean") {
      patch.autoAssignCustomDomains = body.autoAssignCustomDomains;
    }
    if ("commandForIgnoringBuildStep" in body) {
      patch.commandForIgnoringBuildStep =
        body.commandForIgnoringBuildStep === null
          ? null
          : typeof body.commandForIgnoringBuildStep === "string"
            ? body.commandForIgnoringBuildStep
            : project.commandForIgnoringBuildStep;
    }

    const updated = vs.projects.update(project.id, patch);
    if (!updated) {
      return vercelErr(c, 500, "internal_error", "Failed to update project");
    }
    return c.json(formatProject(updated, baseUrl));
  });

  app.delete("/v9/projects/:idOrName", (c) => {
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

    deleteProjectCascade(vs, project);
    return c.body(null, 204);
  });

  app.get("/v1/projects/:projectId/promote/aliases", (c) => {
    const scope = resolveTeamScope(c, vs);
    if (!scope) {
      return vercelErr(c, 401, "not_authenticated", "Authentication required");
    }

    const project = lookupProject(vs, c.req.param("projectId"), scope.accountId);
    if (!project) {
      return vercelErr(c, 404, "not_found", "Project not found");
    }

    const deployments = vs.deployments.findBy("projectId", project.uid as VercelDeployment["projectId"]);
    const production = deployments
      .filter((d) => d.target === "production")
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];

    if (!production) {
      return c.json({
        status: "PENDING",
        alias: [] as string[],
      });
    }

    const aliases = vs.deploymentAliases
      .findBy("deploymentId", production.uid as VercelDeploymentAlias["deploymentId"])
      .map((a) => a.alias);

    const status =
      production.readySubstate === "PROMOTED" || production.readyState === "READY" ? "PROMOTED" : "PENDING";

    return c.json({
      status,
      alias: aliases,
    });
  });

  app.patch("/v1/projects/:idOrName/protection-bypass", async (c) => {
    const auth = c.get("authUser");
    if (!auth) {
      return vercelErr(c, 401, "not_authenticated", "Authentication required");
    }

    const scope = resolveTeamScope(c, vs);
    if (!scope) {
      return vercelErr(c, 400, "bad_request", "Could not resolve team or account scope");
    }

    let project = lookupProject(vs, c.req.param("idOrName"), scope.accountId);
    if (!project) {
      return vercelErr(c, 404, "not_found", "Project not found");
    }

    const user = vs.users.findOneBy("username", auth.login as VercelUser["username"]);
    const createdBy = user?.uid ?? auth.login;

    const body = await parseJsonBody(c);

    if (body.generate && typeof body.generate === "object" && body.generate !== null) {
      const g = body.generate as Record<string, unknown>;
      const secret = generateSecret();
      vs.protectionBypasses.insert({
        projectId: project.uid,
        secret,
        note: typeof g.note === "string" ? g.note : null,
        scope: typeof g.scope === "string" ? g.scope : "deployment",
        createdBy,
      });
      project = syncProtectionRecordFromCollection(vs, project);
    }

    if (Array.isArray(body.revoke)) {
      for (const secret of body.revoke) {
        if (typeof secret !== "string") continue;
        const row = vs.protectionBypasses
          .findBy("projectId", project.uid as VercelProtectionBypass["projectId"])
          .find((r) => r.secret === secret);
        if (row) {
          vs.protectionBypasses.delete(row.id);
        }
      }
      project = syncProtectionRecordFromCollection(vs, project);
    }

    if (Array.isArray(body.regenerate)) {
      for (const oldSecret of body.regenerate) {
        if (typeof oldSecret !== "string") continue;
        const row = vs.protectionBypasses
          .findBy("projectId", project.uid as VercelProtectionBypass["projectId"])
          .find((r) => r.secret === oldSecret);
        if (!row) continue;
        const note = row.note;
        const scopeVal = row.scope;
        vs.protectionBypasses.delete(row.id);
        vs.protectionBypasses.insert({
          projectId: project.uid,
          secret: generateSecret(),
          note,
          scope: scopeVal,
          createdBy,
        });
      }
      project = syncProtectionRecordFromCollection(vs, project);
    }

    const fresh = vs.projects.get(project.id) ?? project;
    return c.json({ protectionBypass: fresh.protectionBypass });
  });
}
