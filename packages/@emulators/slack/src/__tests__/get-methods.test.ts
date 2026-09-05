import { describe, it, expect } from "vitest";
import { getSlackStore, seedFromConfig } from "../index.js";
import { createSlackTestApp, slackTestBaseUrl as base, slackTestToken } from "./helpers.js";

const auth = { Authorization: `Bearer ${slackTestToken}` };

describe("Slack read methods accept GET with query parameters", () => {
  it("resolves users.lookupByEmail and users.info over GET", async () => {
    const { app, store } = createSlackTestApp();
    seedFromConfig(store, base, {
      users: [{ name: "getter", email: "getter@example.com" }],
      tokens: [
        { token: "xoxb-getter", user: "getter", scopes: ["users:read", "users:read.email", "channels:history"] },
      ],
    });
    const getterId = getSlackStore(store).users.findOneBy("email", "getter@example.com")!.user_id;
    const headers = { Authorization: "Bearer xoxb-getter" };

    const lookup = await app.request(`${base}/api/users.lookupByEmail?email=getter%40example.com`, { headers });
    const lookupBody = (await lookup.json()) as { ok: boolean; user: { id: string } };
    expect(lookupBody.ok).toBe(true);
    expect(lookupBody.user.id).toBe(getterId);

    const info = await app.request(`${base}/api/users.info?user=${getterId}`, { headers });
    const infoBody = (await info.json()) as { ok: boolean; user: { name: string } };
    expect(infoBody.ok).toBe(true);
    expect(infoBody.user.name).toBe("getter");
  });

  it("reads history and replies over GET after posting", async () => {
    const { app } = createSlackTestApp();
    const post = await app.request(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "general", text: "via post" }),
    });
    const posted = (await post.json()) as { ok: boolean; channel: string; ts: string };
    expect(posted.ok).toBe(true);

    const history = await app.request(`${base}/api/conversations.history?channel=${posted.channel}&limit=5`, {
      headers: auth,
    });
    const messages = ((await history.json()) as { ok: boolean; messages: Array<{ text: string }> }).messages;
    expect(messages.some((m) => m.text === "via post")).toBe(true);

    const replies = await app.request(`${base}/api/conversations.replies?channel=${posted.channel}&ts=${posted.ts}`, {
      headers: auth,
    });
    expect(((await replies.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("reserves an upload URL over GET, the way the SDKs call it", async () => {
    const { app, store } = createSlackTestApp();
    seedFromConfig(store, base, {
      tokens: [{ token: "xoxb-uploader", scopes: ["files:write"] }],
    });
    const res = await app.request(`${base}/api/files.getUploadURLExternal?filename=a.png&length=3`, {
      headers: { Authorization: "Bearer xoxb-uploader" },
    });
    const body = (await res.json()) as { ok: boolean; upload_url: string; file_id: string };
    expect(body.ok).toBe(true);
    expect(body.upload_url).toContain("/upload/v1/");
    expect(body.file_id).toMatch(/^F/);
  });

  it("lets a body override a query parameter", async () => {
    const { app } = createSlackTestApp();
    const res = await app.request(`${base}/api/api.test?foo=query`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "foo=body&bar=1",
    });
    expect(((await res.json()) as { args: Record<string, string> }).args).toEqual({ foo: "body", bar: "1" });
  });

  it("answers api.test without a token and echoes an asked-for error", async () => {
    const { app } = createSlackTestApp();
    const ok = await app.request(`${base}/api/api.test?hello=world`);
    expect((await ok.json()) as unknown).toEqual({ ok: true, args: { hello: "world" } });
    const err = await app.request(`${base}/api/api.test?error=my_error`);
    expect(((await err.json()) as { ok: boolean; error: string }).error).toBe("my_error");
  });
});
