import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { RouteContext } from "@emulators/core";
import { ApiError, parseJsonBody } from "@emulators/core";
export { ApiError };
import { getVercelStore } from "../store.js";
import type { VercelStore } from "../store.js";
import type {
  VercelBuild,
  VercelDeployment,
  VercelDeploymentAlias,
  VercelDeploymentEvent,
  VercelDeploymentFile,
  VercelFile,
  VercelProject,
  VercelUser,
} from "../entities.js";
import {
  applyCursorPagination,
  formatDeployment,
  formatDeploymentBrief,
  generateUid,
  lookupProject,
  nowMs,
  parseCursorPagination,
  resolveTeamScope,
} from "../helpers.js";

function vercelErr(c: Context, status: ContentfulStatusCode, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

function normalizeUrlParam(raw: string): string {
  const s = raw.trim();
  if (s.startsWith("http://") || s.startsWith("https://")) {
    try {
      return new URL(s).hostname;
    } catch {
      return s;
    }
  }
  return s;
}

function primaryHostFromBaseUrl(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    if (u.hostname && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") {
      return u.hostname;
    }
  } catch {
    /* ignore */
  }
  return "vercel.app";
}

function deploymentHostname(name: string, uid: string, baseUrl: string): string {
  const slug = `${name}-${uid.slice(4, 12)}`;
  return `${slug}.${primaryHostFromBaseUrl(baseUrl)}`;
}

function productionProjectAlias(projectName: string, baseUrl: string): string {
  return `${projectName}.${primaryHostFromBaseUrl(baseUrl)}`;
}

function findDeploymentByIdOrUrl(vs: VercelStore, idOrUrl: string): VercelDeployment | undefined {
  const raw = idOrUrl.trim();
  const byUid = vs.deployments.findOneBy("uid", raw as VercelDeployment["uid"]);
  if (byUid) return byUid;
  const host = normalizeUrlParam(raw);
  return (
    vs.deployments.findOneBy("url", host as VercelDeployment["url"]) ??
    vs.deployments.findOneBy("url", raw as VercelDeployment["url"])
  );
}

function assertDeploymentAccess(
  vs: VercelStore,
  dep: VercelDeployment,
  accountId: string
): boolean {
  const project = vs.projects.findOneBy("uid", dep.projectId as VercelProject["uid"]);
  return !!project && project.accountId === accountId;
}

function defaultProjectPayload(name: string, accountId: string): Omit<VercelProject, "id" | "created_at" | "updated_at"> {
  return {
    uid: generateUid("prj"),
    name,
    accountId,
    framework: null,
    buildCommand: null,
    devCommand: null,
    installCommand: null,
    outputDirectory: null,
    rootDirectory: null,
    commandForIgnoringBuildStep: null,
    nodeVersion: "20.x",
    serverlessFunctionRegion: null,
    publicSource: false,
    autoAssignCustomDomains: true,
    autoAssignCustomDomainsUpdatedBy: null,
    gitForkProtection: true,
    sourceFilesOutsideRootDirectory: false,
    live: true,
    link: null,
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
  };
}

function resolveOrCreateProject(
  vs: VercelStore,
  accountId: string,
  name: string,
  projectField: unknown
): VercelProject {
  if (typeof projectField === "string" && projectField.trim()) {
    const byId = lookupProject(vs, projectField.trim(), accountId);
    if (byId) return byId;
  }
  const existing = vs.projects
    .findBy("name", name as VercelProject["name"])
    .find((p) => p.accountId === accountId);
  if (existing) return existing;
  return vs.projects.insert(defaultProjectPayload(name, accountId));
}

function targetKey(target: VercelDeployment["target"]): "production" | "preview" | "staging" {
  if (target === "production") return "production";
  if (target === "staging") return "staging";
  return "preview";
}

