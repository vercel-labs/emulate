import type { Entity } from "@emulators/core";

export interface OpenAIModel extends Entity {
  model_id: string;
  owned_by: string;
  object: string;
}

export interface OpenAICompletionConfig {
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
}
