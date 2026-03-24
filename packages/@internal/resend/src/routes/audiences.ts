import type { RouteContext } from "@internal/core";
import { parseJsonBody, requireAuth } from "@internal/core";
import { getResendStore } from "../store.js";
import { resendError, parseResendPagination, applyResendPagination } from "../helpers.js";
import type { ResendAudience } from "../entities.js";

function formatAudience(audience: ResendAudience) {
  return {
    object: "audience" as const,
    id: String(audience.id),
    name: audience.name,
    created_at: audience.created_at,
    updated_at: audience.updated_at,
  };
}

export function audienceRoutes({ app, store }: RouteContext): void {
  const rs = getResendStore(store);

  // Create audience
  app.post("/audiences", requireAuth(), async (c) => {
    const body = await parseJsonBody(c);

    const name = body.name;
    if (typeof name !== "string" || !name) {
      return resendError(c, 422, "validation_error", "Missing required field: name");
    }

    const audience = rs.audiences.insert({ name });

    return c.json(formatAudience(audience));
  });

  // List audiences
  app.get("/audiences", requireAuth(), (c) => {
    const pagination = parseResendPagination(c);
    const allAudiences = rs.audiences.all();
    const { data, has_more } = applyResendPagination(allAudiences, pagination);

    return c.json({
      object: "list",
      has_more,
      data: data.map(formatAudience),
    });
  });

  // Get audience
  app.get("/audiences/:id", requireAuth(), (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const audience = rs.audiences.get(id);
    if (!audience) {
      return resendError(c, 404, "not_found", "Audience not found");
    }
    return c.json(formatAudience(audience));
  });

  // Delete audience
  app.delete("/audiences/:id", requireAuth(), (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const audience = rs.audiences.get(id);
    if (!audience) {
      return resendError(c, 404, "not_found", "Audience not found");
    }

    rs.audiences.delete(id);

    return c.json({
      object: "audience",
      id: String(id),
      deleted: true,
    });
  });
}
