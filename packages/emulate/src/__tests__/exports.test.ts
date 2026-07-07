import { describe, expect, it } from "vitest";
import { createPlugin, createServer } from "../core.js";
import { githubPlugin } from "../plugins.js";

describe("composition exports", () => {
  it("re-exports core server primitives and built-in plugins", async () => {
    const plugin = createPlugin({
      name: "custom",
      register(app) {
        app.get("/ping", (c) => c.json({ ok: true }));
      },
    });

    const { app } = createServer(plugin, { baseUrl: "http://localhost:4000" });
    const res = await app.request("/ping");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(githubPlugin.name).toBe("github");
  });
});
