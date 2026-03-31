import type { Hono } from "hono";
import type { ServicePlugin, Store, WebhookDispatcher, TokenMap, AppEnv, RouteContext } from "@emulators/core";
import { getOpenAIStore } from "./store.js";
import { chatCompletionRoutes } from "./routes/chat-completions.js";
import { embeddingRoutes } from "./routes/embeddings.js";
import { modelRoutes } from "./routes/models.js";
import { playgroundRoutes } from "./routes/playground.js";

export { getOpenAIStore, type OpenAIStore } from "./store.js";
export * from "./entities.js";

export interface OpenAISeedConfig {
  port?: number;
  models?: Array<{
    id: string;
    owned_by?: string;
  }>;
  completions?: Array<{
    pattern: string;
    content: string;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: {
        name: string;
        arguments: string;
      };
    }>;
    model?: string;
  }>;
  chunk_delay_ms?: number;
}

const DEFAULT_MODELS = [
  { id: "gpt-4o", owned_by: "openai" },
  { id: "gpt-4o-mini", owned_by: "openai" },
  { id: "gpt-4-turbo", owned_by: "openai" },
  { id: "text-embedding-ada-002", owned_by: "openai" },
  { id: "text-embedding-3-small", owned_by: "openai" },
];

const DEFAULT_COMPLETIONS = [
  { pattern: "hello|hi|hey", content: "Hello! I'm the emulated assistant." },
  { pattern: ".*", content: "This is a mock response from the emulated OpenAI API." },
];

function seedDefaults(store: Store): void {
  const os = getOpenAIStore(store);

  for (const m of DEFAULT_MODELS) {
    const existing = os.models.findOneBy("model_id", m.id);
    if (!existing) {
      os.models.insert({ model_id: m.id, owned_by: m.owned_by, object: "model" });
    }
  }

  if (!store.getData("openai.completions")) {
    store.setData("openai.completions", DEFAULT_COMPLETIONS);
  }
}

export function seedFromConfig(store: Store, _baseUrl: string, config: OpenAISeedConfig): void {
  const os = getOpenAIStore(store);

  if (config.models) {
    for (const m of config.models) {
      const existing = os.models.findOneBy("model_id", m.id);
      if (existing) continue;
      os.models.insert({
        model_id: m.id,
        owned_by: m.owned_by ?? "openai",
        object: "model",
      });
    }
  }

  if (config.completions) {
    store.setData("openai.completions", config.completions);
  }
}

export const openaiPlugin: ServicePlugin = {
  name: "openai",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    chatCompletionRoutes(ctx);
    embeddingRoutes(ctx);
    modelRoutes(ctx);
    playgroundRoutes(ctx);
  },
  seed(store: Store, _baseUrl: string): void {
    seedDefaults(store);
  },
};

export default openaiPlugin;
