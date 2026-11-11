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

  it("keeps the fallback user for unknown tokens by default", async () => {
    expect((await authTest(setupApp(false), "xoxb-never-issued")).ok).toBe(true);
  });
});
