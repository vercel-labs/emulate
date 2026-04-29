import { describe, it, expect, beforeEach } from "vitest";
import { gzipSync } from "node:zlib";
import { Hono } from "hono";
import {
  Store,
  WebhookDispatcher,
  authMiddleware,
  createApiErrorHandler,
  createErrorHandler,
  type TokenMap,
} from "@emulators/core";
import { getPostHogStore, posthogPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  const app = new Hono();

  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  posthogPlugin.register(app as any, store, webhooks, base, tokenMap);
  posthogPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    projects: [
      { id: 1, api_token: "phc_project_a", name: "Project A" },
      { id: 2, api_token: "phc_project_b", name: "Project B" },
      { id: 3, api_token: "phc_test", name: "Browser SDK Project" },
    ],
    feature_flags: [
      {
        key: "new-checkout",
        project_id: 1,
        default: false,
        conditions: [{ property: "email", operator: "icontains", value: "@acme.com", variant: true }],
        overrides: { "user-123": true },
      },
      {
        key: "pricing-experiment",
        project_id: 1,
        default: "control",
        variants: ["control", "treatment"],
        overrides: { "user-456": "treatment" },
      },
      {
        key: "project-b-flag",
        project_id: 2,
        default: true,
      },
    ],
  });

  return { app, store, webhooks, tokenMap };
}

function jsonHeaders(): Record<string, string> {
  return { "Content-Type": "application/json" };
}