function upsertProjectDeploymentRefs(vs: VercelStore, projectId: number, dep: VercelDeployment): void {
  const project = vs.projects.get(projectId);
  if (!project) return;
  const createdAt = new Date(dep.created_at).getTime();
  const entry = { id: dep.uid, url: dep.url, state: dep.state, createdAt };
  const latest = [{ ...entry }, ...project.latestDeployments.filter((d) => d.id !== dep.uid)];
  const targets = { ...project.targets };
  targets[targetKey(dep.target)] = { ...entry };
  vs.projects.update(project.id, { latestDeployments: latest, targets });
}

function parseGitSource(raw: unknown): VercelDeployment["gitSource"] {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as Record<string, unknown>;
  return {
    type: typeof g.type === "string" ? g.type : "github",
    ref: typeof g.ref === "string" ? g.ref : "",
    sha: typeof g.sha === "string" ? g.sha : "",
    repoId:
      typeof g.repoId === "string" ? g.repoId : typeof g.repoId === "number" ? String(g.repoId) : "",
    org: typeof g.org === "string" ? g.org : "",
    repo: typeof g.repo === "string" ? g.repo : "",
    message: typeof g.message === "string" ? g.message : "",
    authorName: typeof g.authorName === "string" ? g.authorName : "",
    commitAuthorName: typeof g.commitAuthorName === "string" ? g.commitAuthorName : "",
  };
}

type FileTreeNode = {
  uid: string;
  name: string;
  type: "file" | "directory";
  mode: number;
  size: number;
  contentType: string | null;
  children: FileTreeNode[];
};

function buildFileTreeFromRows(rows: VercelDeploymentFile[], genUid: () => string): FileTreeNode[] {
  if (rows.length === 0) {
    return [
      {
        uid: genUid(),
        name: "/",
        type: "directory",
        mode: 0o40755,
        size: 0,
        contentType: null,
        children: [],
      },
    ];
  }

  const root: FileTreeNode = {
    uid: genUid(),
    name: "/",
    type: "directory",
    mode: 0o40755,
    size: 0,
    contentType: null,
    children: [],
  };

  for (const row of rows) {
    if (row.type !== "file") continue;
    const parts = row.name.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    const fileName = parts.pop()!;
    let current = root;
    for (const part of parts) {
      let dir = current.children.find((c) => c.name === part && c.type === "directory");
      if (!dir) {
        dir = {
          uid: genUid(),
          name: part,
          type: "directory",
          mode: 0o40755,
          size: 0,
          contentType: null,
          children: [],
        };
        current.children.push(dir);
      }
      current = dir;
    }
    current.children.push({
      uid: row.uid,
      name: fileName,
      type: "file",
      mode: row.mode,
      size: row.size,
      contentType: row.contentType,
      children: [],
    });
  }

  return [root];
}

function deleteDeploymentCascade(vs: VercelStore, dep: VercelDeployment): void {
  const uid = dep.uid;
  for (const b of vs.builds.findBy("deploymentId", uid as VercelBuild["deploymentId"])) {
    vs.builds.delete(b.id);
  }
  for (const e of vs.deploymentEvents.findBy("deploymentId", uid as VercelDeploymentEvent["deploymentId"])) {
    vs.deploymentEvents.delete(e.id);
  }
  for (const f of vs.deploymentFiles.findBy("deploymentId", uid as VercelDeploymentFile["deploymentId"])) {
    vs.deploymentFiles.delete(f.id);
  }
  for (const a of vs.deploymentAliases.findBy("deploymentId", uid as VercelDeploymentAlias["deploymentId"])) {
    vs.deploymentAliases.delete(a.id);
  }
  vs.deployments.delete(dep.id);

  const project = vs.projects.findOneBy("uid", dep.projectId as VercelProject["uid"]);
  if (project) {
    const latestDeployments = project.latestDeployments.filter((d) => d.id !== uid);
    const targets = { ...project.targets };
    for (const k of Object.keys(targets) as (keyof typeof targets)[]) {
      if (targets[k]?.id === uid) {
        delete targets[k];
      }
    }
    vs.projects.update(project.id, { latestDeployments, targets });
  }
}

