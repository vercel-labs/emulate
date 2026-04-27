import { describe, it, expect } from "vitest";
import { createEmulator } from "../api.js";

describe("createEmulator", () => {
  it("starts github and returns a url", async () => {
    const github = await createEmulator({ service: "github", port: 14000 });

    expect(github.url).toBe("http://localhost:14000");

    const res = await fetch(`${github.url}/user`, {
      headers: { Authorization: "token test_token_admin" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { login: string };
    expect(body.login).toBe("admin");

    await github.close();
  });

  it("starts multiple services independently", async () => {
    const [github, vercel] = await Promise.all([
      createEmulator({ service: "github", port: 14010 }),
      createEmulator({ service: "vercel", port: 14011 }),
    ]);

    expect(github.url).toBe("http://localhost:14010");
    expect(vercel.url).toBe("http://localhost:14011");

    await Promise.all([github.close(), vercel.close()]);
  });

  it("reset wipes and re-seeds stores", async () => {
    const github = await createEmulator({
      service: "github",
      port: 14020,
      seed: { github: { users: [{ login: "test-user" }] } },
    });

    const createRes = await fetch(`${github.url}/user/repos`, {
      method: "POST",
      headers: {
        Authorization: "token test_token_admin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "my-repo", private: false }),
    });
    expect(createRes.status).toBe(201);

    github.reset();

    const listRes = await fetch(`${github.url}/user/repos`, {
      headers: { Authorization: "token test_token_admin" },
    });
    expect(listRes.status).toBe(200);
    const repos = (await listRes.json()) as unknown[];
    expect(repos).toHaveLength(0);

    await github.close();
  });

  it("records requests in the log", async () => {
    const github = await createEmulator({ service: "github", port: 14060 });

    // Make a request
    await fetch(`${github.url}/user`, {
      headers: { Authorization: "token test_token_admin" },
    });

    const log = github.requests();
    expect(log.length).toBeGreaterThanOrEqual(1);
    const entry = log.find((e) => e.path === "/user");
    expect(entry).toBeDefined();
    expect(entry!.method).toBe("GET");
    expect(entry!.status).toBe(200);
    expect(entry!.duration_ms).toBeGreaterThanOrEqual(0);
    expect(entry!.timestamp).toBeTruthy();

    await github.close();
  });

  it("clears request log", async () => {
    const github = await createEmulator({ service: "github", port: 14070 });

    await fetch(`${github.url}/user`, {
      headers: { Authorization: "token test_token_admin" },
    });
    expect(github.requests().length).toBeGreaterThanOrEqual(1);

    github.clearRequests();
    expect(github.requests()).toHaveLength(0);

    await github.close();
  });

  it("request log via HTTP endpoints", async () => {
    const github = await createEmulator({ service: "github", port: 14080 });

    // Make a request
    await fetch(`${github.url}/user`, {
      headers: { Authorization: "token test_token_admin" },
    });

    // Fetch log via HTTP
    const logRes = await fetch(`${github.url}/_emulate/requests`);
    expect(logRes.status).toBe(200);
    const log = (await logRes.json()) as Array<{ method: string; path: string }>;
    expect(log.some((e) => e.path === "/user")).toBe(true);

    // Clear via HTTP
    const clearRes = await fetch(`${github.url}/_emulate/requests`, { method: "DELETE" });
    expect(clearRes.status).toBe(200);

    // Verify cleared
    const emptyRes = await fetch(`${github.url}/_emulate/requests`);
    const emptyLog = (await emptyRes.json()) as unknown[];
    expect(emptyLog).toHaveLength(0);

    await github.close();
  });

  it("throws on unknown service", async () => {
    // @ts-expect-error testing invalid service name
    await expect(createEmulator({ service: "unknown-svc" })).rejects.toThrow("Unknown service");
  });
});
