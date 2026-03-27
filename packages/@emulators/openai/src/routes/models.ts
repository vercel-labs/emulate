import type { RouteContext } from "@emulators/core";
import { openaiError, openaiList } from "../helpers.js";
import { getOpenAIStore } from "../store.js";

export function modelRoutes({ app, store }: RouteContext): void {
  const os = getOpenAIStore(store);

  app.get("/v1/models", (c) => {
    const models = os.models.all().map((m) => ({
      id: m.model_id,
      object: "model",
      created: Math.floor(new Date(m.created_at).getTime() / 1000),
      owned_by: m.owned_by,
    }));
    return c.json(openaiList(models));
  });

  app.get("/v1/models/:id", (c) => {
    const modelId = c.req.param("id");
    const model = os.models.findOneBy("model_id", modelId);
    if (!model) {
      return openaiError(
        c,
        404,
        "invalid_request_error",
        `The model '${modelId}' does not exist`,
        "model",
        "model_not_found"
      );
    }
    return c.json({
      id: model.model_id,
      object: "model",
      created: Math.floor(new Date(model.created_at).getTime() / 1000),
      owned_by: model.owned_by,
    });
  });
}
