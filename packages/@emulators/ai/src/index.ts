import type { AppEnv, ContentfulStatusCode, Context, ServicePlugin, Store } from "@emulators/core";
import { aiErrorBody, registerAiRoutes, setAiSeed, SUPPORTED_DATA_PATHS } from "./dispatch.js";
import { AiRequestError } from "./errors.js";
import { parseConfig } from "./rules.js";
import type { AiConfig, Rule } from "./types.js";

export type * from "./types.js";
export { AiRequestError, AiConfigError } from "./errors.js";

/** Seed config accepted under the `ai` key. */
export interface AiSeedConfig {
  port?: number;
  baseUrl?: string;
  strict?: AiConfig["strict"];
  timing?: Partial<AiConfig["timing"]>;
  random?: Partial<AiConfig["random"]>;
  models?: AiConfig["models"];
  rules?: Array<Omit<Rule, "match"> & { match?: Rule["match"] }>;
}

/** Renders every AI error and unmatched path in the OpenAI error envelope. */
export function formatError(error: unknown, c: Context<AppEnv>, status: number): Response {
  if (error instanceof AiRequestError) {
    return c.json(
      aiErrorBody(status, error.message, error.param ?? null, error.code ?? null),
      status as ContentfulStatusCode,
    );
  }
  const message =
    status === 404 && !c.req.path.startsWith("/_emulate")
      ? `Not Found. Supported AI data paths: ${SUPPORTED_DATA_PATHS}.`
      : error instanceof Error
        ? error.message
        : "Internal Server Error";
  return c.json(aiErrorBody(status, message), status as ContentfulStatusCode);
}

/** Applies a seed `ai` block, validated so an unknown key fails at startup with its path. */
export function seedFromConfig(store: Store, _baseUrl: string, config: AiSeedConfig): void {
  setAiSeed(store, parseConfig(config));
}

/** The AI provider emulator plugin. */
export const aiPlugin: ServicePlugin = {
  name: "ai",
  rateLimit: false,
  abortOnClose: true,
  formatError,
  register(app, store, _webhooks, baseUrl, _tokenMap, options) {
    registerAiRoutes({ app, store, baseUrl, baseUrlDerived: options?.baseUrlDerived === true });
  },
  seed(store) {
    setAiSeed(store, parseConfig(undefined));
  },
};

export default aiPlugin;
