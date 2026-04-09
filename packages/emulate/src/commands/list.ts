import { resolveServiceEntries } from "../registry.js";

interface ListOptions {
  plugin?: string;
}

export async function listCommand(options: ListOptions = {}): Promise<void> {
  const pluginSpecifiers = options.plugin?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  const registry = await resolveServiceEntries(pluginSpecifiers);

  console.log("\nAvailable services:\n");
  for (const [name, entry] of Object.entries(registry)) {
    console.log(`  ${name.padEnd(10)}${entry.label}`);
    console.log(`            Endpoints: ${entry.endpoints}`);
    console.log();
  }
}
