import { describe, it, expect, afterAll } from "vitest";
import { createEmulate } from "../api.js";

describe("createEmulate", () => {
  it("starts github and returns a url", async () => {
    const emulate = await createEmulate({ port: 14000, services: ["github"] });

    expect(emulate.urls.github).toBe("http://localhost:14000");

    const res = await fetch(`${emulate.urls.github}/user`, {
      headers: { Authorization: "token gho_test_token_admin" },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { login: string };
    expect(body.login).toBe("admin");

    await emulate.close();
  });

  it("starts multiple services on sequential ports", async () => {
    const emulate = await createEmulate({ port: 14010, services: ["github", "vercel"] });

    expect(emulate.urls.github).toBe("http://localhost:14010");
    expect(emulate.urls.vercel).toBe("http://localhost:14011");

    await emulate.close();
  });

  it("reset wipes and re-seeds stores", async () => {
    const emulate = await createEmulate({
      port: 14020,
      services: ["github"],
      seed: { github: { users: [{ login: "test-user" }] } },
    });

    // Create a resource
    const createRes = await fetch(`${emulate.urls.github}/user/repos`, {
      method: "POST",
      headers: {
        Authorization: "token gho_test_token_admin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "my-repo", private: false }),
    });
    expect(createRes.status).toBe(201);

    // Reset -- repo should be gone
    emulate.reset();

    const listRes = await fetch(`${emulate.urls.github}/user/repos`, {
      headers: { Authorization: "token gho_test_token_admin" },
    });
    expect(listRes.status).toBe(200);
    const repos = await listRes.json() as unknown[];
    expect(repos).toHaveLength(0);

    await emulate.close();
  });

  it("throws on unknown service", async () => {
    await expect(createEmulate({ services: ["unknown-svc"] })).rejects.toThrow("Unknown service");
  });
});
