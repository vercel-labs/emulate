import { PassThrough } from "node:stream";
import { Option, type Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../program.js";
import { startMcpServer } from "../mcp.js";
import { createJsonRpcStream } from "./mcp-protocol.js";

type Tool = {
  name: string;
  description?: string;
  inputSchema: { properties: Record<string, unknown>; [key: string]: unknown };
};

vi.mock("../program.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../program.js")>();
  return { ...original, createProgram: vi.fn(original.createProgram) };
});

const original = await vi.importActual<typeof import("../program.js")>("../program.js");
const cleanups: Array<() => Promise<void>> = [];
const unsupportedCommands: Array<[string, (program: Command) => void, string]> = [
  [
    "executable command",
    (p) => p.command("external", "External", { executableFile: "external.js" }),
    "Unsupported MCP command form",
  ],
  [
    "parent action",
    (p) =>
      p
        .command("parent")
        .action(() => {})
        .command("child"),
    "Unsupported MCP command form",
  ],
  [
    "wrong default type",
    (p) => p.command("bad").addOption(new Option("--count <count>").default(true)),
    "Unsupported MCP default",
  ],
  ["reserved stop name", (p) => p.command("stop"), "Conflicting or unsupported MCP tool name"],
  ["invalid tool name", (p) => p.command("invalid.name"), "Conflicting or unsupported MCP tool name"],
  [
    "colliding names",
    (p) => {
      p.command("parent_child");
      p.command("parent").command("child");
    },
    "Conflicting or unsupported MCP tool name",
  ],
  ["variadic option", (p) => p.command("bad").option("--items <items...>"), "Unsupported MCP option"],
  ["optional value", (p) => p.command("bad").option("--value [value]"), "Unsupported MCP option"],
  ["positional argument", (p) => p.command("bad <path>"), "positional arguments"],
];

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
    vi.mocked(createProgram).mockImplementation(original.createProgram);
  }
});

async function connect() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdin.resume();
  vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as typeof process.stdin);
  vi.spyOn(process, "stdout", "get").mockReturnValue(stdout as unknown as typeof process.stdout);
  const client = createJsonRpcStream(stdout, stdin);
  const done = startMcpServer();
  cleanups.push(async () => {
    try {
      stdin.end();
      await done;
    } finally {
      client.close();
      stdout.destroy();
    }
  });
  const initialized = await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "emulate-test", version: "1.0.0" },
  });
  expect(initialized.result).toMatchObject({
    protocolVersion: "2024-11-05",
    capabilities: { tools: {} },
    serverInfo: { name: "emulate" },
  });
  client.notification("notifications/initialized");
  return client;
}

describe("MCP command discovery", () => {
  it("maps actual Commander commands, option types, and CLI defaults", async () => {
    const client = await connect();
    const { tools } = (await client.request("tools/list", {})).result as { tools: Tool[] };
    const program = original.createProgram();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...program.commands.map((command) => command.name()), "stop"].sort(),
    );
    const start = tools.find((tool) => tool.name === "start")!;
    expect(start.description).toBe(program.commands.find((command) => command.name() === "start")!.description());
    expect(start.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        port: { type: "string", default: process.env.EMULATE_PORT ?? process.env.PORT ?? "4000" },
        host: { type: "string", default: "127.0.0.1" },
        generatedSecretsFile: { type: "string" },
        baseUrl: { type: "string" },
        watch: { type: "boolean" },
      },
    });
    expect(tools.find((tool) => tool.name === "list")!.inputSchema.properties).toHaveProperty("config");
    for (const tool of tools) {
      expect(tool.inputSchema.properties).not.toHaveProperty("json");
      expect(tool.inputSchema.properties).not.toHaveProperty("help");
      expect(tool.inputSchema.properties).not.toHaveProperty("version");
    }
  });

  it("discovers nested commands, inherited flags, aliases, and option constraints", async () => {
    vi.mocked(createProgram).mockImplementation(() => {
      const program = original.createProgram();
      program
        .command("inspect")
        .option("--region <region>", "Region", "local")
        .command("echo")
        .alias("say")
        .requiredOption("--message <message>", "Message")
        .option("--loud", "Uppercase the message", true)
        .option("--no-color", "Disable color")
        .addOption(new Option("--mode <mode>", "Mode").choices(["plain", "raw"]).default("plain"));
      return program;
    });
    const client = await connect();
    const { tools } = (await client.request("tools/list", {})).result as { tools: Tool[] };
    expect(tools.find((tool) => tool.name === "inspect_echo")!.inputSchema).toMatchObject({
      required: ["message"],
      properties: {
        region: { type: "string", default: "local" },
        message: { type: "string" },
        loud: { type: "boolean", default: true },
        color: { type: "boolean", default: true },
        mode: { type: "string", default: "plain", enum: ["plain", "raw"] },
      },
    });
  });

  it.each(unsupportedCommands)("rejects %s during automatic tool discovery", async (_name, add, error) => {
    vi.mocked(createProgram).mockImplementation(() => {
      const program = original.createProgram();
      add(program);
      return program;
    });
    await expect(startMcpServer()).rejects.toThrow(error);
  });
});
