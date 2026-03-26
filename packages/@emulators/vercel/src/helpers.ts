import { randomBytes } from "crypto";
import type { Context } from "hono";
import type { VercelUser, VercelTeam, VercelProject, VercelDeployment, VercelDomain, VercelEnvVar, VercelDeploymentAlias, VercelBuild } from "./entities.js";
import type { VercelStore } from "./store.js";

export function generateUid(prefix = ""): string {
  const id = randomBytes(12).toString("base64url").slice(0, 20);
  return prefix ? `${prefix}_${id}` : id;
}

export function generateSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function nowMs(): number {
  return Date.now();
}

export function resolveTeamScope(c: Context, vs: VercelStore): { accountId: string; team: VercelTeam | null } | null {
  const teamId = c.req.query("teamId");
  const slug = c.req.query("slug");

  if (teamId) {
    const team = vs.teams.findOneBy("uid", teamId);
    if (!team) return null;
    return { accountId: team.uid, team };
  }

  if (slug) {
    const team = vs.teams.findOneBy("slug", slug);
    if (!team) return null;
    return { accountId: team.uid, team };
  }

  const authUser = c.get("authUser") as { login: string; id: number } | undefined;
  if (!authUser) return null;

  const user = vs.users.findOneBy("username", authUser.login);
  if (!user) return null;

  return { accountId: user.uid, team: null };
}

export function lookupProject(vs: VercelStore, idOrName: string, accountId: string): VercelProject | undefined {
  let project = vs.projects.findOneBy("uid", idOrName);
  if (project && project.accountId === accountId) return project;

  const byName = vs.projects.findBy("name", idOrName);
  return byName.find((p) => p.accountId === accountId);
}

export interface CursorPagination {
  limit: number;
  since?: number;
  until?: number;
  from?: number;
}

export function parseCursorPagination(c: Context): CursorPagination {
  return {
    limit: Math.min(100, Math.max(1, parseInt(c.req.query("limit") ?? "20", 10) || 20)),
    since: c.req.query("since") ? parseInt(c.req.query("since")!, 10) : undefined,
    until: c.req.query("until") ? parseInt(c.req.query("until")!, 10) : undefined,
    from: c.req.query("from") ? parseInt(c.req.query("from")!, 10) : undefined,
  };
}

export function applyCursorPagination<T extends { created_at: string }>(
  items: T[],
  pagination: CursorPagination
): { items: T[]; pagination: { count: number; next: number | null; prev: number | null } } {
  let filtered = [...items].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  if (pagination.since !== undefined) {
    filtered = filtered.filter((i) => new Date(i.created_at).getTime() > pagination.since!);
  }
  if (pagination.until !== undefined) {
    filtered = filtered.filter((i) => new Date(i.created_at).getTime() <= pagination.until!);
  }

  const total = filtered.length;
  const limited = filtered.slice(0, pagination.limit);
  const hasNext = total > pagination.limit;

  return {
    items: limited,
    pagination: {
      count: limited.length,
      next: hasNext && limited.length > 0 ? new Date(limited[limited.length - 1].created_at).getTime() : null,
      prev: limited.length > 0 ? new Date(limited[0].created_at).getTime() : null,
    },
  };
}

export function formatUser(user: VercelUser) {
  return {
    id: user.uid,
    email: user.email,
    name: user.name,
    username: user.username,
    avatar: user.avatar,
    defaultTeamId: user.defaultTeamId,
    version: user.version,
    createdAt: new Date(user.created_at).getTime(),
    softBlock: user.softBlock,
    billing: user.billing,
    resourceConfig: user.resourceConfig,
    stagingPrefix: user.stagingPrefix,
  };
}

export function formatTeam(team: VercelTeam) {
  return {
    id: team.uid,
    slug: team.slug,
    name: team.name,
    avatar: team.avatar,
    description: team.description,
    creatorId: team.creatorId,
    createdAt: new Date(team.created_at).getTime(),
    updatedAt: new Date(team.updated_at).getTime(),
    membership: team.membership,
    billing: team.billing,
    resourceConfig: team.resourceConfig,
    stagingPrefix: team.stagingPrefix,
  };
}

