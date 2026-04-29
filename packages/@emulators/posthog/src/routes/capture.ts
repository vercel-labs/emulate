import type { RouteContext } from "@emulators/core";
import type { Context } from "hono";
import { asRecord, asString, generateUuid, parseCaptureBody, posthogError } from "../helpers.js";
import { getPostHogStore } from "../store.js";

function normalizeEvent(input: Record<string, unknown>, projectId: number) {
  const properties = asRecord(input.properties);
  const event = asString(input.event);

  if (!event) {
    return null;
  }

  const distinctId = asString(input.distinct_id) ?? asString(properties.distinct_id);
  const timestamp = asString(input.timestamp) ?? asString(properties.timestamp) ?? new Date().toISOString();

  return {
    uuid: generateUuid(),
    project_id: projectId,
    event,
    distinct_id: distinctId,
    properties,
    timestamp,
  };
}

function extractApiKey(input: Record<string, unknown>): string | null {
  const properties = asRecord(input.properties);
  return asString(input.api_key) ?? asString(input.token) ?? asString(properties.token);
}

export function captureRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ph = () => getPostHogStore(store);

  const handler = async (c: Context) => {
    const body = await parseCaptureBody(c);
    const rawBatch = Array.isArray(body.batch) ? body.batch : null;
    const items = rawBatch ? rawBatch.map(asRecord) : [body];
    const fallbackApiKey = rawBatch ? extractApiKey(body) : null;
    const events = [];

    for (const item of items) {
      const apiKey = extractApiKey(item) ?? fallbackApiKey;
      const project = apiKey ? ph().projects.findOneBy("api_token", apiKey) : undefined;

      if (!project) {
        return c.body(null, 401);
      }

      events.push(normalizeEvent(item, project.project_id));
    }

    if (events.some((event) => event === null)) {
      return posthogError(c, 400, "event is required");
    }

    for (const event of events) {
      ph().events.insert(event!);
    }

    return c.json({ status: 1 });
  };

  for (const path of ["/capture", "/capture/", "/batch", "/batch/", "/e", "/e/", "/track", "/track/"]) {
    app.post(path, handler);
  }
}
