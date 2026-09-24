import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { listCommand } from "./commands/list.js";
import { SERVICE_NAMES } from "./registry.js";
import { projectStartCommand } from "./commands/project-start.js";
import { scaffoldCommand } from "./commands/scaffold.js";

declare const PKG_VERSION: string;
const pkg = { version: PKG_VERSION };

const defaultPort = process.env.EMULATE_PORT ?? process.env.PORT ?? "4000";

const program = new Command();

program
  .name("emulate")
  .description("Local drop-in replacement services for CI and no-network sandboxes")
  .version(pkg.version)
  .addHelpText(
    "after",
    `
Framework adapters:
  Embed emulators in app routes with @emulators/adapter-next or @emulators/adapter-nuxt.
  Docs: https://emulate.dev/docs/nextjs and https://emulate.dev/docs/nuxt

Custom emulators:
  Build and share emulators for third-party HTTP APIs alongside the built-in services.
  Run 'npx emulate init --custom inventory' to scaffold an emulator, config, and runnable test.
  Adapt the generated inventory routes, state, and test to the provider your app uses.
  Existing YAML, JSON, TypeScript, and JavaScript configs get a service entry when supported.
  For unusual executable configs, init prints the import and service entry to add manually.
  Init prints the test command; use the service URL and Inspector link printed by start for requests.
  Run 'npx emulate start --watch' to reload local modules and inspect requests at /_emulate.
  Creating a missing local import retries a failed reload, including outside the config directory.
  Import defineEmulator, defineConfig, and createEmulator from 'emulate'.
  Test in process with createEmulator({ service: yourDefinition, listen: false }).
  Custom emulators support seeds, reset, snapshots, restore, and opt-in persistence.
  Streamed responses persist state changes during delivery; reset and close cancel active streams before cleanup.
  Appended Set-Cookie headers retain cookies already on a response.
  Config accepts local TypeScript/JavaScript files and installed packages alongside built-ins.
  Node loads TypeScript with tsconfig aliases and source maps; no extra runtime packages are needed.
  Node 26 requires erasable TypeScript; compile enums and parameter properties to JavaScript first.
  Node 24 also supports native TypeScript transforms.
  Successful watch reloads reset the run to seed; auto-detected config files created later also trigger reloads.
  Reload errors keep the previous runner when possible.
  Structured inspection redacts token and secret fields, including access_token and client_secret.
  Framework adapters keep root-relative custom redirects under the service mount.
  Export OPTIONS from the Next.js handler to forward preflight and custom OPTIONS routes.
  Docs: https://emulate.dev/docs/custom-emulators

GitHub API coverage:
  Includes repository contents, raw downloads, raw media negotiation for file Contents and README responses,
  commit history, commit details, ref comparisons, organization membership seeding with member/admin roles,
  and Checks list-by-ref endpoints for branch and tag refs containing slashes.
  Inspect minted installation-token metadata at GET /_emulate/installation-tokens.

Linear API coverage:
  Issue queries and mutations include numeric priority and derived priorityLabel fields.

Vercel API coverage:
  GET /v7/deployments lists deployments by commit SHA across a team's projects, with cursor pagination.

AWS API coverage:
  S3 uploads and downloads preserve arbitrary binary payloads, including raw byte lengths and ETags.

Google Calendar discovery:
  GET /discovery/v1/apis/calendar/v3/rest returns the public discovery document for the emulated Calendar v3 surface.

Google OIDC:
  Discovery advertises RS256 ID tokens, and GET /oauth2/v3/certs returns the RSA public key used to verify them.

Resend API coverage:
  POST /emails and POST /emails/batch support 24-hour Idempotency-Key replay without duplicate emails or webhooks.

Microsoft OAuth coverage:
  Refresh tokens are bound to the issuing client and require its client_id and client_secret, or client_secret_basic.
  Legacy refresh records without a stored client binding remain supported.

Webhook signatures:
  Stripe webhook secrets produce a Stripe-Signature header for raw-body verification.
  Slack signing_secret produces X-Slack-Request-Timestamp and X-Slack-Signature for outbound event callbacks.
  The Slack signature covers v0:<timestamp>:<raw-body>; configure the receiver with the same secret.
  Slack callbacks are unsigned when signing_secret is absent or empty.

Available services:
  ${SERVICE_NAMES.join(", ")}
  Run 'npx emulate list' for endpoint summaries.

Configuration:
  Run 'npx emulate init' to create a starter emulate.config.yaml, or pass --seed <file>.
  GitHub App private keys may be omitted for createEmulator; CLI startup generates omitted keys only with
  --generated-secrets-file <path>.

Twilio API coverage:
  Accounts, API keys, phone numbers, Messaging, Verify, Voice, Conversations, webhooks, simulators, and inspector.

Slack message limits:
  Slack text fields are limited to 40,000 Unicode characters. Longer text is truncated safely,
  and successful Web API responses include message_truncated warning metadata.

Slack event callbacks:
  Emitted event_callback payloads include team_id, event_id, and Unix-seconds event_time.
  The team comes from the presented token's installation, or affected resource or seeded team
  for development tokens. Incoming webhooks use their webhook or target channel team.
  Each logical event has a distinct ID shared across subscriber deliveries.
`,
  );

program
  .command("start", { isDefault: true })
  .description("Start the emulator server")
  .option("-p, --port <port>", "Base port", defaultPort)
  .option("-s, --service <services>", "Comma-separated services to enable")
  .option("--seed <file>", "Path to seed config file")
  .option("--config <file>", "Path to TypeScript, JavaScript, YAML, or JSON configuration")
  .option("--watch", "Watch imports and fixtures; successful reloads reset state to seed")
  .option("--base-url <url>", "Override advertised base URL (supports {service} template)")
  .option("--portless", "Serve over HTTPS via portless (auto-registers aliases)")
  .option(
    "--generated-secrets-file <path>",
    "Write service-generated secrets to a new owner-only JSON file (Linux requires setfacl and getfacl)",
  )
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    if (Number.isNaN(port) || port < 1 || port > 65535) {
      console.error(`Invalid port: ${opts.port}`);
      process.exit(1);
    }
    const options = {
      port,
      service: opts.service,
      seed: opts.seed,
      config: opts.config,
      watch: opts.watch,
      baseUrl: opts.baseUrl,
      portless: opts.portless,
      generatedSecretsFile: opts.generatedSecretsFile,
    };
    try {
      await projectStartCommand(options);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program
  .command("init")
  .description("Generate a starter config file")
  .option("-s, --service <service>", "Service to generate config for", "all")
  .option("--custom <name>", "Scaffold a third-party API emulator, config, and test")
  .option("--config <file>", "Existing configuration to update when scaffolding a custom API")
  .action((opts) => {
    try {
      if (opts.custom) scaffoldCommand(opts.custom, opts.config);
      else initCommand({ service: opts.service });
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  });

program
  .command("list")
  .alias("list-services")
  .description("List available services")
  .option("--config <file>", "Configuration containing custom services")
  .action(async (opts) => {
    try {
      await listCommand(opts.config);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  });

program.parse();
