import { beforeEach, describe, expect, it } from "vitest";
import {
  Hono,
  Store,
  WebhookDispatcher,
  authMiddleware,
  createApiErrorHandler,
  type AppEnv,
  type TokenMap,
} from "@emulators/core";
import { getGitHubStore, githubPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";
const repoPath = "/repos/octocat/hello-world";

function createTestApp() {
  const store = new Store();
  const tokenMap: TokenMap = new Map();
  const app = new Hono<AppEnv>();
  app.onError(createApiErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app, store, new WebhookDispatcher(), base, tokenMap);
  seedFromConfig(store, base, {
    users: [{ login: "octocat" }, { login: "hubot" }],
    repos: [
      { owner: "octocat", name: "hello-world", auto_init: true },
      { owner: "octocat", name: "private-repo", private: true },
    ],
  });
  const gh = getGitHubStore(store);
  for (const user of gh.users.all())
    tokenMap.set(user.login, { login: user.login, id: user.id, scopes: ["repo", "delete_repo"] });
  return { app, gh, tokenMap };
}

describe("GitHub issue artifacts", () => {
  let context: ReturnType<typeof createTestApp>;

  function request(path: string, method = "GET", body?: unknown, token: string | null = "octocat") {
    return context.app.request(`${base}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  beforeEach(() => {
    context = createTestApp();
  });

  it("retains artifact versions, creator, and per-issue numbering through edits and deletion", async () => {
    await request(`${repoPath}/issues`, "POST", { title: "Issue" });
    const path = `${repoPath}/issues/1/artifacts`;
    const created = await request(path, "POST", { type: "link", name: "Review", body: "https://example.com/review" });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ number: 1, type: "link", creator: { login: "octocat" } });
    const edited = await request(`${path}/1`, "PATCH", { body: "https://example.com/revised" }, "hubot");
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({
      number: 1,
      name: "Review",
      creator: { login: "octocat" },
      updated_by_actor: { login: "hubot" },
    });
    expect(await (await request(`${path}/1`)).json()).toMatchObject({
      artifact: { body: "https://example.com/revised" },
      versions: [
        { version: 2, body: "https://example.com/revised", actor: { login: "hubot" } },
        { version: 1, body: "https://example.com/review", actor: { login: "octocat" } },
      ],
    });
    expect((await request(`${path}/1`, "DELETE")).status).toBe(204);
    expect((await request(`${path}/1`)).status).toBe(404);
    expect(await (await request(path, "POST", { name: "Notes", body: "Notes" })).json()).toMatchObject({
      number: 2,
      type: "generic",
    });
    await request(`${repoPath}/issues`, "POST", { title: "Another issue" });
    expect(
      await (await request(`${repoPath}/issues/2/artifacts`, "POST", { name: "Notes", body: "Notes" })).json(),
    ).toMatchObject({ number: 1 });
    expect((await request(repoPath, "DELETE")).status).toBe(204);
    expect(context.gh.issueArtifacts.all()).toHaveLength(0);
  });

  it("supports pull requests and paginates filtered lists without Link headers", async () => {
    const branch = await request(`${repoPath}/branches/main`);
    const { commit } = (await branch.json()) as { commit: { sha: string } };
    await request(`${repoPath}/git/refs`, "POST", { ref: "refs/heads/feature", sha: commit.sha });
    await request(`${repoPath}/contents/notes.md`, "PUT", {
      branch: "feature",
      message: "Add notes",
      content: Buffer.from("Notes\n").toString("base64"),
    });
    const pull = await request(`${repoPath}/pulls`, "POST", { title: "Pull request", head: "feature", base: "main" });
    expect(pull.status).toBe(201);
    const { number } = (await pull.json()) as { number: number };
    const path = `${repoPath}/issues/${number}/artifacts`;
    for (const type of ["link", "generic", "link"]) {
      expect((await request(path, "POST", { type, name: "Artifact", body: "https://example.com" })).status).toBe(201);
    }
    const page = await request(`${path}?type=link&per_page=1&page=2`);
    expect(page.headers.get("Link")).toBeNull();
    expect(await page.json()).toMatchObject([{ number: 3, type: "link" }]);
    expect(await (await request(`${path}?type=link&per_page=1&page=3`)).json()).toEqual([]);
    expect((await request(`${path}?type=unknown`)).status).toBe(422);
    expect((await request(path, "POST", { type: "unknown", name: "Bad", body: "Bad" })).status).toBe(422);
    expect((await request(path, "POST", { name: "Missing body" })).status).toBe(422);
    expect((await request(`${path}/1`, "PATCH", {})).status).toBe(422);
  });

  it("checks repository grants and issue write permissions and attributes installation writes to the bot", async () => {
    const privateRepo = context.gh.repos.findOneBy("full_name", "octocat/private-repo")!;
    const owner = context.gh.users.findOneBy("login", "octocat")!;
    for (const [token, permissions, repositoryIds] of [
      ["reader", { pull_requests: "read" }, [privateRepo.id]],
      ["writer", { issues: "write" }, [privateRepo.id]],
      ["wrong-permission", { pull_requests: "write" }, [privateRepo.id]],
      ["wrong-repo", { issues: "write" }, []],
    ] as const) {
      context.tokenMap.set(token, {
        login: "app",
        id: 42,
        scopes: [],
        installation: {
          appId: 42,
          installationId: 99,
          accountId: owner.id,
          accountType: "User",
          permissions: { ...permissions },
          repositoryIds: [...repositoryIds],
          repositorySelection: "selected",
        },
      });
    }
    await request("/repos/octocat/private-repo/issues", "POST", { title: "Private issue" });
    const path = "/repos/octocat/private-repo/issues/1/artifacts";
    expect((await request(path, "GET", undefined, null)).status).toBe(401);
    expect((await request(path, "GET", undefined, "hubot")).status).toBe(403);
    expect((await request(path, "GET", undefined, "reader")).status).toBe(200);
    for (const token of ["reader", "wrong-permission", "wrong-repo"]) {
      expect((await request(path, "POST", { name: "Review", body: "Link" }, token)).status).toBe(403);
    }
    const created = await request(path, "POST", { name: "Review", body: "Link" }, "writer");
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ creator: { login: "app-42[bot]", type: "Bot" } });
    expect((await request(`${path}/1`, "PATCH", { body: "Updated" }, "reader")).status).toBe(403);
    expect((await request(`${path}/1`, "DELETE", undefined, "reader")).status).toBe(403);
    expect((await request("/repos/octocat/private-repo/issues/1/lock", "PUT", {})).status).toBe(204);
    expect((await request(path, "POST", { name: "Locked", body: "Locked" }, "writer")).status).toBe(403);
  });
});
