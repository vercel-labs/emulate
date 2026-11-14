import { CommanderError } from "commander";
import { createProgram } from "./program.js";

const program = createProgram();
program
  .command("mcp")
  .description("Start the MCP server over stdio")
  .action(async () => {
    await (await import("./mcp.js")).startMcpServer();
  });

// Registered here rather than in createProgram: it runs until interrupted, so
// like mcp itself it should not surface as an MCP tool.
program
  .command("record")
  .description("Record API traffic from a real service and generate a seed config")
  .requiredOption("-s, --service <service>", "Service to record (e.g., github, stripe)")
  .requiredOption("-u, --upstream <url>", "Upstream API URL to proxy to")
  .option("-p, --port <port>", "Local proxy port", process.env.EMULATE_PORT ?? process.env.PORT ?? "4000")
  .option("-o, --output <file>", "Output config file path", "emulate.config.yaml")
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    if (Number.isNaN(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${opts.port}`);
    const { recordCommand } = await import("./commands/record.js");
    await recordCommand({
      port,
      upstream: opts.upstream,
      service: opts.service,
      output: opts.output,
    });
  });

try {
  await program.parseAsync();
} catch (error) {
  const exitCode = error instanceof CommanderError ? error.exitCode : 1;
  if (exitCode) console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = exitCode;
}
