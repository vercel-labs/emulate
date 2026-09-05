import { describe, it, expect } from "vitest";
import { getSlackStore, seedFromConfig } from "../index.js";
import { createSlackTestApp, slackTestBaseUrl as base } from "./helpers.js";

function seededApp() {
  const test = createSlackTestApp();
  seedFromConfig(test.store, base, {
    users: [
      { user_id: "U0PINNED01", name: "pinned", real_name: "Pinned User", email: "pinned@example.com" },
      { name: "generated", email: "generated@example.com" },
    ],
    channels: [{ channel_id: "C0PINNED01", name: "pinned-channel" }, { name: "generated-channel" }],
    tokens: [{ token: "xoxb-pinned", type: "bot", user_id: "U0PINNED01", scopes: ["chat:write", "users:read.email"] }],
  });
  return test;
}

describe("Slack seed: pinned ids", () => {
  it("keeps the ids a seed pins and still generates the rest", async () => {
    const { app, store } = seededApp();
    const ss = getSlackStore(store);

    expect(ss.users.findOneBy("email", "pinned@example.com")?.user_id).toBe("U0PINNED01");
    expect(ss.users.findOneBy("email", "generated@example.com")?.user_id).toMatch(/^U/);
    expect(ss.channels.findOneBy("name", "pinned-channel")?.channel_id).toBe("C0PINNED01");
    expect(ss.channels.findOneBy("name", "generated-channel")?.channel_id).toMatch(/^C/);

    const lookup = await app.request(`${base}/api/users.lookupByEmail`, {
      method: "POST",
      headers: { Authorization: "Bearer xoxb-pinned", "Content-Type": "application/json" },
      body: JSON.stringify({ email: "pinned@example.com" }),
    });
    const body = (await lookup.json()) as { ok: boolean; user: { id: string } };
    expect(body.ok).toBe(true);
    expect(body.user.id).toBe("U0PINNED01");
  });

  it("does not seed a second user or channel under an id that already exists", () => {
    const { store } = seededApp();
    seedFromConfig(store, base, {
      users: [{ user_id: "U0PINNED01", name: "someone-else" }],
      channels: [{ channel_id: "C0PINNED01", name: "another-name" }],
    });
    const ss = getSlackStore(store);
    expect(ss.users.findBy("user_id", "U0PINNED01")).toHaveLength(1);
    expect(ss.users.all().find((u) => u.name === "someone-else")).toBeUndefined();
    expect(ss.channels.findBy("channel_id", "C0PINNED01")).toHaveLength(1);
  });

  it("reports the token's scopes on auth.test the way Slack does", async () => {
    const { app } = seededApp();
    const res = await app.request(`${base}/api/auth.test`, {
      method: "POST",
      headers: { Authorization: "Bearer xoxb-pinned" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-oauth-scopes")).toBe("chat:write,users:read.email");
    const body = (await res.json()) as { ok: boolean; user_id: string };
    expect(body.ok).toBe(true);
    expect(body.user_id).toBe("U0PINNED01");
  });
});
