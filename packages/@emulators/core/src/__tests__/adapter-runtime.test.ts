import { describe, expect, it } from "vitest";
import { createAdapterRuntime } from "../adapter-runtime.js";
import type { AuthFallback } from "../middleware/auth.js";
import type { ServicePlugin } from "../plugin.js";

const plugin: ServicePlugin = {
  name: "who",
  register(app) {
    app.get("/me", (c) => c.json({ user: c.get("authUser") ?? null }));
  },
};

async function whoAmI(fallbackUser?: AuthFallback): Promise<{ status: number; user: { login: string } | null }> {
  const runtime = createAdapterRuntime(
    { services: { who: { emulator: { plugin }, fallbackUser } } },
    (mount, service) => `${mount}/${service}`,
  );
  const response = await runtime.handle(
    new Request("http://localhost:3000/emulate/who/me", { headers: { Authorization: "Bearer anything" } }),
    ["who", "me"],
    "/emulate",
  );
  const body = (await response.json().catch(() => ({}))) as { user?: { login: string } | null };
  return { status: response.status, user: body.user ?? null };
}

describe("adapter runtime fallback user", () => {
  it("maps an unknown bearer token to the configured fallback user", async () => {
    const { status, user } = await whoAmI({ login: "admin", id: 1, scopes: [] });
    expect(status).toBe(200);
    expect(user).toMatchObject({ login: "admin", id: 1 });
  });

  it("gives an unknown bearer token no user when no fallback is configured", async () => {
    expect((await whoAmI()).user).toBeNull();
  });
});
