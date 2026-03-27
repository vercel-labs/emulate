import type { RouteContext } from "@emulators/core";
import { parseJsonBody } from "@emulators/core";
import { openaiError, deterministicEmbedding } from "../helpers.js";

export function embeddingRoutes({ app }: RouteContext): void {
  app.post("/v1/embeddings", async (c) => {
    const body = await parseJsonBody(c);
    const model = typeof body.model === "string" ? body.model : "text-embedding-ada-002";
    const input = body.input;

    if (!input) {
      return openaiError(c, 400, "invalid_request_error", "Missing required parameter: 'input'.", "input");
    }

    const inputs: string[] = Array.isArray(input)
      ? input.map((i) => (typeof i === "string" ? i : String(i)))
      : [typeof input === "string" ? input : String(input)];

    const dimensions = typeof body.dimensions === "number" ? body.dimensions : 1536;

    const data = inputs.map((text, index) => ({
      object: "embedding" as const,
      index,
      embedding: deterministicEmbedding(text, dimensions),
    }));

    const totalTokens = inputs.reduce((acc, text) => acc + text.split(/\s+/).length, 0);

    return c.json({
      object: "list",
      data,
      model,
      usage: {
        prompt_tokens: totalTokens,
        total_tokens: totalTokens,
      },
    });
  });
}
