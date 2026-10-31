import { generateKeyPairSync, sign } from "crypto";
import { describe, it, expect } from "vitest";
import { createEmulator } from "../api.js";

function createAppJwt(appId: string, privateKey: string): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: appId })).toString(
    "base64url",
  );
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
}

async function createInstallationToken(url: string, appId: string, installationId: number, privateKey: string) {
  return fetch(`${url}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${createAppJwt(appId, privateKey)}` },
  });
}

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
    expect(vercel.generatedSecrets).toEqual([]);

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

  it("generates a GitHub App key once and keeps it across reset", async () => {
    const github = await createEmulator({
      service: "github",
      port: 14040,
      seed: {
        github: {
          users: [{ login: "octocat" }],
          orgs: [{ login: "acme" }],
          repos: [{ owner: "acme", name: "private-repo", private: true }],
          apps: [
            {
              app_id: 900,
              slug: "generated-key-app",
              name: "Generated Key App",
              installations: [{ installation_id: 901, account: "acme" }],
            },
          ],
        },
      },
    });

    expect(github.generatedSecrets).toHaveLength(1);
    expect(github.generatedSecrets[0]).toMatchObject({
      service: "github",
      kind: "github.app_private_key",
      id: "900",
      label: "Generated Key App",
    });
    const privateKey = github.generatedSecrets[0]!.value;
    expect(privateKey).toMatch(/^-----BEGIN RSA PRIVATE KEY-----/);

    const firstToken = await createInstallationToken(github.url, "900", 901, privateKey);
    expect(firstToken.status).toBe(201);
    const firstTokenValue = ((await firstToken.json()) as { token: string }).token;
    expect(firstTokenValue).toMatch(/^ghs_/);
    expect(await (await fetch(`${github.url}/_emulate/installation-tokens`)).json()).toMatchObject({
      installation_tokens: [expect.objectContaining({ installation: { id: 901 }, status: "active" })],
    });
    expect(
      (
        await fetch(`${github.url}/repos/acme/private-repo`, {
          headers: { Authorization: `Bearer ${firstTokenValue}` },
        })
      ).status,
    ).toBe(200);

    github.reset();

    expect(await (await fetch(`${github.url}/_emulate/installation-tokens`)).json()).toEqual({
      installation_tokens: [],
    });
    const resetTokenUser = await fetch(`${github.url}/user`, {
      headers: { Authorization: `Bearer ${firstTokenValue}` },
    });
    expect(resetTokenUser.status).toBe(200);
    expect(await resetTokenUser.json()).toMatchObject({ login: "octocat", type: "User" });
    expect(
      (
        await fetch(`${github.url}/repos/acme/private-repo`, {
          headers: { Authorization: `Bearer ${firstTokenValue}` },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${github.url}/user`, {
          headers: { Authorization: "Bearer test_token_admin" },
        })
      ).status,
    ).toBe(200);

    const tokenAfterReset = await createInstallationToken(github.url, "900", 901, privateKey);
    expect(tokenAfterReset.status).toBe(201);
    const tokenAfterResetValue = ((await tokenAfterReset.json()) as { token: string }).token;
    expect(tokenAfterResetValue).toMatch(/^ghs_/);
    expect(
      (
        await fetch(`${github.url}/repos/acme/private-repo`, {
          headers: { Authorization: `Bearer ${tokenAfterResetValue}` },
        })
      ).status,
    ).toBe(200);
    expect(github.generatedSecrets[0]!.value).toBe(privateKey);

    await github.close();
  });

  it("uses an explicit GitHub App key without exposing it", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "pkcs1", format: "pem" },
    });
    const github = await createEmulator({
      service: "github",
      port: 14041,
      seed: {
        github: {
          users: [{ login: "octocat" }],
          apps: [
            {
              app_id: 910,
              slug: "explicit-key-app",
              name: "Explicit Key App",
              private_key: privateKey,
              installations: [{ installation_id: 911, account: "octocat" }],
            },
          ],
        },
      },
    });

    expect(github.generatedSecrets).toEqual([]);
    const token = await createInstallationToken(github.url, "910", 911, privateKey);
    expect(token.status).toBe(201);

    await github.close();
  });

  it("rejects a JWT signed with the wrong GitHub App key", async () => {
    const github = await createEmulator({
      service: "github",
      port: 14042,
      seed: {
        github: {
          users: [{ login: "octocat" }],
          apps: [
            {
              app_id: 920,
              slug: "wrong-key-app",
              name: "Wrong Key App",
              installations: [{ installation_id: 921, account: "octocat" }],
            },
          ],
        },
      },
    });
    const { privateKey: wrongKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "pkcs1", format: "pem" },
    });

    const response = await createInstallationToken(github.url, "920", 921, wrongKey);
    expect(response.status).toBe(401);

    await github.close();
  });

  it("rejects an empty explicit GitHub App key", async () => {
    await expect(
      createEmulator({
        service: "github",
        port: 14043,
        seed: {
          github: {
            apps: [{ app_id: 930, slug: "empty-key-app", name: "Empty Key App", private_key: "" }],
          },
        },
      }),
    ).rejects.toThrow('GitHub App "empty-key-app" private_key must not be empty');
  });

  it.each([
    {
      name: "app ID",
      apps: [
        { app_id: 940, slug: "first-app", name: "First App" },
        { app_id: 940, slug: "second-app", name: "Second App" },
      ],
      message: "Duplicate GitHub App app_id: 940",
    },
    {
      name: "slug",
      apps: [
        { app_id: 950, slug: "duplicate-app", name: "First App" },
        { app_id: 951, slug: "duplicate-app", name: "Second App" },
      ],
      message: 'Duplicate GitHub App slug: "duplicate-app"',
    },
  ])("rejects a duplicate GitHub App $name before startup", async ({ apps, message }) => {
    await expect(
      createEmulator({
        service: "github",
        port: 14044,
        seed: { github: { apps } },
      }),
    ).rejects.toThrow(message);

    await expect(fetch("http://localhost:14044/user")).rejects.toThrow();
  });

  it("does not grant Slack fallback scopes in strict mode", async () => {
    const slack = await createEmulator({
      service: "slack",
      port: 14030,
      seed: { slack: { strict_scopes: true } },
    });

    const res = await fetch(`${slack.url}/api/chat.postMessage`, {
      method: "POST",
      headers: {
        Authorization: "Bearer arbitrary-slack-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: "C000000001", text: "strict fallback" }),
    });
    const body = (await res.json()) as { ok: boolean; error: string; needed: string; provided: string };
    expect(body).toMatchObject({
      ok: false,
      error: "missing_scope",
      needed: "chat:write",
      provided: "",
    });

    await slack.close();
  });

  it("throws on unknown service", async () => {
    // @ts-expect-error testing invalid service name
    await expect(createEmulator({ service: "unknown-svc" })).rejects.toThrow("Unknown service");
  });
});
