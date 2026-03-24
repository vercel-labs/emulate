import type { RouteContext } from "@internal/core";
import { parseJsonBody, requireAuth } from "@internal/core";
import { getResendStore } from "../store.js";
import { generateApiKeyToken, resendError, parseResendPagination, applyResendPagination } from "../helpers.js";
import type { ResendApiKey } from "../entities.js";

export function apiKeyRoutes({ app, store }: RouteContext): void {
  const rs = getResendStore(store);

  // Create API key
  app.post("/api-keys", requireAuth(), async (c) => {
    const body = await parseJsonBody(c);

    const name = body.name;
    if (typeof name !== "string" || !name) {
      return resendError(c, 422, "validation_error", "Missing required field: name");
    }

    const token = generateApiKeyToken();
    const permission = (typeof body.permission === "string" ? body.permission : "full_access") as ResendApiKey["permission"];
    const domainId = typeof body.domain_id === "string" ? body.domain_id : null;

    const apiKey = rs.apiKeys.insert({
      name,
      token,
      permission,
      domain_id: domainId,
      last_used_at: null,
    });

    return c.json({
      id: String(apiKey.id),
      token: apiKey.token,
    });
  });

  // List API keys
  app.get("/api-keys", requireAuth(), (c) => {
    const pagination = parseResendPagination(c);
    const allKeys = rs.apiKeys.all();
    const { data, has_more } = applyResendPagination(allKeys, pagination);

    return c.json({
      object: "list",
      has_more,
      data: data.map((key) => ({
        object: "api_key" as const,
        id: String(key.id),
        name: key.name,
        permission: key.permission,
        domain_id: key.domain_id,
        last_used_at: key.last_used_at,
        created_at: key.created_at,
      })),
    });
  });

  // Delete API key
  app.delete("/api-keys/:id", requireAuth(), (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const apiKey = rs.apiKeys.get(id);
    if (!apiKey) {
      return resendError(c, 404, "not_found", "API key not found");
    }

    rs.apiKeys.delete(id);

    return c.json({
      object: "api_key",
      id: String(id),
      deleted: true,
    });
  });
}