describe("PostHog plugin", () => {
  let app: Hono;
  let store: Store;

  beforeEach(() => {
    const test = createTestApp();
    app = test.app;
    store = test.store;
  });

  it("POST /capture/ stores a single event", async () => {
    const res = await app.request(`${base}/capture/`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        api_key: "phc_project_a",
        event: "user_signed_up",
        distinct_id: "user-1",
        properties: { plan: "pro" },
      }),
    });

    expect(res.status).toBe(200);
    const actual = getPostHogStore(store).events.all();
    expect(actual).toHaveLength(1);
    expect(actual[0].event).toBe("user_signed_up");
    expect(actual[0].project_id).toBe(1);
    expect(actual[0].properties).toEqual({ plan: "pro" });
  });

  it("POST /e/ accepts api_key inside properties.token (browser SDK)", async () => {
    const res = await app.request(`${base}/e/`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        event: "$pageview",
        distinct_id: "browser-user",
        properties: { token: "phc_test", current_url: "https://example.com" },
      }),
    });

    expect(res.status).toBe(200);
    const actual = getPostHogStore(store).events.all();
    expect(actual).toHaveLength(1);
    expect(actual[0].event).toBe("$pageview");
    expect(actual[0].project_id).toBe(3);
    expect(actual[0].properties).toEqual({ token: "phc_test", current_url: "https://example.com" });
  });

  it("POST /batch/ stores multiple events with the same project", async () => {
    const res = await app.request(`${base}/batch/`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        api_key: "phc_project_a",
        batch: [
          { event: "one", distinct_id: "user-1" },
          { event: "two", distinct_id: "user-2" },
          { event: "three", distinct_id: "user-3" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const actual = getPostHogStore(store).events.all();
    expect(actual).toHaveLength(3);
    expect(actual.map((event) => event.project_id)).toEqual([1, 1, 1]);
  });

  it("POST /batch/ decompresses Content-Encoding: gzip", async () => {
    const compressed = gzipSync(
      JSON.stringify({
        api_key: "phc_project_a",
        batch: [
          { event: "gzip_one", distinct_id: "user-1" },
          { event: "gzip_two", distinct_id: "user-2" },
        ],
      }),
    );

    const res = await app.request(`${base}/batch/`, {
      method: "POST",
      headers: {
        "Content-Encoding": "gzip",
        "Content-Type": "application/json",
      },
      body: compressed,
    });

    expect(res.status).toBe(200);
    const actual = getPostHogStore(store).events.all();
    expect(actual).toHaveLength(2);
    expect(actual.map((event) => event.event)).toEqual(["gzip_one", "gzip_two"]);
    expect(actual.map((event) => event.project_id)).toEqual([1, 1]);
  });

  it("POST /capture/?compression=gzip-js with text/plain body decompresses (browser SDK)", async () => {
    const compressed = gzipSync(
      JSON.stringify({
        api_key: "phc_project_a",
        event: "browser_event",
        distinct_id: "user-browser",
      }),
    );

    const res = await app.request(`${base}/capture/?compression=gzip-js`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: compressed,
    });

    expect(res.status).toBe(200);
    const actual = getPostHogStore(store).events.all()[0];
    expect(actual.event).toBe("browser_event");
    expect(actual.distinct_id).toBe("user-browser");
  });

  it("POST /capture/ rejects a bad api_key", async () => {
    const res = await app.request(`${base}/capture/`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ api_key: "phc_bad", event: "bad_auth", distinct_id: "user-1" }),
    });

    expect(res.status).toBe(401);
    const actual = await res.text();
    expect(actual).toBe("");
  });

  it("POST /capture/ accepts form encoded data", async () => {
    const payload = {
      api_key: "phc_project_a",
      event: "form_event",
      distinct_id: "user-form",
      properties: { source: "beacon" },
    };
    const res = await app.request(`${base}/capture/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ data: JSON.stringify(payload) }).toString(),
    });

    expect(res.status).toBe(200);
    const actual = getPostHogStore(store).events.all()[0];
    expect(actual.event).toBe("form_event");
    expect(actual.distinct_id).toBe("user-form");
  });

  it("POST /capture/ accepts text/plain JSON", async () => {
    const res = await app.request(`${base}/capture/`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({
        api_key: "phc_project_a",
        event: "plain_event",
        distinct_id: "user-plain",
      }),
    });

    expect(res.status).toBe(200);
    const actual = getPostHogStore(store).events.all()[0];
    expect(actual.event).toBe("plain_event");
    expect(actual.distinct_id).toBe("user-plain");
  });

  it("keeps inspector events isolated by project", async () => {
    await app.request(`${base}/capture/`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ api_key: "phc_project_a", event: "project_a_event", distinct_id: "a" }),
    });
    await app.request(`${base}/capture/`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ api_key: "phc_project_b", event: "project_b_event", distinct_id: "b" }),
    });

    const res = await app.request(`${base}/_inspector?tab=events&project_id=2`);
    expect(res.status).toBe(200);
    const actual = await res.text();
    expect(actual).toContain("project_b_event");
    expect(actual).not.toContain("project_a_event");
  });

  it("POST /decide/ returns the default flag value", async () => {
    const res = await app.request(`${base}/decide/`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ token: "phc_project_a", distinct_id: "unknown-user" }),
    });

    expect(res.status).toBe(200);
    const actual = (await res.json()) as { featureFlags: Record<string, boolean | string> };
    expect(actual.featureFlags["new-checkout"]).toBe(false);
  });

  it("POST /decide/ returns a distinct_id override", async () => {
    const res = await app.request(`${base}/decide/`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ token: "phc_project_a", distinct_id: "user-123" }),
    });

    expect(res.status).toBe(200);
    const actual = (await res.json()) as { featureFlags: Record<string, boolean | string> };
    expect(actual.featureFlags["new-checkout"]).toBe(true);
  });

  it("POST /decide/ returns a property condition match", async () => {
    const res = await app.request(`${base}/decide/`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        token: "phc_project_a",
        distinct_id: "user-789",
        person_properties: { email: "alice@acme.com" },
      }),
    });

    expect(res.status).toBe(200);
    const actual = (await res.json()) as { featureFlags: Record<string, boolean | string> };
    expect(actual.featureFlags["new-checkout"]).toBe(true);
  });

  it("POST /decide/ returns safe defaults for SDK config", async () => {
    const res = await app.request(`${base}/decide/`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ token: "phc_project_a", distinct_id: "user-1" }),
    });

    expect(res.status).toBe(200);
    const actual = (await res.json()) as Record<string, unknown>;
    expect(actual.sessionRecording).toBe(false);
    expect(actual.supportedCompression).toEqual([]);
    expect(actual.siteApps).toEqual([]);
    expect(actual.capturePerformance).toBe(false);
    expect(actual.autocapture_opt_out).toBe(true);
    expect(actual.surveys).toBe(false);
  });

  it("POST /flags/?v=2 returns same shape as /decide/", async () => {
    const body = JSON.stringify({ token: "phc_project_a", distinct_id: "user-123" });
    const decideRes = await app.request(`${base}/decide/`, {
      method: "POST",
      headers: jsonHeaders(),
      body,
    });
    const flagsRes = await app.request(`${base}/flags/?v=2`, {
      method: "POST",
      headers: jsonHeaders(),
      body,
    });

    expect(decideRes.status).toBe(200);
    expect(flagsRes.status).toBe(200);
    const decide = (await decideRes.json()) as Record<string, unknown>;
    const flags = (await flagsRes.json()) as Record<string, unknown>;
    expect(flags.featureFlags).toEqual(decide.featureFlags);
    expect(flags.featureFlagPayloads).toEqual(decide.featureFlagPayloads);
    expect(flags.errorsWhileComputingFlags).toBe(decide.errorsWhileComputingFlags);
    expect(flags.config).toEqual(decide.config);
    expect(flags.sessionRecording).toBe(decide.sessionRecording);
    expect(flags.supportedCompression).toEqual(decide.supportedCompression);
    expect(flags.siteApps).toEqual(decide.siteApps);
    expect(flags.capturePerformance).toBe(decide.capturePerformance);
    expect(flags.autocapture_opt_out).toBe(decide.autocapture_opt_out);
    expect(flags.surveys).toBe(decide.surveys);
  });

  it("GET /_inspector returns events and feature flags tables", async () => {
    await app.request(`${base}/capture/`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ api_key: "phc_project_a", event: "inspected_event", distinct_id: "user-1" }),
    });

    const eventsRes = await app.request(`${base}/_inspector?tab=events`);
    const flagsRes = await app.request(`${base}/_inspector?tab=flags`);

    expect(eventsRes.status).toBe(200);
    expect(flagsRes.status).toBe(200);
    const eventsHtml = await eventsRes.text();
    const flagsHtml = await flagsRes.text();
    expect(eventsHtml).toContain("Events (1)");
    expect(eventsHtml).toContain("inspected_event");
    expect(flagsHtml).toContain("Feature Flags (3)");
    expect(flagsHtml).toContain("new-checkout");
  });
});
