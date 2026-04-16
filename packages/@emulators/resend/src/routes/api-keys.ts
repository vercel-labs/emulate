import type { RouteContext } from "@emulators/core";
import { getResendStore } from "../store.js";
import { generateUuid, resendError, resendList, parseResendBody } from "../helpers.js";
import { randomBytes } from "crypto";

export function apiKeyRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const rs = () => getResendStore(store);

  app.post("/api-keys", async (c) => {
    const body = await parseResendBody(c);
    const name = body.name as string | undefined;

    if (!name) return resendError(c, 422, "validation_error", "Missing required field: name");

    const uuid = generateUuid();
    const token = `re_${randomBytes(16).toString("hex")}`;

    const apiKey = rs().apiKeys.insert({
      uuid,
      name,
      token,
    });

    return c.json(
      {
        id: apiKey.uuid,
        token: apiKey.token,
      },
      200,
    );
  });

  app.get("/api-keys", (c) => {
    const allKeys = rs().apiKeys.all();
    return c.json(
      resendList(
        allKeys.map((key) => ({
          id: key.uuid,
          name: key.name,
          created_at: key.created_at,
        })),
      ),
    );
  });

  app.delete("/api-keys/:id", (c) => {
    const id = c.req.param("id");
    const apiKey = rs().apiKeys.findOneBy("uuid", id);
    if (!apiKey) return resendError(c, 404, "not_found", "API key not found");

    rs().apiKeys.delete(apiKey.id);

    return c.json({ deleted: true });
  });
}
