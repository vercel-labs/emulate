import { SERVICE_REGISTRY } from "../registry.js";
import { loadConfig } from "../config-loader.js";

export async function listCommand(configPath?: string) {
  const services = Object.entries(SERVICE_REGISTRY).map(([name, entry]) => ({
    name,
    label: entry.label,
    endpoints: entry.endpoints,
  }));
  const lines = ["\nAvailable services:\n"];
  for (const service of services) {
    lines.push(`  ${service.name.padEnd(10)}${service.label}`, `            Endpoints: ${service.endpoints}`, "");
  }
  const config = await loadConfig({ config: configPath });
  try {
    const configuredInstances = config.services
      .filter((service) => typeof service.emulator !== "string" || service.emulator !== service.name)
      .map(({ name, source }) => ({ name, source }));
    if (configuredInstances.length) lines.push("Configured instances:\n");
    for (const service of configuredInstances) lines.push(`  ${service.name.padEnd(16)}${service.source}`);
    console.log(lines.join("\n"));
  } finally {
    config.loader.close();
  }
}
