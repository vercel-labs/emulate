import type { RouteContext, AuthUser, WebhookDelivery } from "@emulators/core";
import {
  ApiError,
  forbidden,
  parseJsonBody,
  parsePagination,
  setLinkHeader,
  unauthorized,
} from "@emulators/core";
import { getGitHubStore } from "../store.js";
import type { GitHubStore } from "../store.js";
import type { GitHubOrg, GitHubRepo, GitHubUser, GitHubWebhook } from "../entities.js";
import { formatRepo, formatUser, formatWebhook, lookupRepo } from "../helpers.js";
import {
  assertRepoAdmin,
  getActorUser,
  notFoundResponse,
  ownerLoginOf,
} from "../route-helpers.js";

function teamsForOrg(gh: GitHubStore, orgId: number) {
  return gh.teams.findBy("org_id", orgId);
}

function listOrgMembersDeduped(
  gh: GitHubStore,
  orgId: number
): { user: GitHubUser; orgRole: "admin" | "member" }[] {
  const byUser = new Map<number, { user: GitHubUser; isAdmin: boolean }>();
  for (const team of teamsForOrg(gh, orgId)) {
    for (const m of gh.teamMembers.findBy("team_id", team.id)) {
      const user = gh.users.get(m.user_id);
      if (!user) continue;
      const isAdmin = m.role === "maintainer";
      const prev = byUser.get(user.id);
      if (!prev) {
        byUser.set(user.id, { user, isAdmin });
      } else {
        byUser.set(user.id, { user, isAdmin: prev.isAdmin || isAdmin });
      }
    }
  }
  return [...byUser.values()]
    .map(({ user, isAdmin }) => ({
      user,
      orgRole: isAdmin ? ("admin" as const) : ("member" as const),
    }))
    .sort((a, b) => a.user.id - b.user.id);
}

function orgRoleForUser(gh: GitHubStore, orgId: number, userId: number): "admin" | "member" | null {
  const row = listOrgMembersDeduped(gh, orgId).find((r) => r.user.id === userId);
  return row?.orgRole ?? null;
}

function assertOrgAdmin(gh: GitHubStore, authUser: AuthUser | undefined, org: GitHubOrg) {
  if (!authUser) throw unauthorized();
  const user = getActorUser(gh, authUser);
  if (!user) throw unauthorized();
  if (orgRoleForUser(gh, org.id, user.id) === "admin") return;
  throw forbidden();
}

function getOrgByLogin(gh: GitHubStore, login: string): GitHubOrg | undefined {
  return gh.orgs.findOneBy("login", login);
}

function pathPrefixForWebhook(wh: GitHubWebhook, ownerPath: string): string {
  return wh.repo_id != null ? `repos/${ownerPath}` : `orgs/${ownerPath}`;
}

function findRepoHook(gh: GitHubStore, repoId: number, hookId: number): GitHubWebhook | undefined {
  const wh = gh.webhooks.get(hookId);
  if (!wh || wh.repo_id !== repoId) return undefined;
  return wh;
}

function findOrgHook(gh: GitHubStore, orgId: number, hookId: number): GitHubWebhook | undefined {
  const wh = gh.webhooks.get(hookId);
  if (!wh || wh.org_id !== orgId) return undefined;
  return wh;
}

function webhooksForRepo(gh: GitHubStore, repoId: number): GitHubWebhook[] {
  return gh.webhooks.findBy("repo_id", repoId).filter((w) => w.repo_id === repoId);
}

function webhooksForOrg(gh: GitHubStore, orgId: number): GitHubWebhook[] {
  return gh.webhooks.findBy("org_id", orgId).filter((w) => w.org_id === orgId);
}

function normalizeInsecureSsl(v: unknown): string {
  if (v === true) return "1";
  if (v === false) return "0";
  if (typeof v === "string" && (v === "0" || v === "1")) return v;
  return "0";
}

function parseHookConfig(
  raw: unknown,
  existing?: GitHubWebhook["config"]
): GitHubWebhook["config"] | null {
  if (raw === undefined && existing) return existing;
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const urlRaw = typeof o.url === "string" ? o.url.trim() : "";
  const url = urlRaw || existing?.url || "";
  if (!url) return null;
  const content_type =
    typeof o.content_type === "string" && o.content_type
      ? o.content_type
      : existing?.content_type ?? "json";
  let secret: string | undefined;
  if (o.secret === null) {
    secret = undefined;
  } else if (typeof o.secret === "string") {
    secret = o.secret;
  } else if (existing?.secret !== undefined) {
    secret = existing.secret;
  }
  const insecure_ssl = normalizeInsecureSsl(
    o.insecure_ssl !== undefined ? o.insecure_ssl : (existing?.insecure_ssl ?? "0")
  );
  return { url, content_type, secret, insecure_ssl };
}

