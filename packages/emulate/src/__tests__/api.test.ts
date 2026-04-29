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

  it("snapshot saves and restore recovers state", async () => {
    const github = await createEmulator({
      service: "github",
      port: 14030,
      seed: { github: { users: [{ login: "test-user" }] } },
    });

    // Create a repo
    await fetch(`${github.url}/user/repos`, {
      method: "POST",
      headers: {
        Authorization: "token test_token_admin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "snap-repo", private: false }),
    });

    // Save a snapshot
    const snap = github.snapshot();

    // Create another repo (this will be lost after restore)
    await fetch(`${github.url}/user/repos`, {
      method: "POST",
      headers: {
        Authorization: "token test_token_admin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "extra-repo", private: false }),
    });

    // Verify we now have 2 repos
    const beforeRestore = await fetch(`${github.url}/user/repos`, {
      headers: { Authorization: "token test_token_admin" },
    });
    const reposBefore = (await beforeRestore.json()) as unknown[];
    expect(reposBefore).toHaveLength(2);

    // Restore the snapshot
    github.restore(snap);

    // Should be back to 1 repo
    const afterRestore = await fetch(`${github.url}/user/repos`, {
      headers: { Authorization: "token test_token_admin" },
    });
    const reposAfter = (await afterRestore.json()) as unknown[];
    expect(reposAfter).toHaveLength(1);

    await github.close();
  });

  it("health endpoint returns service status", async () => {
    const github = await createEmulator({ service: "github", port: 14040 });

    const res = await fetch(`${github.url}/_emulate/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string; uptime_ms: number };
    expect(body.status).toBe("ready");
    expect(body.service).toBe("github");
    expect(body.uptime_ms).toBeGreaterThanOrEqual(0);

    await github.close();
  });

  it("snapshot via HTTP control endpoint", async () => {
    const github = await createEmulator({
      service: "github",
      port: 14050,
      seed: { github: { users: [{ login: "test-user" }] } },
    });

    // Create a repo
    await fetch(`${github.url}/user/repos`, {
      method: "POST",
      headers: {
        Authorization: "token test_token_admin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "http-snap-repo", private: false }),
    });

    // Save snapshot via HTTP
    const snapRes = await fetch(`${github.url}/_emulate/snapshot`, { method: "POST" });
    expect(snapRes.status).toBe(200);
    const snap = await snapRes.json();

    // Create another repo
    await fetch(`${github.url}/user/repos`, {
      method: "POST",
      headers: {
        Authorization: "token test_token_admin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "extra-http-repo", private: false }),
    });

    // Restore via HTTP
    const restoreRes = await fetch(`${github.url}/_emulate/snapshot`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snap),
    });
    expect(restoreRes.status).toBe(200);

    // Should be back to 1 repo
    const listRes = await fetch(`${github.url}/user/repos`, {
      headers: { Authorization: "token test_token_admin" },
    });
    const repos = (await listRes.json()) as unknown[];
    expect(repos).toHaveLength(1);

    await github.close();
  });

  it("throws on unknown service", async () => {
    // @ts-expect-error testing invalid service name
    await expect(createEmulator({ service: "unknown-svc" })).rejects.toThrow("Unknown service");
  });
});
