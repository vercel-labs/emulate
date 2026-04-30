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
  .version(pkg.version);

program
  .command("start", { isDefault: true })
  .description("Start the emulator server")
  .option("-p, --port <port>", "Base port", defaultPort)
  .option("-s, --service <services>", "Comma-separated services to enable")
  .option("--seed <file>", "Path to seed config file")
  .option("--base-url <url>", "Override advertised base URL (supports {service} template)")
  .option("--portless", "Serve over HTTPS via portless (auto-registers aliases)")
  .option("--slug <slug>", "Namespace slug for portless URLs: <service>.<slug>.emulate.localhost")
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    if (Number.isNaN(port) || port < 1 || port > 65535) {
      console.error(`Invalid port: ${opts.port}`);
      process.exit(1);
    }
    await startCommand({
      port,
      service: opts.service,
      seed: opts.seed,
      baseUrl: opts.baseUrl,
      portless: opts.portless,
      slug: opts.slug,
    });
  });

program
  .command("init")
  .description("Generate a starter config file")
  .option("-s, --service <service>", "Service to generate config for", "all")
  .option("--slug <slug>", "Project slug for portless URLs (defaults to no slug)")
  .action((opts) => {
    initCommand({ service: opts.service, slug: opts.slug });
  });

program
  .command("list")
  .alias("list-services")
  .description("List available services")
  .action(() => {
    listCommand();
  });

program.parse();
