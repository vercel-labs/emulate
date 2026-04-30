import { writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { stringify as yamlStringify } from "yaml";
import { SERVICE_REGISTRY, SERVICE_NAMES, DEFAULT_TOKENS, type ServiceName } from "../registry.js";

interface InitOptions {
  service: string;
  slug?: string;
}

export function initCommand(options: InitOptions): void {
  const filename = "emulate.config.yaml";
  const fullPath = resolve(filename);

  if (existsSync(fullPath)) {
    console.error(`Config file already exists: ${filename}`);
    process.exit(1);
  }

  let config: Record<string, unknown>;
  if (options.service === "all") {
    config = { ...DEFAULT_TOKENS };
    for (const name of SERVICE_NAMES) {
      Object.assign(config, SERVICE_REGISTRY[name].initConfig);
    }
  } else {
    const entry = SERVICE_REGISTRY[options.service as ServiceName];
    if (!entry) {
      console.error(`Unknown service: ${options.service}. Available: ${SERVICE_NAMES.join(", ")}, all`);
      process.exit(1);
    }
    config = { ...DEFAULT_TOKENS, ...entry.initConfig };
  }

  if (options.slug) {
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(options.slug)) {
      console.error("Invalid slug: must be a lowercase DNS label (a-z, 0-9, hyphens, max 63 chars).");
      process.exit(1);
    }
    config = { slug: options.slug, ...config };
  }

  const content = yamlStringify(config);
  writeFileSync(fullPath, content, "utf-8");

  console.log(`Created ${filename}`);
  const startCmd = options.slug ? "npx emulate start --portless" : "npx emulate";
  console.log(`\nRun '${startCmd}' to start the emulator.`);
}