export function formatProject(project: VercelProject, baseUrl: string) {
  return {
    accountId: project.accountId,
    autoAssignCustomDomains: project.autoAssignCustomDomains,
    autoAssignCustomDomainsUpdatedBy: project.autoAssignCustomDomainsUpdatedBy,
    buildCommand: project.buildCommand,
    createdAt: new Date(project.created_at).getTime(),
    devCommand: project.devCommand,
    directoryListing: false,
    framework: project.framework,
    gitForkProtection: project.gitForkProtection,
    gitComments: project.gitComments,
    id: project.uid,
    installCommand: project.installCommand,
    name: project.name,
    nodeVersion: project.nodeVersion,
    outputDirectory: project.outputDirectory,
    publicSource: project.publicSource,
    rootDirectory: project.rootDirectory,
    commandForIgnoringBuildStep: project.commandForIgnoringBuildStep,
    serverlessFunctionRegion: project.serverlessFunctionRegion,
    sourceFilesOutsideRootDirectory: project.sourceFilesOutsideRootDirectory,
    updatedAt: new Date(project.updated_at).getTime(),
    live: project.live,
    link: project.link,
    latestDeployments: project.latestDeployments,
    targets: project.targets,
    protectionBypass: project.protectionBypass,
    passwordProtection: project.passwordProtection,
    ssoProtection: project.ssoProtection,
    trustedIps: project.trustedIps,
    connectConfigurationId: project.connectConfigurationId,
    webAnalytics: project.webAnalytics,
    speedInsights: project.speedInsights,
    oidcTokenConfig: project.oidcTokenConfig,
    tier: project.tier,
  };
}

export function formatDeployment(dep: VercelDeployment, vs: VercelStore, baseUrl: string) {
  const project = vs.projects.findOneBy("uid", dep.projectId);
  const creator = vs.users.findOneBy("uid", dep.creatorId);
  const aliases = vs.deploymentAliases.findBy("deploymentId", dep.uid);

  return {
    uid: dep.uid,
    id: dep.uid,
    name: dep.name,
    url: dep.url,
    created: new Date(dep.created_at).getTime(),
    createdAt: new Date(dep.created_at).getTime(),
    source: dep.source,
    state: dep.state,
    readyState: dep.readyState,
    readySubstate: dep.readySubstate,
    type: "LAMBDAS",
    creator: creator ? { uid: creator.uid, email: creator.email, username: creator.username } : null,
    inspectorUrl: dep.inspectorUrl,
    meta: dep.meta,
    target: dep.target,
    aliasAssigned: dep.aliasAssigned,
    aliasError: dep.aliasError,
    buildingAt: dep.buildingAt,
    readyAt: dep.readyAt,
    bootedAt: dep.bootedAt,
    canceledAt: dep.canceledAt,
    errorCode: dep.errorCode,
    errorMessage: dep.errorMessage,
    regions: dep.regions,
    functions: dep.functions,
    routes: dep.routes,
    plan: dep.plan,
    projectId: dep.projectId,
    gitSource: dep.gitSource,
    alias: aliases.map((a) => a.alias),
  };
}

export function formatDeploymentBrief(dep: VercelDeployment, vs: VercelStore) {
  const creator = vs.users.findOneBy("uid", dep.creatorId);
  return {
    uid: dep.uid,
    name: dep.name,
    url: dep.url,
    created: new Date(dep.created_at).getTime(),
    state: dep.state,
    readyState: dep.readyState,
    type: "LAMBDAS",
    creator: creator ? { uid: creator.uid, email: creator.email, username: creator.username } : null,
    meta: dep.meta,
    target: dep.target,
    aliasAssigned: dep.aliasAssigned,
    projectId: dep.projectId,
  };
}

export function formatDomain(domain: VercelDomain) {
  return {
    name: domain.name,
    apexName: domain.apexName,
    projectId: domain.projectId,
    redirect: domain.redirect,
    redirectStatusCode: domain.redirectStatusCode,
    gitBranch: domain.gitBranch,
    customEnvironmentId: domain.customEnvironmentId,
    updatedAt: new Date(domain.updated_at).getTime(),
    createdAt: new Date(domain.created_at).getTime(),
    verified: domain.verified,
    verification: domain.verified ? [] : domain.verification,
  };
}

export function formatEnvVar(env: VercelEnvVar, decrypt = false) {
  return {
    type: env.type,
    id: env.uid,
    key: env.key,
    value: decrypt || env.type === "plain" ? env.value : "",
    target: env.target,
    gitBranch: env.gitBranch,
    customEnvironmentIds: env.customEnvironmentIds,
    configurationId: null,
    createdAt: new Date(env.created_at).getTime(),
    updatedAt: new Date(env.updated_at).getTime(),
    createdBy: null,
    updatedBy: null,
    comment: env.comment ?? "",
  };
}
