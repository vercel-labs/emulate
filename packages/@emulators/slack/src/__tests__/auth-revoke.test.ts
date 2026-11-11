import { createServer } from "@emulators/core";
import { describe, expect, it } from "vitest";
import { getSlackStore, seedFromConfig, slackPlugin } from "../index.js";
import { revokeSlackTokens } from "../tokens.js";
import { slackTestBaseUrl as base, slackTestToken } from "./helpers.js";

function setupApp() {
  const setup = createServer(slackPlugin, {
    baseUrl: base,
    tokens: { [slackTestToken]: { login: "U000000001", id: 1, scopes: ["chat:write"] } },
  });
  slackPlugin.seed?.(setup.store, base);
  seedFromConfig(setup.store, base, {
    tokens: [
      { token: "xoxp-alice", user: "admin", scopes: ["chat:write"] },
      { token: "xoxp-other", user: "admin", scopes: ["chat:write"] },
    ],
  });
  return setup;
}

async function call(
  setup: ReturnType<typeof setupApp>,
  method: string,
  token: string,
  body: Record<string, unknown> = {},
) {
  const response = await setup.app.request(`${base}/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

describe("Slack auth.revoke", () => {
  it("revokes the calling token and leaves the others working", async () => {
    const setup = setupApp();
    expect(await call(setup, "auth.revoke", "xoxp-alice")).toEqual({ ok: true, revoked: true });
    expect(await call(setup, "auth.test", "xoxp-alice")).toEqual({ ok: false, error: "invalid_auth" });
    expect((await call(setup, "auth.test", "xoxp-other")).ok).toBe(true);
  });

  it("revokes a token from server options", async () => {
    const setup = setupApp();
    expect(await call(setup, "auth.revoke", slackTestToken)).toEqual({ ok: true, revoked: true });
    expect(await call(setup, "auth.test", slackTestToken)).toEqual({ ok: false, error: "invalid_auth" });
  });

  it("checks without revoking when test is set", async () => {
    const setup = setupApp();
    expect(await call(setup, "auth.revoke", "xoxp-alice", { test: true })).toEqual({ ok: true, revoked: false });
    expect((await call(setup, "auth.test", "xoxp-alice")).ok).toBe(true);
  });

  it("reports a token revoked by apps.uninstall when it is passed in the body", async () => {
    const setup = setupApp();
    revokeSlackTokens(setup.store, [getSlackStore(setup.store).tokens.findOneBy("token", "xoxp-alice")!]);
    const response = await setup.app.request(`${base}/api/auth.revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "xoxp-alice" }),
    });
    expect(await response.json()).toEqual({ ok: false, error: "token_revoked" });
  });

  it("rejects a token the emulator never issued", async () => {
    expect(await call(setupApp(), "auth.revoke", "xoxp-never-issued")).toEqual({ ok: false, error: "invalid_auth" });
  });
});
