import type { ServicePlugin, Store, AppKeyResolver, AuthFallback } from "@emulators/core";

export interface LoadedService {
  plugin: ServicePlugin;
  seedFromConfig?(store: Store, baseUrl: string, config: unknown): void;
  createAppKeyResolver?(store: Store): AppKeyResolver;
}

export interface ServiceEntry {
  label: string;
  endpoints: string;
  load(): Promise<LoadedService>;
  defaultFallback(svcSeedConfig?: Record<string, unknown>): AuthFallback;
  initConfig: Record<string, unknown>;
}

const SERVICE_NAME_LIST = ["vercel", "github", "google", "slack", "apple", "microsoft", "aws"] as const;
export type ServiceName = (typeof SERVICE_NAME_LIST)[number];
export const SERVICE_NAMES: readonly ServiceName[] = SERVICE_NAME_LIST;

export const SERVICE_REGISTRY: Record<ServiceName, ServiceEntry> = {
  vercel: {
    label: "Vercel REST API emulator",
    endpoints: "projects, deployments, domains, env vars, users, teams, file uploads, protection bypass",
    async load() {
      const mod = await import("@emulators/vercel");
      return { plugin: mod.vercelPlugin, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback(cfg) {
      const firstLogin = (cfg?.users as Array<{ username?: string }> | undefined)?.[0]?.username ?? "admin";
      return { login: firstLogin, id: 1, scopes: [] };
    },
    initConfig: {
      vercel: {
        users: [{ username: "developer", name: "Developer", email: "dev@example.com" }],
        teams: [{ slug: "my-team", name: "My Team" }],
        projects: [{ name: "my-app", team: "my-team", framework: "nextjs" }],
        integrations: [{
          client_id: "oac_example_client_id",
          client_secret: "example_client_secret",
          name: "My Vercel App",
          redirect_uris: ["http://localhost:3000/api/auth/callback/vercel"],
        }],
      },
    },
  },

  github: {
    label: "GitHub REST API emulator",
    endpoints: "users, repos, issues, PRs, comments, reviews, labels, milestones, branches, git data, orgs, teams, releases, webhooks, search, actions, checks, rate limit",
    async load() {
      const mod = await import("@emulators/github");
      return {
        plugin: mod.githubPlugin,
        seedFromConfig: mod.seedFromConfig,
        createAppKeyResolver(store: Store): AppKeyResolver {
          return (appId: number) => {
            try {
              const gh = mod.getGitHubStore(store);
              const ghApp = gh.apps.all().find((a) => a.app_id === appId);
              if (!ghApp) return null;
              return { privateKey: ghApp.private_key, slug: ghApp.slug, name: ghApp.name };
            } catch {
              return null;
            }
          };
        },
      };
    },
    defaultFallback(cfg) {
      const firstLogin = (cfg?.users as Array<{ login?: string }> | undefined)?.[0]?.login ?? "admin";
      return { login: firstLogin, id: 1, scopes: ["repo", "user", "admin:org", "admin:repo_hook"] };
    },
    initConfig: {
      github: {
        users: [{
          login: "octocat", name: "The Octocat", email: "octocat@github.com",
          bio: "I am the Octocat", company: "GitHub", location: "San Francisco",
        }],
        orgs: [{ login: "my-org", name: "My Organization", description: "A test organization" }],
        repos: [
          { owner: "octocat", name: "hello-world", description: "My first repository", language: "JavaScript", topics: ["hello", "world"], auto_init: true },
          { owner: "my-org", name: "org-repo", description: "An organization repository", language: "TypeScript", auto_init: true },
        ],
        oauth_apps: [{
          client_id: "Iv1.example_client_id", client_secret: "example_client_secret",
          name: "My App", redirect_uris: ["http://localhost:3000/api/auth/callback/github"],
        }],
      },
    },
  },

  google: {
    label: "Google OAuth 2.0 / OpenID Connect + Gmail, Calendar, and Drive emulator",
    endpoints: "OAuth authorize, token exchange, userinfo, OIDC discovery, token revocation, Gmail messages/drafts/threads/labels/history/settings, Calendar lists/events/freebusy, Drive files/uploads",
    async load() {
      const mod = await import("@emulators/google");
      return { plugin: mod.googlePlugin, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback(cfg) {
      const firstEmail = (cfg?.users as Array<{ email?: string }> | undefined)?.[0]?.email ?? "testuser@gmail.com";
      return { login: firstEmail, id: 1, scopes: ["openid", "email", "profile"] };
    },
    initConfig: {
      google: {
        users: [{ email: "testuser@example.com", name: "Test User", picture: "https://lh3.googleusercontent.com/a/default-user", email_verified: true }],
        oauth_clients: [{
          client_id: "example-client-id.apps.googleusercontent.com", client_secret: "GOCSPX-example_secret",
          name: "Code App (Google)", redirect_uris: ["http://localhost:3000/api/auth/callback/google"],
        }],
        labels: [{ id: "Label_ops", user_email: "testuser@example.com", name: "Ops/Review", color_background: "#DDEEFF", color_text: "#111111" }],
        messages: [{
          id: "msg_welcome", user_email: "testuser@example.com", from: "welcome@example.com", to: "testuser@example.com",
          subject: "Welcome to the Gmail emulator", body_text: "You can now test Gmail, Calendar, and Drive flows locally.",
          label_ids: ["INBOX", "UNREAD", "CATEGORY_UPDATES"], date: "2025-01-04T10:00:00.000Z",
        }],
        calendars: [{ id: "primary", user_email: "testuser@example.com", summary: "testuser@example.com", primary: true, selected: true, time_zone: "UTC" }],
        calendar_events: [{
          id: "evt_kickoff", user_email: "testuser@example.com", calendar_id: "primary",
          summary: "Project Kickoff", start_date_time: "2025-01-10T09:00:00.000Z", end_date_time: "2025-01-10T09:30:00.000Z",
        }],
        drive_items: [{ id: "drv_docs", user_email: "testuser@example.com", name: "Docs", mime_type: "application/vnd.google-apps.folder", parent_ids: ["root"] }],
      },
    },
  },

  slack: {
    label: "Slack API emulator",
    endpoints: "auth, chat, conversations, users, reactions, team, OAuth, incoming webhooks",
    async load() {
      const mod = await import("@emulators/slack");
      return { plugin: mod.slackPlugin, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback() {
      return { login: "U000000001", id: 1, scopes: ["chat:write", "channels:read", "users:read", "reactions:write"] };
    },
    initConfig: {
      slack: {
        team: { name: "My Workspace", domain: "my-workspace" },
        users: [{ name: "developer", real_name: "Developer", email: "dev@example.com" }],
        channels: [{ name: "general", topic: "General discussion" }, { name: "random", topic: "Random stuff" }],
        bots: [{ name: "my-bot" }],
        oauth_apps: [{
          client_id: "12345.67890", client_secret: "example_client_secret",
          name: "My Slack App", redirect_uris: ["http://localhost:3000/api/auth/callback/slack"],
        }],
      },
    },
  },

  apple: {
    label: "Apple Sign In / OAuth emulator",
    endpoints: "OAuth authorize, token exchange, JWKS",
    async load() {
      const mod = await import("@emulators/apple");
      return { plugin: mod.applePlugin, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback(cfg) {
      const firstEmail = (cfg?.users as Array<{ email?: string }> | undefined)?.[0]?.email ?? "testuser@icloud.com";
      return { login: firstEmail, id: 1, scopes: ["openid", "email", "name"] };
    },
    initConfig: {
      apple: {
        users: [{ email: "testuser@icloud.com", name: "Test User" }],
        oauth_clients: [{
          client_id: "com.example.app", team_id: "TEAM001",
          name: "My Apple App", redirect_uris: ["http://localhost:3000/api/auth/callback/apple"],
        }],
      },
    },
  },

  microsoft: {
    label: "Microsoft Entra ID OAuth 2.0 / OpenID Connect emulator",
    endpoints: "OAuth authorize, token exchange, userinfo, OIDC discovery, Graph /me, logout, token revocation",
    async load() {
      const mod = await import("@emulators/microsoft");
      return { plugin: mod.microsoftPlugin, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback(cfg) {
      const firstEmail = (cfg?.users as Array<{ email?: string }> | undefined)?.[0]?.email ?? "testuser@outlook.com";
      return { login: firstEmail, id: 1, scopes: ["openid", "email", "profile", "User.Read"] };
    },
    initConfig: {
      microsoft: {
        users: [{ email: "testuser@outlook.com", name: "Test User" }],
        oauth_clients: [{
          client_id: "example-client-id", client_secret: "example-client-secret",
          name: "My Microsoft App", redirect_uris: ["http://localhost:3000/api/auth/callback/microsoft-entra-id"],
        }],
      },
    },
  },

  aws: {
    label: "AWS cloud service emulator",
    endpoints: "S3 (buckets, objects), SQS (queues, messages), IAM (users, roles, access keys), STS (assume role, caller identity)",
    async load() {
      const mod = await import("@emulators/aws");
      return { plugin: mod.awsPlugin, seedFromConfig: mod.seedFromConfig };
    },
    defaultFallback() {
      return { login: "admin", id: 1, scopes: ["s3:*", "sqs:*", "iam:*", "sts:*"] };
    },
    initConfig: {
      aws: {
        region: "us-east-1",
        s3: { buckets: [{ name: "my-app-bucket" }, { name: "my-app-uploads" }] },
        sqs: { queues: [{ name: "my-app-events" }, { name: "my-app-dlq" }] },
        iam: {
          users: [{ user_name: "developer", create_access_key: true }],
          roles: [{ role_name: "lambda-execution-role", description: "Role for Lambda function execution" }],
        },
      },
    },
  },
};

export const DEFAULT_TOKENS = {
  tokens: {
    "test_token_admin": {
      login: "admin",
      scopes: ["repo", "user", "admin:org", "admin:repo_hook"],
    },
    "test_token_user1": {
      login: "octocat",
      scopes: ["repo", "user"],
    },
  },
};
