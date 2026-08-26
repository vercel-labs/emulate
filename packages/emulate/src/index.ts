import { Command } from "commander";
import { startCommand } from "./commands/start.js";
import { initCommand } from "./commands/init.js";
import { listCommand } from "./commands/list.js";

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

GitHub API coverage:
  Includes repository contents, raw downloads, commit history, commit details, ref comparisons, and duplicate issue lifecycle state.
  Includes authenticated GraphQL reads for repositories, issues, labels, and issue comments at POST /graphql.
  Includes GraphQL issue relationships and addSubIssue/addBlockedBy mutations with clientMutationId echoes.
  Includes GraphQL issue and comment mutations, exact issue deletion returning its repository, and repository label create/delete with clientMutationId echoes. Issue deletion emits no webhook or issue event because provider behavior is not established by emulator evidence.
  GitHub GraphQL qualification covers the documented issue-graph subset with opaque 100-item connections; seeded issue-graph fixtures and reset-specific guarantees are covered by qualification tests.
  GraphQL and REST share a locally consistent rate-limit bucket; GitHub operation-cost fidelity and remote quota enforcement are not modeled.
  Includes ordered issue relationships alongside repository contents, raw downloads, commit history, commit details, and ref comparisons.
  Issue parent, sub-issue, and dependency REST routes support pagination, Link headers, permissions, and cycle-safe mutations.
  GitHub seeds accept keyed labels, issues, comments, parent-child edges, and dependencies. Graph references are validated before startup, and reset restores the seeded graph and node IDs.

Webhook signatures:
  Stripe webhook secrets produce a Stripe-Signature header for raw-body verification.
`,
  );

program
  .command("start", { isDefault: true })
  .description("Start the emulator server")
  .option("-p, --port <port>", "Base port", defaultPort)
  .option("-s, --service <services>", "Comma-separated services to enable")
  .option("--seed <file>", "Path to seed config file")
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
      baseUrl: opts.baseUrl,
      portless: opts.portless,
      generatedSecretsFile: opts.generatedSecretsFile,
    };
    if (!opts.generatedSecretsFile) {
      await startCommand(options);
      return;
    }
    try {
      await startCommand(options);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program
  .command("init")
  .description("Generate a starter config file")
  .option("-s, --service <service>", "Service to generate config for", "all")
  .action((opts) => {
    initCommand({ service: opts.service });
  });

program
  .command("list")
  .alias("list-services")
  .description("List available services")
  .action(() => {
    listCommand();
  });

program.parse();
