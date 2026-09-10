import type { AppEnv, Hono } from "@emulators/core";
import { api, badRequest, parseJsonBody, route, str, type Body } from "../helpers.js";
import { logEvent, type GStore } from "../store.js";

const MAX_BATCH = 20;

export function batchRoutes(app: Hono<AppEnv>, gs: GStore, baseUrl: string): void {
  route(
    app,
    "post",
    "/$batch",
    api(gs, async (c, auth) => {
      const body = await parseJsonBody(c);
      const requests = Array.isArray(body.requests) ? (body.requests as Body[]) : null;
      if (!requests || requests.length === 0)
        throw badRequest("Invalid batch payload format. The 'requests' property is required and must not be empty.");
      if (requests.length > MAX_BATCH)
        throw badRequest(
          `Batch request has too many individual requests. Maximum allowed is ${MAX_BATCH}.`,
          "BadRequest",
        );
      const ids = new Set<string>();
      for (const request of requests) {
        const id = str(request.id);
        if (!id) throw badRequest("Each request in a batch needs an id.");
        if (ids.has(id)) throw badRequest(`Duplicate request id '${id}' in batch.`);
        ids.add(id);
      }
      const version = new URL(c.req.url).pathname.split("/")[1] ?? "v1.0";
      const responses: Body[] = [];
      const completed = new Map<string, number>();
      for (const request of requests) {
        const id = String(request.id);
        const dependsOn = Array.isArray(request.dependsOn) ? request.dependsOn.map(String) : [];
        const failedDependency = dependsOn.find((dependency) => (completed.get(dependency) ?? 500) >= 400);
        if (failedDependency) {
          responses.push({
            id,
            status: 424,
            headers: {},
            body: {
              error: {
                code: "FailedDependency",
                message: `Request ${failedDependency} failed, so this request was not executed.`,
              },
            },
          });
          completed.set(id, 424);
          continue;
        }
        const method = (str(request.method) ?? "GET").toUpperCase();
        const rawUrl = str(request.url) ?? "";
        const path = rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`;
        const headers = new Headers({ Authorization: `Bearer ${auth.token.token}` });
        const requestHeaders =
          request.headers && typeof request.headers === "object" ? (request.headers as Record<string, unknown>) : {};
        for (const [key, value] of Object.entries(requestHeaders))
          if (typeof value === "string") headers.set(key, value);
        const hasBody =
          request.body !== undefined &&
          request.body !== null &&
          !(typeof request.body === "object" && Object.keys(request.body as Body).length === 0 && method === "GET");
        if (hasBody && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
        const response = await app.fetch(
          new Request(`${baseUrl}/${version}${path}`, {
            method,
            headers,
            body:
              hasBody && method !== "GET"
                ? typeof request.body === "string"
                  ? request.body
                  : JSON.stringify(request.body)
                : undefined,
          }),
        );
        const text = await response.text();
        let parsed: unknown = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = text;
        }
        const responseHeaders: Record<string, string> = {};
        const contentType = response.headers.get("content-type");
        if (contentType) responseHeaders["Content-Type"] = contentType;
        const location = response.headers.get("location");
        if (location) responseHeaders.Location = location;
        responses.push({
          id,
          status: response.status,
          headers: responseHeaders,
          ...(parsed !== null ? { body: parsed } : {}),
        });
        completed.set(id, response.status);
      }
      logEvent(gs, auth.tenantId, "batch.executed", String(requests.length), {
        statuses: responses.map((response) => response.status),
      });
      return c.json({ responses });
    }),
  );
}
