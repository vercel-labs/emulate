import { CommanderError } from "commander";
import { createProgram } from "./program.js";

const program = createProgram();
program
  .command("mcp")
  .description("Start the MCP server over stdio")
  .action(async () => {
    await (await import("./mcp.js")).startMcpServer();
  });

try {
  await program.parseAsync();
} catch (error) {
  const exitCode = error instanceof CommanderError ? error.exitCode : 1;
  if (exitCode) console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = exitCode;
}
