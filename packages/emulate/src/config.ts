import type { EmulatorDefinition, InspectorOptions, PersistenceAdapter } from "@emulators/core";

export interface ServiceConfig<Definition extends EmulatorDefinition | string = EmulatorDefinition | string> {
  emulator: Definition;
  seed?: Definition extends EmulatorDefinition<infer State> ? State : Record<string, unknown>;
  port?: number;
  baseUrl?: string;
  inspector?: boolean | InspectorOptions;
  persistence?: PersistenceAdapter | string;
}

export interface EmulateConfig {
  services: Record<string, ServiceConfig>;
  watch?: string[];
  tokens?: Record<string, { login: string; scopes?: string[] }>;
}

export function defineConfig<Definitions extends Record<string, EmulatorDefinition | string>>(config: {
  services: { [Name in keyof Definitions]: ServiceConfig<Definitions[Name]> };
  watch?: string[];
  tokens?: EmulateConfig["tokens"];
}): typeof config {
  return config;
}
