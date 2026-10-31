import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { listCommand } from "./commands/list.js";
import { SERVICE_NAMES } from "./registry.js";
import { projectStartCommand } from "./commands/project-start.js";
import { scaffoldCommand } from "./commands/scaffold.js";

declare const PKG_VERSION: string;

export function createProgram(): Command {
  const defaultPort = process.env.EMULATE_PORT ?? process.env.PORT ?? "4000";
  const program = new Command();

  program
    .name("emulate")
    .description("Local drop-in replacement services for CI and no-network sandboxes")
    .version(PKG_VERSION)
    .exitOverride()
    .configureOutput({ outputError: () => {} })
    .addHelpText(
      "after",
      `
Framework adapters:
  Embed emulators in app routes with @emulators/adapter-next or @emulators/adapter-nuxt.
  Docs: https://emulate.dev/docs/nextjs and https://emulate.dev/docs/nuxt

MCP:
  Run 'npx emulate mcp' for stdio tools backed by CLI commands.

Networking:
  Built-in and custom listeners bind to 127.0.0.1 by default.
  Use --host 0.0.0.0 for access from containers or other machines.
  createEmulator accepts hostname for the listening address.
  Use --base-url or baseUrl for advertised URLs reachable by those clients.

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
  Check-run lists paginate with page/per_page (default 30, maximum 100) and Link headers.
  Ref lists filter before pagination; total_count includes all filtered runs.
  Checks retain the authenticated installation's App in API responses and webhooks.
  Suites are separated by App and commit; latest runs are grouped by App and check name.
  User-token checks return app: null; request-body app_id cannot change attribution.
  Inspect minted installation-token metadata at GET /_emulate/installation-tokens.

Linear API coverage:
  Issue queries and mutations include numeric priority and derived priorityLabel fields.

Vercel API coverage:
  GET /v7/deployments lists deployments by commit SHA across a team's projects, with cursor pagination.

AWS API coverage:
  S3 uploads and downloads preserve arbitrary binary payloads, including raw byte lengths and ETags.
  SQS supports current AWS SDK clients using AWS JSON 1.0 at /sqs, alongside XML Query requests.
  Queue operations also accept the returned QueueUrl as the endpoint.
  Cognito User Pools use /cognito-idp and Identity Pools use /cognito-identity with the AWS SDK v3.
  Seed aws.cognito.user_pools and identity_pools; defaults are us-east-1_emulate and app client emulateclient.
  Sign-up, confirmation, password/reset/refresh flows, new-password challenges, and admin user operations are supported.
  Local confirmation codes default to 123456 and appear at /_inspector?tab=cognito; no email/SMS is sent.
  RS256 tokens, discovery, and JWKS use the issuer BASE_URL/cognito-idp/USER_POOL_ID.
  That issuer serves /oauth2/authorize (local user picker), /oauth2/token (code/refresh + S256 PKCE), and /oauth2/userInfo.
  Identity Pools support GetId and GetCredentialsForIdentity with validated User Pool ID tokens.
  SRP, MFA, external federation, pool/client management APIs, and IAM policy/signature evaluation are not simulated.

Google Calendar discovery:
  GET /discovery/v1/apis/calendar/v3/rest returns the public discovery document for the emulated Calendar v3 surface.

Google OIDC:
  Discovery advertises RS256 ID tokens, and GET /oauth2/v3/certs returns the RSA public key used to verify them.
  Set google.strict_scopes: true in seed config to validate issued access tokens, expiry, revocation, and method scopes.
  Strict mode returns Google-style 401/403 errors and limits userinfo claims; bearer-token defaults remain permissive.

Resend API coverage:
  POST /emails and POST /emails/batch support 24-hour Idempotency-Key replay without duplicate emails or webhooks.
  Optional resend.allowlist restricts to/cc/bcc recipients; [] rejects all, and omission accepts all.
  Rejected batches create no emails or webhooks. Validated sends record resend.send_attempts in saved state.
  Idempotency replays and malformed requests do not add attempts; rejected sends can be retried with the same key.

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

Slack interactivity:
  Configure slack.oauth_apps[].interactivity_url and slack.signing_secret for signed button and modal callbacks.
  POST /_slack/simulate/block-actions clicks a stored button; POST /_slack/simulate/view-submission submits a modal.
  Button response URLs support private/public replies and source updates for five uses within 30 minutes.
  Modal acknowledgements can close, clear, update, push, or show errors. Triggers expire in 3 seconds by default;
  slack.view_trigger_ttl_seconds can extend their lifetime for local tests.

Slack app lifecycle:
  POST /api/apps.uninstall accepts client_id, client_secret, and a user token or configured development token.
  It revokes the app's OAuth credentials in that workspace and emits app_uninstalled and tokens_revoked.
  Revoked tokens return token_revoked even with permissive authentication. Granular bot tokens return no_permission.
  A new OAuth installation issues fresh credentials; other apps and workspaces are unaffected.

Slack message limits:
  Slack text fields are limited to 40,000 Unicode characters. Longer text is truncated safely,
  and successful Web API responses include message_truncated warning metadata.

Slack channel privacy:
  POST /api/admin.conversations.convertToPrivate and convertToPublic accept channel_id.
  Use a user token for a seeded admin; bot/test tokens and non-admin users are rejected.
  Strict scopes require admin.conversations:write. Conversions update visibility and emit conversion messages.
  DMs, MPIMs, and repeated conversions are rejected; #general cannot become private.
  Enterprise plan, organization installation, and channel-management policies are not simulated.

Slack Connect fixtures:
  Seed slack.users[].team_id to model an external author; is_stranger is an optional fixture flag.
  Channels with external members report is_ext_shared and is_shared; events include is_ext_shared_channel.
  App mentions carry the external author's user_team/source_team while the envelope keeps the receiving team.
  Seed slack.channels[].is_ext_shared for existing shares. Invitation/approval and workspace unlink flows are not simulated.

Slack event callbacks:
  POST /_slack/simulate/event-retry accepts event_id and optional reason (default http_timeout).
  It resends the latest recorded delivery with increasing retry headers and a fresh Slack signature when configured.
  Retries are explicit, target one original subscription, and require retained in-memory delivery history.
  Event callbacks include token, api_app_id, authorizations, team_id, event_id, and event_time.
  The team comes from the presented token's installation, or affected resource or seeded team
  for development tokens. Incoming webhooks use their webhook or target channel team.
  Each logical event has a distinct ID shared across subscriber deliveries.
  chat.postMessage emits app_mention for installed bots mentioned as <@BOT_USER_ID> in joined channels.
  Subscribe to app_mention and invite the bot with conversations.invite. DMs and MPIMs use message events.
  Mention callbacks include api_app_id and retain message and thread identity.
  Each workspace installation receives its own envelope; shared subscriptions can route by api_app_id.
  Without an installation, api_app_id is A000000001. verification_token defaults to emulate-verification-token.
  Inner events include event_ts; message events identify channel, group, im, or mpim in channel_type.
  Issued or seeded bot tokens add stored bot identity to messages, history, and replies.
  Removing an installed bot emits channel_left or group_left with actor_id and event_ts.
`,
    );

  program
    .command("start", { isDefault: true })
    .description("Start the emulator server")
    .option("-p, --port <port>", "Base port", defaultPort)
    .option("--host <host>", "Listening address (use 0.0.0.0 for network access)", "127.0.0.1")
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
      if (Number.isNaN(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${opts.port}`);
      await projectStartCommand({
        port,
        host: opts.host,
        service: opts.service,
        seed: opts.seed,
        config: opts.config,
        watch: opts.watch,
        baseUrl: opts.baseUrl,
        portless: opts.portless,
        generatedSecretsFile: opts.generatedSecretsFile,
      });
    });

  program
    .command("init")
    .description("Generate a starter config file")
    .option("-s, --service <service>", "Service to generate config for", "all")
    .option("--custom <name>", "Scaffold a third-party API emulator, config, and test")
    .option("--config <file>", "Existing configuration to update when scaffolding a custom API")
    .action((opts) => {
      if (opts.custom) scaffoldCommand(opts.custom, opts.config);
      else initCommand({ service: opts.service });
    });

  program
    .command("list")
    .alias("list-services")
    .description("List available services")
    .option("--config <file>", "Configuration containing custom services")
    .action(async (opts) => {
      await listCommand(opts.config);
    });

  return program;
}
