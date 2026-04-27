import { Command } from "commander";
import { startCommand } from "./commands/start.js";
import { initCommand } from "./commands/init.js";
import { listCommand } from "./commands/list.js";
import { recordCommand } from "./commands/record.js";

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
    });
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

program
  .command("record")
  .description("Record API traffic from a real service and generate a seed config")
  .requiredOption("-s, --service <service>", "Service to record (e.g., github, stripe)")
  .requiredOption("-u, --upstream <url>", "Upstream API URL to proxy to")
  .option("-p, --port <port>", "Local proxy port", defaultPort)
  .option("-o, --output <file>", "Output config file path", "emulate.config.yaml")
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    if (Number.isNaN(port) || port < 1 || port > 65535) {
      console.error(`Invalid port: ${opts.port}`);
      process.exit(1);
    }
    await recordCommand({
      port,
      upstream: opts.upstream,
      service: opts.service,
      output: opts.output,
    });
  });

program.parse();
