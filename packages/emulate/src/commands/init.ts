import { writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { stringify as yamlStringify } from "yaml";
import { SERVICE_REGISTRY, SERVICE_NAMES, DEFAULT_TOKENS, type ServiceName } from "../registry.js";

interface InitOptions {
  service: string;
}

export function initCommand(options: InitOptions) {
  const filename = "emulate.config.yaml";
  const fullPath = resolve(filename);

  if (existsSync(fullPath)) throw new Error(`Config file already exists: ${filename}`);

  let config: Record<string, unknown>;
  if (options.service === "all") {
    config = { ...DEFAULT_TOKENS };
    for (const name of SERVICE_NAMES) {
      Object.assign(config, SERVICE_REGISTRY[name].initConfig);
    }
  } else {
    if (!Object.hasOwn(SERVICE_REGISTRY, options.service)) {
      throw new Error(`Unknown service: ${options.service}. Available: ${SERVICE_NAMES.join(", ")}, all`);
    }
    const entry = SERVICE_REGISTRY[options.service as ServiceName];
    config = { ...DEFAULT_TOKENS, ...entry.initConfig };
  }

  const content = yamlStringify(config);
  writeFileSync(fullPath, content, { encoding: "utf-8", flag: "wx" });

  console.log(`Created ${filename}\n\nRun 'npx emulate' to start the emulator.`);
}