export function deploymentsRoutes({ app, store, baseUrl }: RouteContext): void {
  const vs = getVercelStore(store);

  app.patch("/v12/deployments/:id/cancel", async (c) => {
    const auth = c.get("authUser");
    if (!auth) {
      return vercelErr(c, 401, "not_authenticated", "Authentication required");
    }

    const scope = resolveTeamScope(c, vs);
    if (!scope) {
      return vercelErr(c, 400, "bad_request", "Could not resolve team or account scope");
    }

    const dep = vs.deployments.findOneBy("uid", c.req.param("id") as VercelDeployment["uid"]);
    if (!dep || !assertDeploymentAccess(vs, dep, scope.accountId)) {
      return vercelErr(c, 404, "not_found", "Deployment not found");
    }

    if (dep.readyState !== "QUEUED" && dep.readyState !== "BUILDING") {
      return vercelErr(c, 400, "bad_request", "Deployment cannot be canceled in its current state");
    }

    const t = nowMs();
    const updated =
      vs.deployments.update(dep.id, {
        readyState: "CANCELED",
        state: "CANCELED",
        canceledAt: t,
      }) ?? dep;

    vs.deploymentEvents.insert({
      deploymentId: updated.uid,
      type: "canceled",
      payload: { text: "Deployment canceled" },
      date: t,
      serial: String(t),
    });

    return c.json(formatDeployment(updated, vs, baseUrl));
  });

  app.get("/v2/deployments/:id/aliases", (c) => {
    const scope = resolveTeamScope(c, vs);
    if (!scope) {
      return vercelErr(c, 401, "not_authenticated", "Authentication required");
    }

    const dep = vs.deployments.findOneBy("uid", c.req.param("id") as VercelDeployment["uid"]);
    if (!dep || !assertDeploymentAccess(vs, dep, scope.accountId)) {
      return vercelErr(c, 404, "not_found", "Deployment not found");
    }

    const aliases = vs.deploymentAliases.findBy("deploymentId", dep.uid as VercelDeploymentAlias["deploymentId"]);
    return c.json({
      aliases: aliases.map((a) => ({
        uid: a.uid,
        alias: a.alias,
        deploymentId: a.deploymentId,
        projectId: a.projectId,
      })),
    });
  });

  app.get("/v3/deployments/:idOrUrl/events", (c) => {
    const scope = resolveTeamScope(c, vs);
    if (!scope) {
      return vercelErr(c, 401, "not_authenticated", "Authentication required");
    }

    const dep = findDeploymentByIdOrUrl(vs, c.req.param("idOrUrl"));
    if (!dep || !assertDeploymentAccess(vs, dep, scope.accountId)) {
      return vercelErr(c, 404, "not_found", "Deployment not found");
    }

    void c.req.query("follow");

    const direction = (c.req.query("direction") ?? "backward").toLowerCase();
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") ?? "20", 10) || 20));

    let list = [...vs.deploymentEvents.findBy("deploymentId", dep.uid as VercelDeploymentEvent["deploymentId"])];
    list.sort((a, b) => a.date - b.date);
    if (direction === "backward") {
      list.reverse();
    }
    list = list.slice(0, limit);

    return c.json(
      list.map((e) => ({
        type: e.type,
        payload: e.payload,
        date: e.date,
        serial: e.serial,
      }))
    );
  });

  app.get("/v6/deployments/:id/files", (c) => {
    const scope = resolveTeamScope(c, vs);
    if (!scope) {
      return vercelErr(c, 401, "not_authenticated", "Authentication required");
    }

    const dep = vs.deployments.findOneBy("uid", c.req.param("id") as VercelDeployment["uid"]);
    if (!dep || !assertDeploymentAccess(vs, dep, scope.accountId)) {
      return vercelErr(c, 404, "not_found", "Deployment not found");
    }

    const rows = vs.deploymentFiles.findBy("deploymentId", dep.uid as VercelDeploymentFile["deploymentId"]);
    const tree = buildFileTreeFromRows(rows, () => generateUid("file"));
    return c.json({ files: tree });
  });

  app.post("/v13/deployments", async (c) => {
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

    const user = vs.users.findOneBy("username", auth.login as VercelUser["username"]);
    if (!user) {
      return vercelErr(c, 400, "bad_request", "User not found in Vercel store");
    }

    const project = resolveOrCreateProject(vs, scope.accountId, name, body.project);

    const uid = generateUid("dpl");
    const url = deploymentHostname(name, uid, baseUrl);
    const inspectorUrl = `${baseUrl.replace(/\/$/, "")}/deployments/${uid}`;

    const targetRaw = body.target;
    const target: VercelDeployment["target"] =
      targetRaw === "production" || targetRaw === "preview" || targetRaw === "staging"
        ? targetRaw
        : "preview";

    const meta: Record<string, string> = {};
    if (body.meta && typeof body.meta === "object" && body.meta !== null) {
      for (const [k, v] of Object.entries(body.meta as Record<string, unknown>)) {
        if (typeof v === "string") meta[k] = v;
      }
    }

    const regions =
      Array.isArray(body.regions) && body.regions.every((r) => typeof r === "string")
        ? (body.regions as string[])
        : ["iad1"];

    const t = nowMs();
    const gitSource = parseGitSource(body.gitSource);
    const source = gitSource ? "git" : "cli";

    const dep = vs.deployments.insert({
      uid,
      name,
      url,
      projectId: project.uid,
      source,
      target,
      readyState: "READY",
      readySubstate: null,
      state: "READY",
      creatorId: user.uid,
      inspectorUrl,
      meta,
      gitSource,
      buildingAt: t,
      readyAt: t,
      canceledAt: null,
      errorCode: null,
      errorMessage: null,
      regions,
      functions: null,
      routes: null,
      plan: "hobby",
      aliasAssigned: true,
      aliasError: null,
      bootedAt: t,
    });

    vs.deploymentAliases.insert({
      uid: generateUid("als"),
      alias: url,
      deploymentId: dep.uid,
      projectId: project.uid,
    });

    if (target === "production") {
      vs.deploymentAliases.insert({
        uid: generateUid("als"),
        alias: productionProjectAlias(project.name, baseUrl),
        deploymentId: dep.uid,
        projectId: project.uid,
      });
    }

    upsertProjectDeploymentRefs(vs, project.id, dep);

    vs.builds.insert({
      uid: generateUid("bld"),
      deploymentId: dep.uid,
      entrypoint: "api/index.ts",
      readyState: "READY",
      output: [],
      readyStateAt: t,
      fingerprint: generateUid("fgp"),
    });

    let serial = 0;
    const pushEvent = (type: string, text: string) => {
      serial += 1;
      vs.deploymentEvents.insert({
        deploymentId: dep.uid,
        type,
        payload: { text },
        date: t,
        serial: String(serial),
      });
    };
    pushEvent("created", "Deployment created");
    pushEvent("building", "Building");
    pushEvent("ready", "Deployment ready");

    const filesIn = body.files;
    if (Array.isArray(filesIn)) {
      for (const raw of filesIn) {
        if (!raw || typeof raw !== "object") continue;
        const f = raw as Record<string, unknown>;
        const filePath = typeof f.file === "string" ? f.file : "";
        const sha = typeof f.sha === "string" ? f.sha : "";
        const size = typeof f.size === "number" ? f.size : 0;
        if (!filePath || !sha) continue;

        if (!vs.files.findOneBy("digest", sha as VercelFile["digest"])) {
          vs.files.insert({
            digest: sha,
            size,
            contentType: "application/octet-stream",
          });
        }

        vs.deploymentFiles.insert({
          deploymentId: dep.uid,
          name: filePath,
          type: "file",
          uid: generateUid("f"),
          children: [],
          contentType: "application/octet-stream",
          mode: 0o644,
          size,
        });
      }
    }

    return c.json(formatDeployment(dep, vs, baseUrl));
  });

  app.get("/v6/deployments", (c) => {
    const scope = resolveTeamScope(c, vs);
    if (!scope) {
      return vercelErr(c, 401, "not_authenticated", "Authentication required");
    }

    const appName = (c.req.query("app") ?? "").trim();
    const projectIdFilter = (c.req.query("projectId") ?? "").trim();
    const targetFilter = c.req.query("target");
    const stateFilter = c.req.query("state");

    let list = vs.deployments.all().filter((d) => {
      const proj = vs.projects.findOneBy("uid", d.projectId as VercelProject["uid"]);
      return proj && proj.accountId === scope.accountId;
    });

    if (appName) {
      list = list.filter((d) => {
        const proj = vs.projects.findOneBy("uid", d.projectId as VercelProject["uid"]);
        return proj?.name === appName;
      });
    }

    if (projectIdFilter) {
      list = list.filter((d) => d.projectId === projectIdFilter);
    }

    if (targetFilter === "production" || targetFilter === "preview" || targetFilter === "staging") {
      list = list.filter((d) => d.target === targetFilter);
    }

    if (stateFilter) {
      list = list.filter((d) => d.state === stateFilter || d.readyState === stateFilter);
    }

    const pagination = parseCursorPagination(c);
    const { items, pagination: pageMeta } = applyCursorPagination(list, pagination);

    return c.json({
      deployments: items.map((d) => formatDeploymentBrief(d, vs)),
      pagination: pageMeta,
    });
  });

  app.delete("/v13/deployments/:id", (c) => {
    const auth = c.get("authUser");
    if (!auth) {
      return vercelErr(c, 401, "not_authenticated", "Authentication required");
    }

    const scope = resolveTeamScope(c, vs);
    if (!scope) {
      return vercelErr(c, 400, "bad_request", "Could not resolve team or account scope");
    }

    const dep = vs.deployments.findOneBy("uid", c.req.param("id") as VercelDeployment["uid"]);
    if (!dep || !assertDeploymentAccess(vs, dep, scope.accountId)) {
      return vercelErr(c, 404, "not_found", "Deployment not found");
    }

    const uid = dep.uid;
    deleteDeploymentCascade(vs, dep);

    return c.json({ uid, state: "DELETED" });
  });

  app.get("/v13/deployments/:idOrUrl", (c) => {
    const scope = resolveTeamScope(c, vs);
    if (!scope) {
      return vercelErr(c, 401, "not_authenticated", "Authentication required");
    }

    const dep = findDeploymentByIdOrUrl(vs, c.req.param("idOrUrl"));
    if (!dep || !assertDeploymentAccess(vs, dep, scope.accountId)) {
      return vercelErr(c, 404, "not_found", "Deployment not found");
    }

    return c.json(formatDeployment(dep, vs, baseUrl));
  });

  app.post("/v2/files", async (c) => {
    const auth = c.get("authUser");
    if (!auth) {
      return vercelErr(c, 401, "not_authenticated", "Authentication required");
    }

    const digest = c.req.header("x-vercel-digest") ?? "";
    if (!digest) {
      return vercelErr(c, 400, "bad_request", "Missing x-vercel-digest header");
    }

    const lenRaw = c.req.header("Content-Length");
    const size = lenRaw ? parseInt(lenRaw, 10) : 0;
    if (!Number.isFinite(size) || size < 0) {
      return vercelErr(c, 400, "bad_request", "Invalid Content-Length");
    }

    await c.req.arrayBuffer();

    const contentType = c.req.header("Content-Type") ?? "application/octet-stream";

    if (!vs.files.findOneBy("digest", digest as VercelFile["digest"])) {
      vs.files.insert({
        digest,
        size,
        contentType,
      });
    }

    return c.json([]);
  });
}