function formatHookDelivery(
  d: WebhookDelivery,
  baseUrl: string,
  pathPrefix: string,
  hookId: number
) {
  return {
    id: d.id,
    guid: `${d.hook_id}-${d.id}-${d.delivered_at}`,
    delivered_at: d.delivered_at,
    redelivery: false,
    duration: d.duration,
    status: d.success ? "OK" : "Failed",
    status_code: d.status_code,
    event: d.event,
    action: d.action ?? null,
    url: `${baseUrl}/${pathPrefix}/hooks/${hookId}/deliveries/${d.id}`,
  };
}

export function webhooksRoutes({ app, store, webhooks, baseUrl }: RouteContext): void {
  const gh = getGitHubStore(store);

  // --- Repository webhooks ---

  app.get("/repos/:owner/:repo/hooks", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoAdmin(gh, c.get("authUser"), repo);

    let list = webhooksForRepo(gh, repo.id).sort((a, b) => a.id - b.id);
    const { page, per_page } = parsePagination(c);
    const total = list.length;
    setLinkHeader(c, total, page, per_page);
    const start = (page - 1) * per_page;
    list = list.slice(start, start + per_page);

    const ownerPath = `${owner}/${repoName}`;
    return c.json(list.map((wh) => formatWebhook(wh, baseUrl, ownerPath)));
  });

  app.post("/repos/:owner/:repo/hooks", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoAdmin(gh, c.get("authUser"), repo);

    const body = await parseJsonBody(c);
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "web";
    const events = Array.isArray(body.events)
      ? (body.events as unknown[]).filter((e): e is string => typeof e === "string")
      : ["push"];
    const active = typeof body.active === "boolean" ? body.active : true;
    const config = parseHookConfig(body.config);
    if (!config) throw new ApiError(422, "config.url is required");

    const wh = gh.webhooks.insert({
      repo_id: repo.id,
      org_id: null,
      name,
      active,
      events,
      config,
      last_response: { code: null, status: "unused", message: null },
    });

    webhooks.register({
      id: wh.id,
      url: wh.config.url,
      events: wh.events,
      active: wh.active,
      secret: wh.config.secret,
      owner,
      repo: repo.name,
    });

    const ownerPath = `${owner}/${repoName}`;
    return c.json(formatWebhook(wh, baseUrl, ownerPath), 201);
  });

  app.get("/repos/:owner/:repo/hooks/:hook_id", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const hookId = Number(c.req.param("hook_id"));
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoAdmin(gh, c.get("authUser"), repo);
    if (!Number.isFinite(hookId)) throw notFoundResponse();

    const wh = findRepoHook(gh, repo.id, hookId);
    if (!wh) throw notFoundResponse();

    const ownerPath = `${owner}/${repoName}`;
    return c.json(formatWebhook(wh, baseUrl, ownerPath));
  });

  app.patch("/repos/:owner/:repo/hooks/:hook_id", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const hookId = Number(c.req.param("hook_id"));
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoAdmin(gh, c.get("authUser"), repo);
    if (!Number.isFinite(hookId)) throw notFoundResponse();

    const existing = findRepoHook(gh, repo.id, hookId);
    if (!existing) throw notFoundResponse();

    const body = await parseJsonBody(c);
    const name = typeof body.name === "string" ? body.name.trim() : existing.name;
    const events = Array.isArray(body.events)
      ? (body.events as unknown[]).filter((e): e is string => typeof e === "string")
      : existing.events;
    const active = typeof body.active === "boolean" ? body.active : existing.active;
    const config =
      body.config !== undefined ? parseHookConfig(body.config, existing.config) : existing.config;
    if (!config) throw new ApiError(422, "Invalid config");

    const wh = gh.webhooks.update(hookId, { name, active, events, config })!;
    webhooks.updateSubscription(hookId, {
      url: wh.config.url,
      events: wh.events,
      active: wh.active,
      secret: wh.config.secret,
    });

    const ownerPath = `${owner}/${repoName}`;
    return c.json(formatWebhook(wh, baseUrl, ownerPath));
  });

  app.delete("/repos/:owner/:repo/hooks/:hook_id", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const hookId = Number(c.req.param("hook_id"));
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoAdmin(gh, c.get("authUser"), repo);
    if (!Number.isFinite(hookId)) throw notFoundResponse();

    const wh = findRepoHook(gh, repo.id, hookId);
    if (!wh) throw notFoundResponse();

    webhooks.unregister(hookId);
    gh.webhooks.delete(hookId);
    return c.body(null, 204);
  });

  app.post("/repos/:owner/:repo/hooks/:hook_id/pings", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const hookId = Number(c.req.param("hook_id"));
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoAdmin(gh, c.get("authUser"), repo);
    if (!Number.isFinite(hookId)) throw notFoundResponse();

    const wh = findRepoHook(gh, repo.id, hookId);
    if (!wh) throw notFoundResponse();

    const ownerPath = `${owner}/${repoName}`;
    await webhooks.dispatch(
      "ping",
      undefined,
      {
        zen: "Keep it logically awesome.",
        hook_id: wh.id,
        hook: formatWebhook(wh, baseUrl, ownerPath),
      },
      owner,
      repo.name
    );
    return c.body(null, 204);
  });

  app.post("/repos/:owner/:repo/hooks/:hook_id/tests", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const hookId = Number(c.req.param("hook_id"));
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoAdmin(gh, c.get("authUser"), repo);
    if (!Number.isFinite(hookId)) throw notFoundResponse();

    const wh = findRepoHook(gh, repo.id, hookId);
    if (!wh) throw notFoundResponse();

    const ownerLogin = ownerLoginOf(gh, repo);
    const actor =
      getActorUser(gh, c.get("authUser")!) ?? gh.users.get(repo.owner_id) ?? gh.users.all()[0];
    const testPayload = {
      ref: "refs/heads/main",
      before: "0000000000000000000000000000000000000000",
      after: "0000000000000000000000000000000000000000",
      repository: formatRepo(repo, gh, baseUrl),
      pusher: actor ? formatUser(actor, baseUrl) : null,
      sender: actor ? formatUser(actor, baseUrl) : null,
    };
    await webhooks.dispatch("push", undefined, testPayload, ownerLogin, repo.name);
    return c.body(null, 204);
  });

  app.get("/repos/:owner/:repo/hooks/:hook_id/deliveries", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const hookId = Number(c.req.param("hook_id"));
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoAdmin(gh, c.get("authUser"), repo);
    if (!Number.isFinite(hookId)) throw notFoundResponse();

    const wh = findRepoHook(gh, repo.id, hookId);
    if (!wh) throw notFoundResponse();

    const { page, per_page } = parsePagination(c);
    let list = webhooks.getDeliveries(wh.id).sort((a, b) => b.id - a.id);
    const total = list.length;
    setLinkHeader(c, total, page, per_page);
    const start = (page - 1) * per_page;
    list = list.slice(start, start + per_page);

    const pp = pathPrefixForWebhook(wh, `${owner}/${repoName}`);
    return c.json(list.map((d) => formatHookDelivery(d, baseUrl, pp, wh.id)));
  });

  app.get("/repos/:owner/:repo/hooks/:hook_id/deliveries/:delivery_id", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const hookId = Number(c.req.param("hook_id"));
    const deliveryId = Number(c.req.param("delivery_id"));
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoAdmin(gh, c.get("authUser"), repo);
    if (!Number.isFinite(hookId) || !Number.isFinite(deliveryId)) throw notFoundResponse();

    const wh = findRepoHook(gh, repo.id, hookId);
    if (!wh) throw notFoundResponse();

    const d = webhooks.getDeliveries(wh.id).find((x) => x.id === deliveryId);
    if (!d) throw notFoundResponse();

    const pp = pathPrefixForWebhook(wh, `${owner}/${repoName}`);
    return c.json(formatHookDelivery(d, baseUrl, pp, wh.id));
  });

  // --- Organization webhooks ---

  app.get("/orgs/:org/hooks", (c) => {
    const orgLogin = c.req.param("org")!;
    const org = getOrgByLogin(gh, orgLogin);
    if (!org) throw notFoundResponse();
    assertOrgAdmin(gh, c.get("authUser"), org);

    let list = webhooksForOrg(gh, org.id).sort((a, b) => a.id - b.id);
    const { page, per_page } = parsePagination(c);
    const total = list.length;
    setLinkHeader(c, total, page, per_page);
    const start = (page - 1) * per_page;
    list = list.slice(start, start + per_page);

    return c.json(list.map((wh) => formatWebhook(wh, baseUrl, org.login)));
  });

  app.post("/orgs/:org/hooks", async (c) => {
    const orgLogin = c.req.param("org")!;
    const org = getOrgByLogin(gh, orgLogin);
    if (!org) throw notFoundResponse();
    assertOrgAdmin(gh, c.get("authUser"), org);

    const body = await parseJsonBody(c);
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "web";
    const events = Array.isArray(body.events)
      ? (body.events as unknown[]).filter((e): e is string => typeof e === "string")
      : ["push"];
    const active = typeof body.active === "boolean" ? body.active : true;
    const config = parseHookConfig(body.config);
    if (!config) throw new ApiError(422, "config.url is required");

    const wh = gh.webhooks.insert({
      repo_id: null,
      org_id: org.id,
      name,
      active,
      events,
      config,
      last_response: { code: null, status: "unused", message: null },
    });

    webhooks.register({
      id: wh.id,
      url: wh.config.url,
      events: wh.events,
      active: wh.active,
      secret: wh.config.secret,
      owner: org.login,
      repo: undefined,
    });

    return c.json(formatWebhook(wh, baseUrl, org.login), 201);
  });

  app.get("/orgs/:org/hooks/:hook_id", (c) => {
    const orgLogin = c.req.param("org")!;
    const hookId = Number(c.req.param("hook_id"));
    const org = getOrgByLogin(gh, orgLogin);
    if (!org) throw notFoundResponse();
    assertOrgAdmin(gh, c.get("authUser"), org);
    if (!Number.isFinite(hookId)) throw notFoundResponse();

    const wh = findOrgHook(gh, org.id, hookId);
    if (!wh) throw notFoundResponse();

    return c.json(formatWebhook(wh, baseUrl, org.login));
  });

  app.patch("/orgs/:org/hooks/:hook_id", async (c) => {
    const orgLogin = c.req.param("org")!;
    const hookId = Number(c.req.param("hook_id"));
    const org = getOrgByLogin(gh, orgLogin);
    if (!org) throw notFoundResponse();
    assertOrgAdmin(gh, c.get("authUser"), org);
    if (!Number.isFinite(hookId)) throw notFoundResponse();

    const existing = findOrgHook(gh, org.id, hookId);
    if (!existing) throw notFoundResponse();

    const body = await parseJsonBody(c);
    const name = typeof body.name === "string" ? body.name.trim() : existing.name;
    const events = Array.isArray(body.events)
      ? (body.events as unknown[]).filter((e): e is string => typeof e === "string")
      : existing.events;
    const active = typeof body.active === "boolean" ? body.active : existing.active;
    const config =
      body.config !== undefined ? parseHookConfig(body.config, existing.config) : existing.config;
    if (!config) throw new ApiError(422, "Invalid config");

    const wh = gh.webhooks.update(hookId, { name, active, events, config })!;
    webhooks.updateSubscription(hookId, {
      url: wh.config.url,
      events: wh.events,
      active: wh.active,
      secret: wh.config.secret,
    });

    return c.json(formatWebhook(wh, baseUrl, org.login));
  });

  app.delete("/orgs/:org/hooks/:hook_id", (c) => {
    const orgLogin = c.req.param("org")!;
    const hookId = Number(c.req.param("hook_id"));
    const org = getOrgByLogin(gh, orgLogin);
    if (!org) throw notFoundResponse();
    assertOrgAdmin(gh, c.get("authUser"), org);
    if (!Number.isFinite(hookId)) throw notFoundResponse();

    const wh = findOrgHook(gh, org.id, hookId);
    if (!wh) throw notFoundResponse();

    webhooks.unregister(hookId);
    gh.webhooks.delete(hookId);
    return c.body(null, 204);
  });

  app.post("/orgs/:org/hooks/:hook_id/pings", async (c) => {
    const orgLogin = c.req.param("org")!;
    const hookId = Number(c.req.param("hook_id"));
    const org = getOrgByLogin(gh, orgLogin);
    if (!org) throw notFoundResponse();
    assertOrgAdmin(gh, c.get("authUser"), org);
    if (!Number.isFinite(hookId)) throw notFoundResponse();

    const wh = findOrgHook(gh, org.id, hookId);
    if (!wh) throw notFoundResponse();

    await webhooks.dispatch(
      "ping",
      undefined,
      {
        zen: "Keep it logically awesome.",
        hook_id: wh.id,
        hook: formatWebhook(wh, baseUrl, org.login),
      },
      org.login,
      undefined
    );
    return c.body(null, 204);
  });
}
