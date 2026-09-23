import { SERVICE_REGISTRY } from "../registry.js";
import { loadConfig } from "../config-loader.js";

export async function listCommand(configPath?: string): Promise<void> {
  console.log("\nAvailable services:\n");
  for (const [name, entry] of Object.entries(SERVICE_REGISTRY)) {
    console.log(`  ${name.padEnd(10)}${entry.label}`);
    console.log(`            Endpoints: ${entry.endpoints}`);
    console.log();
  }
  const config = await loadConfig({ config: configPath });
  try {
    const custom = config.services.filter(
      (service) => typeof service.emulator !== "string" || service.emulator !== service.name,
    );
    if (custom.length) console.log("Configured instances:\n");
    for (const service of custom) console.log(`  ${service.name.padEnd(16)}${service.source}`);
  } finally {
    config.loader.close();
  }
}
