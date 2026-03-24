import { writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { stringify as yamlStringify } from "yaml";

interface InitOptions {
  service: string;
}

const defaultVercelConfig = {
  vercel: {
    users: [
      {
        username: "developer",
        name: "Developer",
        email: "dev@example.com",
      },
    ],
    teams: [
      {
        slug: "my-team",
        name: "My Team",
      },
    ],
    projects: [
      {
        name: "my-app",
        team: "my-team",
        framework: "nextjs",
      },
    ],
    integrations: [
      {
        client_id: "oac_example_client_id",
        client_secret: "example_client_secret",
        name: "My Vercel App",
        redirect_uris: ["http://localhost:3000/api/auth/callback/vercel"],
      },
    ],
  },
};

const defaultGithubConfig = {
  github: {
    users: [
      {
        login: "octocat",
        name: "The Octocat",
        email: "octocat@github.com",
        bio: "I am the Octocat",
        company: "GitHub",
        location: "San Francisco",
      },
    ],
    orgs: [
      {
        login: "my-org",
        name: "My Organization",
        description: "A test organization",
      },
    ],
    repos: [
      {
        owner: "octocat",
        name: "hello-world",
        description: "My first repository",
        language: "JavaScript",
        topics: ["hello", "world"],
        auto_init: true,
      },
      {
        owner: "my-org",
        name: "org-repo",
        description: "An organization repository",
        language: "TypeScript",
        auto_init: true,
      },
    ],
    oauth_apps: [
      {
        client_id: "Iv1.example_client_id",
        client_secret: "example_client_secret",
        name: "My App",
        redirect_uris: ["http://localhost:3000/api/auth/callback/github"],
      },
    ],
  },
};

const defaultGoogleConfig = {
  google: {
    users: [
      {
        email: "testuser@example.com",
        name: "Test User",
        picture: "https://lh3.googleusercontent.com/a/default-user",
        email_verified: true,
      },
    ],
    oauth_clients: [
      {
        client_id: "example-client-id.apps.googleusercontent.com",
        client_secret: "GOCSPX-example_secret",
        name: "Code App (Google)",
        redirect_uris: ["http://localhost:3000/api/auth/callback/google"],
      },
    ],
    labels: [
      {
        id: "Label_ops",
        user_email: "testuser@example.com",
        name: "Ops/Review",
        color_background: "#DDEEFF",
        color_text: "#111111",
      },
    ],
    messages: [
      {
        id: "msg_welcome",
        user_email: "testuser@example.com",
        from: "welcome@example.com",
        to: "testuser@example.com",
        subject: "Welcome to the Gmail emulator",
        body_text: "You can now test Gmail messages, threads, and labels locally.",
        label_ids: ["INBOX", "UNREAD", "CATEGORY_UPDATES"],
        date: "2025-01-04T10:00:00.000Z",
      },
    ],
  },
};

const defaultTokens = {
  tokens: {
    "gho_test_token_admin": {
      login: "admin",
      scopes: ["repo", "user", "admin:org", "admin:repo_hook"],
    },
    "gho_test_token_user1": {
      login: "octocat",
      scopes: ["repo", "user"],
    },
  },
};

const serviceConfigs: Record<string, Record<string, unknown>> = {
  vercel: defaultVercelConfig,
  github: defaultGithubConfig,
  google: defaultGoogleConfig,
};

export function initCommand(options: InitOptions): void {
  const filename = "emulate.config.yaml";
  const fullPath = resolve(filename);

  if (existsSync(fullPath)) {
    console.error(`Config file already exists: ${filename}`);
    process.exit(1);
  }

  let config: Record<string, unknown>;
  if (options.service === "all") {
    config = {
      ...defaultTokens,
      ...defaultVercelConfig,
      ...defaultGithubConfig,
      ...defaultGoogleConfig,
    };
  } else {
    const svcConfig = serviceConfigs[options.service];
    if (!svcConfig) {
      console.error(`Unknown service: ${options.service}. Available: ${Object.keys(serviceConfigs).join(", ")}, all`);
      process.exit(1);
    }
    config = { ...defaultTokens, ...svcConfig };
  }

  const content = yamlStringify(config);
  writeFileSync(fullPath, content, "utf-8");

  console.log(`Created ${filename}`);
  console.log(`\nRun 'emulate' to start the emulator.`);
}
