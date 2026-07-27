import { Store, type Collection } from "@emulators/core";
import type { OpenAIModel } from "./entities.js";

export interface OpenAIStore {
  models: Collection<OpenAIModel>;
}

export function getOpenAIStore(store: Store): OpenAIStore {
  return {
    models: store.collection<OpenAIModel>("openai.models", ["model_id"]),
  };
}
