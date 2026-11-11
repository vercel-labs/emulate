import { createServer } from "@emulators/core";
import { describe, expect, it } from "vitest";
import { seedFromConfig, slackPlugin } from "../index.js";
import { slackTestBaseUrl as base, slackTestToken } from "./helpers.js";

function setupApp(strict: boolean) {
  const setup = createServer(slackPlugin, {
    baseUrl: base,
    tokens: { [slackTestToken]: { login: "U000000001", id: 1, scopes: ["chat:write"] } },
    fallbackUser: { login: "U000000001", id: 1, scopes: [] },
  });
  slackPlugin.seed?.(setup.store, base);
  seedFromConfig(setup.store, base, {
    users: [{ name: "alice" }],
    oauth_apps: [
      {
        client_id: "strict-client",
        client_secret: "strict-secret",
        name: "Strict App",
        redirect_uris: ["https://example.com/callback"],
        scopes: ["chat:write"],
      },
    ],
    tokens: [{ token: "xoxp-seeded-token", user: "admin", scopes: ["chat:write"] }],
    strict_scopes: strict,
  });
  return setup;
}

async function authTest(setup: ReturnType<typeof setupApp>, token: string) {
  const response = await setup.app.request(`${base}/api/auth.test`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

describe("Slack strict mode tokens", () => {
  it("rejects a token the emulator never issued", async () => {
    const body = await authTest(setupApp(true), "xoxb-never-issued");
    expect(body).toEqual({ ok: false, error: "invalid_auth" });
  });

  it("accepts tokens from seed config and server options", async () => {
    const setup = setupApp(true);
    expect((await authTest(setup, "xoxp-seeded-token")).ok).toBe(true);
    expect((await authTest(setup, slackTestToken)).ok).toBe(true);
  });

  it("accepts HTTP Basic client credentials on the OAuth exchange", async () => {
    const setup = setupApp(true);
    const callback = await setup.app.request(`${base}/oauth/v2/authorize/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        user_id: "U000000001",
        client_id: "strict-client",
        redirect_uri: "https://example.com/callback",
        scope: "chat:write",
      }),
    });
    const code = new URL(callback.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const response = await setup.app.request(`${base}/api/oauth.v2.access`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from("strict-client:strict-secret").toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ code, redirect_uri: "https://example.com/callback" }),
    });
    expect(((await response.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("keeps the fallback user for unknown tokens by default", async () => {
    expect((await authTest(setupApp(false), "xoxb-never-issued")).ok).toBe(true);
  });
});
