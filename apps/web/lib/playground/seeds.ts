import type { AuthFallback } from "@emulators/core";

const origin = "https://playground.emulate.local";

/** Where each provider sends the browser back to after the OAuth sign-in flow, on the origin this worker serves. */
const signInFlow = `${globalThis.location.origin}/playground/flows/oauth-sign-in`;

/** The user each emulator treats any bearer token as, the same defaults the emulate CLI uses. */
export const fallbackUsers: Record<string, AuthFallback> = {
  apple: { login: "testuser@icloud.com", id: 1, scopes: ["openid", "email", "name"] },
  aws: { login: "admin", id: 1, scopes: ["s3:*", "sqs:*", "iam:*", "sts:*"] },
  clerk: { login: "test@example.com", id: 1, scopes: [] },
  github: { login: "admin", id: 1, scopes: ["repo", "user", "admin:org", "admin:repo_hook"] },
  google: { login: "testuser@gmail.com", id: 1, scopes: ["openid", "email", "profile"] },
  linear: { login: "admin@linear.local", id: 1, scopes: [] },
  microsoft: { login: "testuser@outlook.com", id: 1, scopes: ["openid", "email", "profile", "User.Read"] },
  mongoatlas: { login: "admin", id: 1, scopes: [] },
  okta: { login: "testuser@okta.local", id: 1, scopes: ["openid", "profile", "email", "groups"] },
  resend: { login: "re_test_admin", id: 1, scopes: [] },
  slack: { login: "U000000001", id: 1, scopes: [] },
  stripe: { login: "sk_test_admin", id: 1, scopes: [] },
  twilio: { login: "AC00000000000000000000000000000000", id: 1, scopes: [] },
  vercel: { login: "admin", id: 1, scopes: [] },
};

