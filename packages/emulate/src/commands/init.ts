import { writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { stringify as yamlStringify } from "yaml";
import { DEFAULT_TOKENS, getBuiltInServiceNames, resolveServiceEntries } from "../registry.js";

interface InitOptions {
  service: string;
  plugin?: string;
}

export async function initCommand(options: InitOptions): Promise<void> {
  const filename = "emulate.config.yaml";
  const fullPath = resolve(filename);

  if (existsSync(fullPath)) {
    console.error(`Config file already exists: ${filename}`);
    process.exit(1);
  }

  const pluginSpecifiers = options.plugin?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  const registry = await resolveServiceEntries(pluginSpecifiers);
  const builtInServices = getBuiltInServiceNames();
  const availableServices = Object.keys(registry);

  let config: Record<string, unknown>;
  if (options.service === "all") {
    config = { ...DEFAULT_TOKENS };
    for (const name of builtInServices) {
      Object.assign(config, registry[name].initConfig);
    }
  } else {
    const entry = registry[options.service];
    if (!entry) {
      console.error(`Unknown service: ${options.service}. Available: ${availableServices.join(", ")}, all`);
      process.exit(1);
    }
    config = { ...DEFAULT_TOKENS, ...entry.initConfig };
  }

  const content = yamlStringify(config);
  writeFileSync(fullPath, content, "utf-8");

  console.log(`Created ${filename}`);
  console.log(`\nRun 'npx emulate' to start the emulator.`);
}
