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
        body_text: "You can now test Gmail, Calendar, and Drive flows locally.",
        label_ids: ["INBOX", "UNREAD", "CATEGORY_UPDATES"],
        date: "2025-01-04T10:00:00.000Z",
      },
    ],
    calendars: [
      {
        id: "primary",
        user_email: "testuser@example.com",
        summary: "testuser@example.com",
        primary: true,
        selected: true,
        time_zone: "UTC",
      },
    ],
    calendar_events: [
      {
        id: "evt_kickoff",
        user_email: "testuser@example.com",
        calendar_id: "primary",
        summary: "Project Kickoff",
        start_date_time: "2025-01-10T09:00:00.000Z",
        end_date_time: "2025-01-10T09:30:00.000Z",
      },
    ],
    drive_items: [
      {
        id: "drv_docs",
        user_email: "testuser@example.com",
        name: "Docs",
        mime_type: "application/vnd.google-apps.folder",
        parent_ids: ["root"],
      },
    ],
  },
};

const defaultAppleConfig = {
  apple: {
    users: [
      {
        email: "testuser@icloud.com",
        name: "Test User",
      },
    ],
    oauth_clients: [
      {
        client_id: "com.example.app",
        team_id: "TEAM001",
        name: "My Apple App",
        redirect_uris: ["http://localhost:3000/api/auth/callback/apple"],
      },
    ],
  },
};

const defaultMicrosoftConfig = {
  microsoft: {
    users: [
      {
        email: "testuser@outlook.com",
        name: "Test User",
      },
    ],
    oauth_clients: [
      {
        client_id: "example-client-id",
        client_secret: "example-client-secret",
        name: "My Microsoft App",
        redirect_uris: ["http://localhost:3000/api/auth/callback/microsoft-entra-id"],
      },
    ],
  },
};

const defaultSlackConfig = {
  slack: {
    team: {
      name: "My Workspace",
      domain: "my-workspace",
    },
    users: [
      {
        name: "developer",
        real_name: "Developer",
        email: "dev@example.com",
      },
    ],
    channels: [
      {
        name: "general",
        topic: "General discussion",
      },
      {
        name: "random",
        topic: "Random stuff",
      },
    ],
    bots: [
      {
        name: "my-bot",
      },
    ],
    oauth_apps: [
      {
        client_id: "12345.67890",
        client_secret: "example_client_secret",
        name: "My Slack App",
        redirect_uris: ["http://localhost:3000/api/auth/callback/slack"],
      },
    ],
  },
};

const defaultAwsConfig = {
  aws: {
    region: "us-east-1",
    s3: {
      buckets: [
        {
          name: "my-app-bucket",
        },
        {
          name: "my-app-uploads",
        },
      ],
    },
    sqs: {
      queues: [
        {
          name: "my-app-events",
        },
        {
          name: "my-app-dlq",
        },
      ],
    },
    iam: {
      users: [
        {
          user_name: "developer",
          create_access_key: true,
        },
      ],
      roles: [
        {
          role_name: "lambda-execution-role",
          description: "Role for Lambda function execution",
        },
      ],
    },
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
  slack: defaultSlackConfig,
  apple: defaultAppleConfig,
  microsoft: defaultMicrosoftConfig,
  aws: defaultAwsConfig,
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
      ...defaultSlackConfig,
      ...defaultAppleConfig,
      ...defaultMicrosoftConfig,
      ...defaultAwsConfig,
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
