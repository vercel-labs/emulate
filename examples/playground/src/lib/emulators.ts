import type { EmulateHandlerConfig } from "@emulators/adapter-next";
import * as apple from "@emulators/apple";
import * as aws from "@emulators/aws";
import * as clerk from "@emulators/clerk";
import * as github from "@emulators/github";
import * as google from "@emulators/google";
import * as linear from "@emulators/linear";
import * as microsoft from "@emulators/microsoft";
import * as mongoatlas from "@emulators/mongoatlas";
import * as okta from "@emulators/okta";
import * as resend from "@emulators/resend";
import * as slack from "@emulators/slack";
import * as stripe from "@emulators/stripe";
import * as twilio from "@emulators/twilio";
import * as vercel from "@emulators/vercel";
import { origin } from "@/lib/origin";

/** Every emulator the playground serves under /emulate/<name>, with its seed data. */
export const services: EmulateHandlerConfig["services"] = {
  apple: {
    emulator: apple,
    seed: {
      oauth_clients: [
        {
          client_id: "emu_apple_client_id",
          team_id: "EMULATE01",
          name: "emulate playground",
          redirect_uris: [`${origin}/oauth/api/auth/callback/apple`],
        },
      ],
    },
  },
  aws: {
    emulator: aws,
    seed: {
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
  },
  clerk: {
    emulator: clerk,
    seed: {
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
          redirect_uris: [`${origin}/oauth/api/auth/callback/clerk`],
        },
      ],
    },
  },
  github: {
    emulator: github,
    seed: {
      oauth_apps: [
        {
          client_id: "emu_github_client_id",
          client_secret: "emu_github_client_secret",
          name: "emulate playground",
          redirect_uris: [`${origin}/oauth/api/auth/callback/github`],
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
  },
  google: {
    emulator: google,
    seed: {
      oauth_clients: [
        {
          client_id: "emu_google_client_id",
          client_secret: "emu_google_client_secret",
          name: "emulate playground",
          redirect_uris: [`${origin}/oauth/api/auth/callback/google`],
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
  },
  linear: {
    emulator: linear,
    seed: {
      oauth_apps: [
        {
          client_id: "lin_agent_client_id",
          client_secret: "lin_agent_client_secret",
          name: "Playground agent",
          redirect_uris: [],
          actor: "app",
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
  },
  microsoft: {
    emulator: microsoft,
    seed: {
      oauth_clients: [
        {
          client_id: "emu_microsoft_client_id",
          client_secret: "emu_microsoft_client_secret",
          name: "emulate playground",
          redirect_uris: [`${origin}/oauth/api/auth/callback/microsoft`],
        },
      ],
    },
  },
  mongoatlas: { emulator: mongoatlas },
  okta: {
    emulator: okta,
    seed: {
      oauth_clients: [
        {
          client_id: "emu_okta_client_id",
          client_secret: "emu_okta_client_secret",
          name: "emulate playground",
          redirect_uris: [`${origin}/oauth/api/auth/callback/okta`],
        },
      ],
    },
  },
  resend: {
    emulator: resend,
    seed: {
      domains: [{ name: "example.com" }],
    },
  },
  slack: {
    emulator: slack,
    seed: {
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
  },
  stripe: {
    emulator: stripe,
    seed: {
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
      webhooks: [{ url: `${origin}/stripe/api/webhooks`, events: ["*"] }],
    },
  },
  twilio: {
    emulator: twilio,
    seed: {
      conversations: {
        services: [{ sid: "IS00000000000000000000000000000000", friendly_name: "Playground Conversations" }],
      },
    },
  },
  vercel: {
    emulator: vercel,
    seed: {
      integrations: [
        {
          client_id: "emu_vercel_client_id",
          client_secret: "emu_vercel_client_secret",
          name: "emulate playground",
          redirect_uris: [`${origin}/oauth/api/auth/callback/vercel`],
        },
      ],
      users: [{ username: "teammate", name: "Teammate" }],
      teams: [{ slug: "playground-team", name: "Playground Team" }],
      projects: [{ name: "playground-app", framework: "nextjs" }],
    },
  },
};