/** Seed data each emulator starts with, so the request catalogs work on a fresh tab. */
export const seeds: Record<string, Record<string, unknown> | undefined> = {
  ai: {
    rules: [
      {
        id: "weather-call",
        match: { tool: "get_weather" },
        reply: [{ type: "tool_call", name: "get_weather", arguments: { city: "Paris" } }],
      },
      {
        id: "greeting",
        match: { textContains: "hello" },
        reply: [{ type: "text", text: "Hello from the emulator." }],
      },
    ],
  },
  apple: {
    oauth_clients: [
      {
        client_id: "emu_apple_client_id",
        team_id: "EMULATE01",
        name: "emulate playground",
        redirect_uris: [`${origin}/oauth/api/auth/callback/apple`, signInFlow],
      },
    ],
  },
  aws: {
    iam: {
      roles: [
        {
          role_name: "emulate-default-role",
          description: "Role for the AWS console STS presets.",
          assume_role_policy: '{"Version":"2012-10-17","Statement":[]}',
        },
      ],
    },
  },
  clerk: {
    users: [
      {
        clerk_id: "user_playground_ada",
        first_name: "Ada",
        last_name: "Lovelace",
        email_addresses: ["ada@example.com"],
        password: "clerk_test_password",
      },
      {
        clerk_id: "user_playground_grace",
        first_name: "Grace",
        last_name: "Hopper",
        email_addresses: ["grace@example.com"],
      },
    ],
    organizations: [
      {
        clerk_id: "org_playground_acme",
        name: "Acme",
        slug: "acme",
        members: [{ email: "ada@example.com", role: "admin" }],
      },
    ],
    oauth_applications: [
      {
        client_id: "emu_clerk_client_id",
        client_secret: "emu_clerk_client_secret",
        name: "emulate playground",
        redirect_uris: [`${origin}/oauth/api/auth/callback/clerk`, signInFlow],
      },
    ],
  },
  github: {
    oauth_apps: [
      {
        client_id: "emu_github_client_id",
        client_secret: "emu_github_client_secret",
        name: "emulate playground",
        redirect_uris: [`${origin}/oauth/api/auth/callback/github`, signInFlow],
      },
    ],
    users: [
      { login: "admin", name: "Admin User", email: "admin@example.com" },
      { login: "designer", name: "Creative Director", email: "designer@example.com" },
      { login: "editor", name: "Content Editor", email: "editor@example.com" },
    ],
    orgs: [
      {
        login: "emulate-labs",
        name: "Emulate Labs",
        description: "Sample organization for the playground.",
        members: [{ login: "admin", role: "admin" }, { login: "designer" }, { login: "editor" }],
      },
    ],
    repos: [
      {
        owner: "admin",
        name: "playground",
        description: "Sample repository for the playground.",
        language: "TypeScript",
        topics: ["playground", "emulate"],
        auto_init: true,
      },
      {
        owner: "emulate-labs",
        name: "website",
        description: "Sample organization repository.",
        language: "TypeScript",
        auto_init: true,
      },
    ],
  },
  google: {
    oauth_clients: [
      {
        client_id: "emu_google_client_id",
        client_secret: "emu_google_client_secret",
        name: "emulate playground",
        redirect_uris: [`${origin}/oauth/api/auth/callback/google`, signInFlow],
      },
    ],
    users: [
      { email: "admin@example.com", name: "Admin User" },
      { email: "designer@example.com", name: "Creative Director" },
      { email: "editor@example.com", name: "Content Editor" },
    ],
    labels: [{ id: "Label_ops", user_email: "testuser@gmail.com", name: "Ops" }],
    messages: [
      {
        id: "msg_attachment",
        thread_id: "thr_attachment",
        user_email: "testuser@gmail.com",
        raw: Buffer.from(
          [
            "From: Build Bot <builds@example.com>",
            "To: testuser@gmail.com",
            "Subject: Coverage report",
            "MIME-Version: 1.0",
            'Content-Type: multipart/mixed; boundary="emu-part"',
            "",
            "--emu-part",
            "Content-Type: text/plain; charset=utf-8",
            "",
            "The coverage report is attached.",
            "--emu-part",
            'Content-Type: text/csv; name="coverage.csv"',
            'Content-Disposition: attachment; filename="coverage.csv"',
            "Content-Transfer-Encoding: base64",
            "",
            Buffer.from("file,lines\nindex.ts,42\n").toString("base64"),
            "--emu-part--",
            "",
          ].join("\r\n"),
        ).toString("base64url"),
        label_ids: ["INBOX", "UNREAD"],
      },
    ],
  },
  linear: {
    oauth_apps: [
      {
        client_id: "lin_agent_client_id",
        client_secret: "lin_agent_client_secret",
        name: "Playground agent",
        redirect_uris: [],
        actor: "app",
      },
      {
        client_id: "emu_linear_client_id",
        client_secret: "emu_linear_client_secret",
        name: "emulate playground",
        redirect_uris: [`${origin}/oauth/api/auth/callback/linear`],
      },
    ],
    tokens: [{ token: "lin_test_revoke_me", user: "dev@linear.local" }],
    labels: [
      { name: "Chore", color: "#8b5cf6", team: "ENG", description: "Maintenance work" },
      { name: "Needs triage", color: "#f59e0b", team: "ENG" },
    ],
    projects: [{ name: "Q4 Launch", team: "ENG", state: "started", description: "Ship the login rework." }],
    issues: [
      {
        team: "ENG",
        title: "Fix login redirect loop",
        description: "Users bounce back to the sign-in page after Google sign-in on Safari.",
        priority: 2,
        state: "In Progress",
        assignee: "dev@linear.local",
        labels: ["Bug"],
      },
      { team: "ENG", title: "Remove the old onboarding banner", priority: 4, state: "Backlog", labels: ["Chore"] },
      { team: "ENG", title: "Duplicate of the login redirect bug", priority: 0, state: "Todo" },
    ],
    comments: [
      {
        id: "seed-comment-1",
        issue: "ENG-2",
        user: "dev@linear.local",
        body: "The redirect happens after the OAuth callback.",
      },
      {
        id: "seed-comment-2",
        issue: "ENG-2",
        user: "admin@linear.local",
        body: "Let's keep this for the next patch.",
      },
    ],
    webhooks: [
      {
        id: "seed-webhook-1",
        label: "Deploy notifier",
        url: "https://example.com/hooks/linear",
        team: "ENG",
        enabled: false,
      },
    ],
  },
  microsoft: {
    oauth_clients: [
      {
        client_id: "emu_microsoft_client_id",
        client_secret: "emu_microsoft_client_secret",
        name: "emulate playground",
        redirect_uris: [`${origin}/oauth/api/auth/callback/microsoft`, signInFlow],
      },
    ],
  },
  mongoatlas: undefined,
  okta: {
    oauth_clients: [
      {
        client_id: "emu_okta_client_id",
        client_secret: "emu_okta_client_secret",
        name: "emulate playground",
        redirect_uris: [`${origin}/oauth/api/auth/callback/okta`, signInFlow],
      },
    ],
  },
  resend: {
    domains: [{ name: "example.com" }],
  },
  slack: {
    users: [{ name: "alice", real_name: "Alice Example" }],
    oauth_apps: [
      {
        app_id: "A000000001",
        bot_id: "B000000002",
        bot_user_id: "U000000002",
        client_id: "emu_slack_client_id",
        client_secret: "emu_slack_client_secret",
        name: "emulate playground",
        redirect_uris: [`${origin}/oauth/api/auth/callback/slack`],
        interactivity_url: `${origin}/emulate/slack/api/team.info`,
      },
      {
        app_id: "A000000002",
        bot_id: "B000000003",
        bot_user_id: "U000000003",
        client_id: "emu_slack_uninstall_client_id",
        client_secret: "emu_slack_uninstall_client_secret",
        name: "emulate uninstall demo",
        redirect_uris: [`${origin}/oauth/api/auth/callback/slack`],
      },
    ],
    tokens: [
      { token: "xoxb-playground-token", type: "bot" },
      {
        token: "xoxb-playground-app-token",
        type: "bot",
        user_id: "U000000002",
        app_id: "A000000001",
        client_id: "emu_slack_client_id",
        bot_id: "B000000002",
        bot_user_id: "U000000002",
      },
      {
        token: "xoxp-playground-admin-token",
        type: "user",
        user: "admin",
        scopes:
          "chat:write channels:read channels:history channels:join channels:manage channels:write groups:read groups:history groups:write im:read im:history im:write mpim:read mpim:history mpim:write users:read users:read.email users.profile:read users.profile:write users:write files:read files:write pins:read pins:write bookmarks:read bookmarks:write reactions:read reactions:write team:read admin.conversations:write",
      },
      { token: "xoxp-playground-alice-token", type: "user", user: "alice" },
      { token: "xoxp-playground-revoke-token", type: "user", user: "admin" },
      {
        token: "xoxp-playground-uninstall-token",
        type: "user",
        user: "admin",
        client_id: "emu_slack_uninstall_client_id",
      },
    ],
  },
  stripe: {
    customers: [{ id: "cus_playground", email: "playground@example.com", name: "Playground Customer" }],
    products: [
      { id: "prod_hoodie", name: "Emulate Hoodie", description: "Stay warm while shipping" },
      { id: "prod_stickers", name: "Emulate Sticker Pack", description: "Decorate your laptop" },
      { id: "prod_mug", name: "Emulate Mug", description: "Fuel your coding sessions" },
      { id: "prod_tshirt", name: "Emulate T-Shirt", description: "A comfortable tee for local development" },
    ],
    prices: [
      { id: "price_hoodie", product_name: "Emulate Hoodie", currency: "usd", unit_amount: 5000 },
      { id: "price_stickers", product_name: "Emulate Sticker Pack", currency: "usd", unit_amount: 800 },
      { id: "price_mug", product_name: "Emulate Mug", currency: "usd", unit_amount: 1500 },
      { id: "price_tshirt", product_name: "Emulate T-Shirt", currency: "usd", unit_amount: 2500 },
    ],
  },
  twilio: {
    conversations: {
      services: [{ sid: "IS00000000000000000000000000000000", friendly_name: "Playground Conversations" }],
    },
  },
  vercel: {
    integrations: [
      {
        client_id: "emu_vercel_client_id",
        client_secret: "emu_vercel_client_secret",
        name: "emulate playground",
        redirect_uris: [`${origin}/oauth/api/auth/callback/vercel`, signInFlow],
      },
    ],
    users: [{ username: "teammate", name: "Teammate" }],
    teams: [{ slug: "playground-team", name: "Playground Team" }],
    projects: [{ name: "playground-app", framework: "nextjs" }],
  },
};
