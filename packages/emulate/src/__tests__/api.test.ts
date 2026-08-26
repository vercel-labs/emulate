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

  it("restores a seeded GitHub issue graph through REST and GraphQL", async () => {
    const github = await createEmulator({
      service: "github",
      port: 14025,
      seed: {
        github: {
          users: [{ login: "octocat" }],
          repos: [{ owner: "octocat", name: "graph" }],
          labels: [{ key: "bug", repo: "octocat/graph", name: "bug" }],
          issues: [
            { key: "parent", repo: "octocat/graph", number: 10, title: "Parent", labels: ["bug"] },
            { key: "child", repo: "octocat/graph", number: 20, title: "Child" },
          ],
          comments: [{ key: "comment", repo: "octocat/graph", issue: "parent", body: "seeded" }],
          sub_issues: [{ parent: "parent", child: "child" }],
          dependencies: [{ blocked: "child", blocking: "parent" }],
        },
      },
    });
    const headers = { Authorization: "token test_token_admin", "Content-Type": "application/json" };
    const issueUrl = `${github.url}/repos/octocat/graph/issues`;
    const beforeParent = await fetch(`${issueUrl}/10`, { headers });
    const beforeChild = await fetch(`${issueUrl}/20`, { headers });
    const beforeGraph = await fetch(`${github.url}/graphql`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query:
          '{ repository(owner: "octocat", name: "graph") { issue(number: 10) { id number title comments { totalCount } subIssues { nodes { number } } } } }',
      }),
    });
    const stableIssue = (issue: any) => ({
      id: issue.id,
      node_id: issue.node_id,
      number: issue.number,
      title: issue.title,
      state: issue.state,
      labels: issue.labels,
      comments: issue.comments,
      duplicate_issue_id: issue.duplicate_issue_id,
    });
    const baseline = {
      parent: stableIssue(await beforeParent.json()),
      child: stableIssue(await beforeChild.json()),
      graph: await beforeGraph.json(),
    };

    await fetch(issueUrl, { method: "POST", headers, body: JSON.stringify({ title: "mutation" }) });
    await fetch(`${issueUrl}/10/comments`, { method: "POST", headers, body: JSON.stringify({ body: "mutation" }) });
    await fetch(`${github.url}/repos/octocat/graph/labels`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "new" }),
    });
    await fetch(`${issueUrl}/10`, { method: "PATCH", headers, body: JSON.stringify({ state: "closed" }) });
    await fetch(`${issueUrl}/10/sub_issues`, { method: "POST", headers, body: JSON.stringify({ sub_issue_id: 1 }) });
    await fetch(`${issueUrl}/10/dependencies/blocked_by`, {
      method: "POST",
      headers,
      body: JSON.stringify({ issue_id: 2 }),
    });
    await fetch(`${github.url}/graphql`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: 'mutation { createIssue(input: { repositoryId: "bad", title: "ignored" }) { issue { number } } }',
      }),
    });

    github.reset();
    const afterParent = await fetch(`${issueUrl}/10`, { headers });
    const afterChild = await fetch(`${issueUrl}/20`, { headers });
    const afterGraph = await fetch(`${github.url}/graphql`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query:
          '{ repository(owner: "octocat", name: "graph") { issue(number: 10) { id number title comments { totalCount } subIssues { nodes { number } } } } }',
      }),
    });
    expect({
      parent: stableIssue(await afterParent.json()),
      child: stableIssue(await afterChild.json()),
      graph: await afterGraph.json(),
    }).toEqual(baseline);
    await github.close();
  });

  it("rejects invalid GitHub graph seeds before exposing a listener", async () => {
    await expect(
      createEmulator({
        service: "github",
        port: 14026,
        seed: {
          github: {
            repos: [{ owner: "missing", name: "graph" }],
            issues: [{ key: "issue", repo: "missing/graph", title: "bad" }],
          },
        },
      }),
    ).rejects.toThrow();
    await expect(fetch("http://localhost:14026/user")).rejects.toThrow();
  });

  it.each([
    ["comments", "comments"],
    ["subIssues", "sub_issues"],
    ["blockedBy", "dependencies"],
  ] as const)("traverses %s seed connections at all boundary sizes", async (field, configField) => {
    const sizes = [0, 1, 100, 101];
    for (const [offset, size] of sizes.entries()) {
      const port = 14100 + offset + (field === "comments" ? 0 : field === "subIssues" ? 10 : 20);
      const items = Array.from({ length: size }, (_, index) => index + 1);
      const issues = [
        { key: "root", repo: "octocat/pagination", number: 1, title: "Root" },
        ...items.map((index) => ({
          key: `issue-${index}`,
          repo: "octocat/pagination",
          number: index + 2,
          title: `Issue ${index}`,
        })),
      ];
      const graphSeed = {
        users: [{ login: "octocat" }],
        repos: [{ owner: "octocat", name: "pagination" }],
        issues,
        [configField]:
          field === "comments"
            ? items.map((index) => ({
                key: `comment-${index}`,
                repo: "octocat/pagination",
                issue: "root",
                body: `Body ${index}`,
              }))
            : field === "subIssues"
              ? items.map((index) => ({ parent: "root", child: `issue-${index}` }))
              : items.map((index) => ({ blocked: "root", blocking: `issue-${index}` })),
      };
      const github = await createEmulator({ service: "github", port, seed: { github: graphSeed } });
      const headers = { Authorization: "token test_token_admin", "Content-Type": "application/json" };
      const nodeFields = field === "comments" ? "id body" : "id number";
      const values: Array<{ id?: string; number?: number; body?: string }> = [];
      let after: string | null = null;
      let pages = 0;
      do {
        const response = await fetch(`${github.url}/graphql`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            query: `{ repository(owner: "octocat", name: "pagination") { issue(number: 1) { ${field}(first: 25${after ? `, after: "${after}"` : ""}) { nodes { ${nodeFields} } pageInfo { hasNextPage endCursor } } } } }`,
          }),
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as any;
        const connection = body.data.repository.issue[field];
        values.push(...connection.nodes);
        expect(typeof connection.pageInfo.hasNextPage).toBe("boolean");
        after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
        pages += 1;
      } while (after !== null);
      expect(pages).toBe(Math.max(1, Math.ceil(size / 25)));
      expect(values).toHaveLength(size);
      expect(new Set(values.map((value) => value.id)).size).toBe(size);
      if (field === "comments")
        expect(values.map((value) => value.body)).toEqual(items.map((index) => `Body ${index}`));
      else expect(values.map((value) => value.number)).toEqual(items.map((index) => index + 2));

      if (size === 101) {
        await fetch(`${github.url}/repos/octocat/pagination/issues/1`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ title: "Mutated" }),
        });
        github.reset();
        const restoredValues: typeof values = [];
        let restoredAfter: string | null = null;
        let restoredPages = 0;
        do {
          const restored = await fetch(`${github.url}/graphql`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              query: `{ repository(owner: "octocat", name: "pagination") { issue(number: 1) { ${field}(first: 100${restoredAfter ? `, after: "${restoredAfter}"` : ""}) { nodes { ${nodeFields} } pageInfo { hasNextPage endCursor } } } } }`,
            }),
          });
          expect(restored.status).toBe(200);
          const restoredBody = (await restored.json()) as any;
          const connection = restoredBody.data.repository.issue[field];
          restoredValues.push(...connection.nodes);
          expect(typeof connection.pageInfo.hasNextPage).toBe("boolean");
          restoredAfter = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
          restoredPages += 1;
        } while (restoredAfter !== null);
        expect(restoredPages).toBe(2);
        expect(restoredValues).toEqual(values);
      }
      await github.close();
    }
  });

  it("generates a GitHub App key once and keeps it across reset", async () => {
    const github = await createEmulator({
      service: "github",
      port: 14040,
      seed: {
        github: {
          users: [{ login: "octocat" }],
          apps: [
            {
              app_id: 900,
              slug: "generated-key-app",
              name: "Generated Key App",
              installations: [{ installation_id: 901, account: "octocat" }],
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
    expect(((await firstToken.json()) as { token: string }).token).toMatch(/^ghs_/);

    github.reset();

    const tokenAfterReset = await createInstallationToken(github.url, "900", 901, privateKey);
    expect(tokenAfterReset.status).toBe(201);
    expect(((await tokenAfterReset.json()) as { token: string }).token).toMatch(/^ghs_/);
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
