import type { Context, Hono } from "@emulators/core";
import type { AppEnv, RouteContext, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import { getLinearStore } from "./store.js";
import { linearId, slugify } from "./ids.js";
import type { LinearIssuePriority, LinearTokenActorType, LinearWorkflowStateType } from "./entities.js";
import { graphqlRoutes } from "./routes/graphql.js";
import { oauthRoutes } from "./routes/oauth.js";
import { inspectorRoutes } from "./routes/inspector.js";

export { getLinearStore, type LinearStore } from "./store.js";
export * from "./entities.js";

export interface LinearSeedConfig {
  port?: number;
  baseUrl?: string;
  organization?: {
    name?: string;
    url_key?: string;
  };
  users?: Array<{
    id?: string;
    email: string;
    name?: string;
    display_name?: string;
    avatar_url?: string;
    admin?: boolean;
    active?: boolean;
  }>;
  teams?: Array<{
    id?: string;
    key: string;
    name: string;
    description?: string;
    private?: boolean;
    states?: Array<{
      id?: string;
      name: string;
      type?: LinearWorkflowStateType;
      position?: number;
    }>;
  }>;
  labels?: Array<{
    id?: string;
    name: string;
    color?: string;
    description?: string;
    team?: string;
  }>;
  projects?: Array<{
    id?: string;
    name: string;
    description?: string;
    state?: "planned" | "started" | "completed" | "canceled";
    team?: string;
  }>;
  cycles?: Array<{
    id?: string;
    team: string;
    name: string;
    number?: number;
    starts_at?: string;
    ends_at?: string;
  }>;
  issues?: Array<{
    id?: string;
    team: string;
    title: string;
    description?: string;
    priority?: LinearIssuePriority;
    state?: string;
    assignee?: string;
    creator?: string;
    delegate?: string;
    project?: string;
    cycle?: string;
    labels?: string[];
    due_date?: string;
  }>;
  comments?: Array<{
    id?: string;
    issue: string;
    body: string;
    user?: string;
  }>;
  oauth_apps?: Array<{
    id?: string;
    client_id: string;
    client_secret: string;
    name: string;
    redirect_uris: string[];
    scopes?: string[] | string;
    actor?: LinearTokenActorType;
    assignable?: boolean;
    mentionable?: boolean;
  }>;
  tokens?: Array<{
    token: string;
    type?: "personal" | "oauth_access" | "client_credentials";
    user?: string;
    app?: string;
    scopes?: string[] | string;
    actor?: LinearTokenActorType;
  }>;
  webhooks?: Array<{
    id?: string;
    label?: string;
    url: string;
    resource_types?: string[] | string;
    team?: string;
    all_public_teams?: boolean;
    secret?: string;
    enabled?: boolean;
  }>;
  strict_scopes?: boolean;
}

const DEFAULT_SCOPES = ["read", "write", "issues:create", "comments:create", "admin"];

function seedDefaults(store: Store, baseUrl: string): void {
  const ls = getLinearStore(store);
  if (!ls.organizations.all()[0]) {
    ls.organizations.insert({
      linear_id: linearId(),
      name: "Emulate",
      url_key: "emulate",
      url: "https://linear.app/emulate",
    });
  }

  let admin = ls.users.findOneBy("email", "admin@linear.local");
  if (!admin) {
    admin = ls.users.insert({
      linear_id: linearId(),
      email: "admin@linear.local",
      name: "Admin User",
      display_name: "Admin",
      avatar_url: null,
      active: true,
      admin: true,
      app: false,
    });
  }

  let developer = ls.users.findOneBy("email", "dev@linear.local");
  if (!developer) {
    developer = ls.users.insert({
      linear_id: linearId(),
      email: "dev@linear.local",
      name: "Developer",
      display_name: "Developer",
      avatar_url: null,
      active: true,
      admin: false,
      app: false,
    });
  }

  let team = ls.teams.findOneBy("key", "ENG");
  if (!team) {
    team = ls.teams.insert({
      linear_id: linearId(),
      key: "ENG",
      name: "Engineering",
      description: "Default engineering team",
      private: false,
      url: "https://linear.app/emulate/team/ENG",
      issue_sequence: 0,
    });
  }

  ensureDefaultStates(store, team.linear_id);
  const todo = resolveState(store, "Todo", team.linear_id) ?? resolveState(store, "Todo");
  const bug = ensureLabel(store, { name: "Bug", color: "#d92d20", teamId: team.linear_id });
  ensureLabel(store, { name: "Feature", color: "#2563eb", teamId: team.linear_id });
  const project = ensureProject(store, { name: "Local Project", teamId: team.linear_id });
  const cycle = ensureCycle(store, { name: "Cycle 1", number: 1, teamId: team.linear_id });

  if (ls.issues.all().length === 0 && todo) {
    const number = nextIssueNumber(store, team.linear_id);
    const issue = ls.issues.insert({
      linear_id: linearId(),
      identifier: `${team.key}-${number}`,
      number,
      team_id: team.linear_id,
      title: "Ship Linear emulator",
      description: "Use local Linear state in tests without calling the real Linear API.",
      priority: 3,
      state_id: todo.linear_id,
      assignee_id: developer.linear_id,
      creator_id: admin.linear_id,
      delegate_id: null,
      project_id: project.linear_id,
      cycle_id: cycle.linear_id,
      label_ids: [bug.linear_id],
      url: `${baseUrl}/issue/${team.key}-${number}`,
      archived_at: null,
      canceled_at: null,
      completed_at: null,
      started_at: null,
      due_date: null,
      create_as_user: null,
      display_icon_url: null,
    });
    ls.comments.insert({
      linear_id: linearId(),
      issue_id: issue.linear_id,
      user_id: admin.linear_id,
      body: "This issue was seeded by the Linear emulator.",
      create_as_user: null,
      display_icon_url: null,
    });
  }

  if (!ls.oauthApps.findOneBy("client_id", "lin_example_client_id")) {
    ls.oauthApps.insert({
      linear_id: linearId(),
      client_id: "lin_example_client_id",
      client_secret: "example_client_secret",
      name: "My Linear App",
      redirect_uris: ["http://localhost:3000/api/auth/callback/linear"],
      scopes: DEFAULT_SCOPES,
      actor: "user",
      assignable: false,
      mentionable: false,
      app_user_id: null,
    });
  }

  if (!ls.tokens.findOneBy("token", "lin_test_admin")) {
    ls.tokens.insert({
      token: "lin_test_admin",
      type: "personal",
      actor_type: "user",
      user_id: admin.linear_id,
      app_id: null,
      scopes: DEFAULT_SCOPES,
      expires_at: null,
      revoked: false,
      refresh_token: null,
    });
  }
}

export function seedFromConfig(store: Store, baseUrl: string, config: LinearSeedConfig): void {
  const ls = getLinearStore(store);

  if (config.organization) {
    const existing = ls.organizations.all()[0];
    const name = config.organization.name ?? existing?.name ?? "Emulate";
    const urlKey = config.organization.url_key ?? existing?.url_key ?? slugify(name);
    if (existing) {
      ls.organizations.update(existing.id, {
        name,
        url_key: urlKey,
        url: `https://linear.app/${urlKey}`,
      });
    } else {
      ls.organizations.insert({
        linear_id: linearId(),
        name,
        url_key: urlKey,
        url: `https://linear.app/${urlKey}`,
      });
    }
  }

  if (config.users) {
    for (const userCfg of config.users) {
      const existing = ls.users.findOneBy("email", userCfg.email);
      if (existing) continue;
      const name = userCfg.name ?? userCfg.display_name ?? userCfg.email.split("@")[0];
      ls.users.insert({
        linear_id: userCfg.id ?? linearId(),
        email: userCfg.email,
        name,
        display_name: userCfg.display_name ?? name,
        avatar_url: userCfg.avatar_url ?? null,
        active: userCfg.active ?? true,
        admin: userCfg.admin ?? false,
        app: false,
      });
    }
  }

  if (config.teams) {
    for (const teamCfg of config.teams) {
      let team = ls.teams.findOneBy("key", teamCfg.key);
      if (!team) {
        team = ls.teams.insert({
          linear_id: teamCfg.id ?? linearId(),
          key: teamCfg.key,
          name: teamCfg.name,
          description: teamCfg.description ?? null,
          private: teamCfg.private ?? false,
          url: `https://linear.app/${ls.organizations.all()[0]?.url_key ?? "emulate"}/team/${teamCfg.key}`,
          issue_sequence: 0,
        });
      }

      if (teamCfg.states) {
        for (let i = 0; i < teamCfg.states.length; i++) {
          const stateCfg = teamCfg.states[i];
          if (ls.workflowStates.findBy("team_id", team.linear_id).some((state) => state.name === stateCfg.name)) {
            continue;
          }
          ls.workflowStates.insert({
            linear_id: stateCfg.id ?? linearId(),
            team_id: team.linear_id,
            name: stateCfg.name,
            type: stateCfg.type ?? inferStateType(stateCfg.name),
            position: stateCfg.position ?? i + 1,
          });
        }
      } else {
        ensureDefaultStates(store, team.linear_id);
      }
    }
  }

  if (config.labels) {
    for (const labelCfg of config.labels) {
      const teamId = labelCfg.team ? (resolveTeam(store, labelCfg.team)?.linear_id ?? null) : null;
      ensureLabel(store, {
        id: labelCfg.id,
        name: labelCfg.name,
        color: labelCfg.color ?? "#64748b",
        description: labelCfg.description,
        teamId,
      });
    }
  }

  if (config.projects) {
    for (const projectCfg of config.projects) {
      const teamId = projectCfg.team ? (resolveTeam(store, projectCfg.team)?.linear_id ?? null) : null;
      ensureProject(store, {
        id: projectCfg.id,
        name: projectCfg.name,
        description: projectCfg.description,
        state: projectCfg.state,
        teamId,
      });
    }
  }

  if (config.cycles) {
    for (const cycleCfg of config.cycles) {
      const team = resolveTeam(store, cycleCfg.team);
      if (!team) continue;
      ensureCycle(store, {
        id: cycleCfg.id,
        name: cycleCfg.name,
        number: cycleCfg.number,
        teamId: team.linear_id,
        startsAt: cycleCfg.starts_at,
        endsAt: cycleCfg.ends_at,
      });
    }
  }

  if (config.oauth_apps) {
    for (const appCfg of config.oauth_apps) {
      if (ls.oauthApps.findOneBy("client_id", appCfg.client_id)) continue;
      let appUserId: string | null = null;
      if (appCfg.actor === "app" || appCfg.assignable || appCfg.mentionable) {
        appUserId = ensureAppUser(store, appCfg.name).linear_id;
      }
      ls.oauthApps.insert({
        linear_id: appCfg.id ?? linearId(),
        client_id: appCfg.client_id,
        client_secret: appCfg.client_secret,
        name: appCfg.name,
        redirect_uris: appCfg.redirect_uris,
        scopes: normalizeScopes(appCfg.scopes, DEFAULT_SCOPES),
        actor: appCfg.actor ?? "user",
        assignable: appCfg.assignable ?? false,
        mentionable: appCfg.mentionable ?? false,
        app_user_id: appUserId,
      });
    }
  }

  if (config.issues) {
    for (const issueCfg of config.issues) {
      const team = resolveTeam(store, issueCfg.team);
      if (!team) continue;
      const existing = ls.issues
        .all()
        .find((issue) => issue.title === issueCfg.title && issue.team_id === team.linear_id);
      if (existing) continue;
      const state =
        (issueCfg.state ? resolveState(store, issueCfg.state, team.linear_id) : undefined) ??
        resolveState(store, "Todo", team.linear_id) ??
        ls.workflowStates.findBy("team_id", team.linear_id)[0];
      if (!state) continue;
      const number = nextIssueNumber(store, team.linear_id);
      const labelIds = (issueCfg.labels ?? [])
        .map((label) => resolveLabel(store, label, team.linear_id)?.linear_id)
        .filter((id): id is string => Boolean(id));
      const now = new Date().toISOString();
      ls.issues.insert({
        linear_id: issueCfg.id ?? linearId(),
        identifier: `${team.key}-${number}`,
        number,
        team_id: team.linear_id,
        title: issueCfg.title,
        description: issueCfg.description ?? null,
        priority: issueCfg.priority ?? 0,
        state_id: state.linear_id,
        assignee_id: issueCfg.assignee ? (resolveUser(store, issueCfg.assignee)?.linear_id ?? null) : null,
        creator_id: issueCfg.creator
          ? (resolveUser(store, issueCfg.creator)?.linear_id ?? null)
          : (ls.users.all()[0]?.linear_id ?? null),
        delegate_id: issueCfg.delegate ? (resolveUser(store, issueCfg.delegate)?.linear_id ?? null) : null,
        project_id: issueCfg.project ? (resolveProject(store, issueCfg.project)?.linear_id ?? null) : null,
        cycle_id: issueCfg.cycle ? (resolveCycle(store, issueCfg.cycle, team.linear_id)?.linear_id ?? null) : null,
        label_ids: labelIds,
        url: `${baseUrl}/issue/${team.key}-${number}`,
        archived_at: null,
        canceled_at: state.type === "canceled" ? now : null,
        completed_at: state.type === "completed" ? now : null,
        started_at: state.type === "started" ? now : null,
        due_date: issueCfg.due_date ?? null,
        create_as_user: null,
        display_icon_url: null,
      });
    }
  }

  if (config.comments) {
    for (const commentCfg of config.comments) {
      const issue = resolveIssue(store, commentCfg.issue);
      if (!issue) continue;
      ls.comments.insert({
        linear_id: commentCfg.id ?? linearId(),
        issue_id: issue.linear_id,
        user_id: commentCfg.user
          ? (resolveUser(store, commentCfg.user)?.linear_id ?? null)
          : (ls.users.all()[0]?.linear_id ?? null),
        body: commentCfg.body,
        create_as_user: null,
        display_icon_url: null,
      });
    }
  }

  if (config.tokens) {
    for (const tokenCfg of config.tokens) {
      if (ls.tokens.findOneBy("token", tokenCfg.token)) continue;
      const app = tokenCfg.app
        ? (ls.oauthApps.findOneBy("client_id", tokenCfg.app) ?? ls.oauthApps.findOneBy("linear_id", tokenCfg.app))
        : undefined;
      const user = tokenCfg.user ? resolveUser(store, tokenCfg.user) : undefined;
      ls.tokens.insert({
        token: tokenCfg.token,
        type: tokenCfg.type ?? "personal",
        actor_type: tokenCfg.actor ?? (app ? "app" : "user"),
        user_id: user?.linear_id ?? app?.app_user_id ?? ls.users.all()[0]?.linear_id ?? null,
        app_id: app?.linear_id ?? null,
        scopes: normalizeScopes(tokenCfg.scopes, DEFAULT_SCOPES),
        expires_at: null,
        revoked: false,
        refresh_token: null,
      });
    }
  }

  if (config.webhooks) {
    for (const whCfg of config.webhooks) {
      const team = whCfg.team ? resolveTeam(store, whCfg.team) : undefined;
      ls.webhooks.insert({
        linear_id: whCfg.id ?? linearId(),
        label: whCfg.label ?? "Local webhook",
        url: whCfg.url,
        enabled: whCfg.enabled ?? true,
        resource_types: normalizeScopes(whCfg.resource_types, ["Issue", "Comment"]),
        team_id: team?.linear_id ?? null,
        all_public_teams: whCfg.all_public_teams ?? !team,
        secret: whCfg.secret ?? null,
        creator_id: ls.users.all()[0]?.linear_id ?? null,
      });
    }
  }

  if (config.strict_scopes !== undefined) {
    store.setData("linear.strict_scopes", config.strict_scopes);
  }
}

export const linearPlugin: ServicePlugin = {
  name: "linear",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    app.use("*", async (c, next) => {
      const authError = applyLinearTokenAuth(c, store);
      if (authError) return authError;
      await next();
    });

    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    graphqlRoutes(ctx);
    oauthRoutes(ctx);
    inspectorRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default linearPlugin;

export function normalizeScopes(value: string[] | string | undefined, fallback: string[] = []): string[] {
  if (Array.isArray(value)) return value.map((scope) => scope.trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(/[,\s]+/)
      .map((scope) => scope.trim())
      .filter(Boolean);
  }
  return [...fallback];
}

export function resolveUser(store: Store, ref: string | undefined | null) {
  if (!ref) return undefined;
  const ls = getLinearStore(store);
  return (
    ls.users.findOneBy("linear_id", ref) ??
    ls.users.findOneBy("email", ref) ??
    ls.users.all().find((user) => user.name === ref || user.display_name === ref)
  );
}

export function resolveTeam(store: Store, ref: string | undefined | null) {
  if (!ref) return undefined;
  const ls = getLinearStore(store);
  return ls.teams.findOneBy("linear_id", ref) ?? ls.teams.findOneBy("key", ref) ?? ls.teams.findOneBy("name", ref);
}

export function resolveState(store: Store, ref: string | undefined | null, teamId?: string) {
  if (!ref) return undefined;
  const ls = getLinearStore(store);
  const states = teamId ? ls.workflowStates.findBy("team_id", teamId) : ls.workflowStates.all();
  return states.find((state) => state.linear_id === ref || state.name === ref || state.type === ref);
}

export function resolveIssue(store: Store, ref: string | undefined | null) {
  if (!ref) return undefined;
  const ls = getLinearStore(store);
  return ls.issues.findOneBy("linear_id", ref) ?? ls.issues.findOneBy("identifier", ref);
}

export function resolveLabel(store: Store, ref: string | undefined | null, teamId?: string) {
  if (!ref) return undefined;
  const ls = getLinearStore(store);
  const labels = teamId
    ? ls.issueLabels.all().filter((label) => label.team_id === teamId || label.team_id === null)
    : ls.issueLabels.all();
  return labels.find((label) => label.linear_id === ref || label.name === ref);
}

export function resolveProject(store: Store, ref: string | undefined | null) {
  if (!ref) return undefined;
  const ls = getLinearStore(store);
  return ls.projects.findOneBy("linear_id", ref) ?? ls.projects.findOneBy("name", ref);
}

export function resolveCycle(store: Store, ref: string | undefined | null, teamId?: string) {
  if (!ref) return undefined;
  const ls = getLinearStore(store);
  const cycles = teamId ? ls.cycles.findBy("team_id", teamId) : ls.cycles.all();
  return cycles.find((cycle) => cycle.linear_id === ref || cycle.name === ref || String(cycle.number) === ref);
}

export function nextIssueNumber(store: Store, teamId: string): number {
  const ls = getLinearStore(store);
  const team = ls.teams.findOneBy("linear_id", teamId);
  if (!team) return 1;
  const next = team.issue_sequence + 1;
  ls.teams.update(team.id, { issue_sequence: next });
  return next;
}

function applyLinearTokenAuth(c: Context, store: Store): Response | undefined {
  const requestToken = linearRequestToken(c);
  if (!requestToken) return;

  const record = getLinearStore(store).tokens.findOneBy("token", requestToken);
  if (!record) return;
  if (record.type === "oauth_refresh") {
    return linearAuthError(c, "OAuth refresh tokens cannot be used as Linear API access tokens.");
  }
  if (record.revoked) return linearAuthError(c, "Linear token has been revoked.");
  if (record.expires_at && new Date(record.expires_at).getTime() <= Date.now()) {
    return linearAuthError(c, "Linear token has expired.");
  }

  const user = record.user_id ? getLinearStore(store).users.findOneBy("linear_id", record.user_id) : undefined;
  c.set("authToken", record.token);
  c.set("authScopes", record.scopes);
  c.set("authUser", {
    login: user?.email ?? record.user_id ?? record.app_id ?? "linear-app",
    id: record.id,
    scopes: record.scopes,
  });
}

function linearAuthError(c: Context, message: string): Response {
  return c.json(
    {
      message,
      documentation_url: c.get("docsUrl") ?? "https://emulate.dev/linear",
    },
    401,
  );
}

function linearRequestToken(c: Context): string | undefined {
  const authHeader = c.req.header("Authorization");
  if (!authHeader) return undefined;
  const token = authHeader.replace(/^(Bearer|token)\s+/i, "").trim();
  return token || undefined;
}

function ensureDefaultStates(store: Store, teamId: string): void {
  const defaults: Array<{ name: string; type: LinearWorkflowStateType; position: number }> = [
    { name: "Backlog", type: "backlog", position: 1 },
    { name: "Todo", type: "unstarted", position: 2 },
    { name: "In Progress", type: "started", position: 3 },
    { name: "Done", type: "completed", position: 4 },
  ];
  const ls = getLinearStore(store);
  for (const state of defaults) {
    if (ls.workflowStates.findBy("team_id", teamId).some((existing) => existing.name === state.name)) continue;
    ls.workflowStates.insert({
      linear_id: linearId(),
      team_id: teamId,
      ...state,
    });
  }
}

function inferStateType(name: string): LinearWorkflowStateType {
  const lower = name.toLowerCase();
  if (lower.includes("backlog")) return "backlog";
  if (lower.includes("progress") || lower.includes("started")) return "started";
  if (lower.includes("done") || lower.includes("complete")) return "completed";
  if (lower.includes("cancel")) return "canceled";
  return "unstarted";
}

function ensureLabel(
  store: Store,
  input: { id?: string; name: string; color: string; description?: string; teamId: string | null },
) {
  const ls = getLinearStore(store);
  const existing = ls.issueLabels
    .all()
    .find((label) => label.name === input.name && (label.team_id === input.teamId || label.team_id === null));
  if (existing) return existing;
  return ls.issueLabels.insert({
    linear_id: input.id ?? linearId(),
    team_id: input.teamId,
    name: input.name,
    color: input.color,
    description: input.description ?? null,
  });
}

function ensureProject(
  store: Store,
  input: {
    id?: string;
    name: string;
    description?: string;
    state?: "planned" | "started" | "completed" | "canceled";
    teamId: string | null;
  },
) {
  const ls = getLinearStore(store);
  const existing = ls.projects.all().find((project) => project.name === input.name && project.team_id === input.teamId);
  if (existing) return existing;
  return ls.projects.insert({
    linear_id: input.id ?? linearId(),
    team_id: input.teamId,
    name: input.name,
    description: input.description ?? null,
    state: input.state ?? "planned",
  });
}

function ensureCycle(
  store: Store,
  input: {
    id?: string;
    name: string;
    number?: number;
    teamId: string;
    startsAt?: string;
    endsAt?: string;
  },
) {
  const ls = getLinearStore(store);
  const existing = ls.cycles.findBy("team_id", input.teamId).find((cycle) => cycle.name === input.name);
  if (existing) return existing;
  const number = input.number ?? ls.cycles.findBy("team_id", input.teamId).length + 1;
  return ls.cycles.insert({
    linear_id: input.id ?? linearId(),
    team_id: input.teamId,
    name: input.name,
    number,
    starts_at: input.startsAt ?? null,
    ends_at: input.endsAt ?? null,
  });
}

function ensureAppUser(store: Store, appName: string) {
  const ls = getLinearStore(store);
  const email = `${slugify(appName) || "linear-app"}@apps.linear.local`;
  const existing = ls.users.findOneBy("email", email);
  if (existing) return existing;
  return ls.users.insert({
    linear_id: linearId(),
    email,
    name: appName,
    display_name: appName,
    avatar_url: null,
    active: true,
    admin: false,
    app: true,
  });
}
