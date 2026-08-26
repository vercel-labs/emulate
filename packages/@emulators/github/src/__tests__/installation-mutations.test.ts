import { describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { authMiddleware, createApiErrorHandler, createErrorHandler, type TokenMap } from "@emulators/core";
import { githubPlugin, seedFromConfig, getGitHubStore } from "../index.js";

const base = "http://localhost:4000";

function createInstallationApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app as any, store, webhooks, base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "octocat" }],
    orgs: [{ login: "acme" }],
    repos: [
      { owner: "octocat", name: "hello-world" },
      { owner: "octocat", name: "head-repo" },
      { owner: "acme", name: "included" },
      { owner: "acme", name: "excluded" },
    ],
  });

  const gh = getGitHubStore(store);
  const user = gh.users.findOneBy("login", "octocat")!;
  const org = gh.orgs.findOneBy("login", "acme")!;
  const baseRepo = gh.repos.findOneBy("full_name", "octocat/hello-world")!;
  const headRepo = gh.repos.findOneBy("full_name", "octocat/head-repo")!;
  gh.repos.update(headRepo.id, { fork: true, forked_from_id: baseRepo.id });
  const included = gh.repos.findOneBy("full_name", "acme/included")!;
  tokenMap.set("user-install-write", {
    login: user.login,
    id: user.id,
    scopes: ["issues:write"],
    installation: {
      installationId: 42,
      appId: 42,
      accountId: user.id,
      accountType: "User",
      permissions: { issues: "write" },
      repositoryIds: [],
      repositorySelection: "all",
    },
  });
  tokenMap.set("org-install-read", {
    login: org.login,
    id: org.id,
    scopes: ["issues:read"],
    installation: {
      installationId: 43,
      appId: 43,
      accountId: org.id,
      accountType: "Organization",
      permissions: { issues: "read" },
      repositoryIds: [included.id],
      repositorySelection: "selected",
    },
  });
  tokenMap.set("org-install-write", {
    login: org.login,
    id: org.id,
    scopes: ["issues:write"],
    installation: {
      installationId: 44,
      appId: 44,
      accountId: org.id,
      accountType: "Organization",
      permissions: { issues: "write" },
      repositoryIds: [included.id],
      repositorySelection: "selected",
    },
  });
  tokenMap.set("user-install-pr", {
    login: user.login,
    id: user.id,
    scopes: ["pull_requests:write"],
    installation: {
      installationId: 45,
      appId: 45,
      accountId: user.id,
      accountType: "User",
      permissions: { pull_requests: "write" },
      repositoryIds: [],
      repositorySelection: "all",
    },
  });
  tokenMap.set("user-install-pr-head", {
    login: user.login,
    id: user.id,
    scopes: ["pull_requests:write", "contents:write"],
    installation: {
      installationId: 47,
      appId: 47,
      accountId: user.id,
      accountType: "User",
      permissions: { pull_requests: "write", contents: "write" },
      repositoryIds: [baseRepo.id, headRepo.id],
      repositorySelection: "selected",
    },
  });
  tokenMap.set("user-install-pr-head-no-contents", {
    login: user.login,
    id: user.id,
    scopes: ["pull_requests:write"],
    installation: {
      installationId: 48,
      appId: 48,
      accountId: user.id,
      accountType: "User",
      permissions: { pull_requests: "write" },
      repositoryIds: [baseRepo.id, headRepo.id],
      repositorySelection: "selected",
    },
  });
  tokenMap.set("user-install-pr-base-only", {
    login: user.login,
    id: user.id,
    scopes: ["pull_requests:write", "contents:write"],
    installation: {
      installationId: 49,
      appId: 49,
      accountId: user.id,
      accountType: "User",
      permissions: { pull_requests: "write", contents: "write" },
      repositoryIds: [baseRepo.id],
      repositorySelection: "selected",
    },
  });
  tokenMap.set("user-install-contents", {
    login: user.login,
    id: user.id,
    scopes: ["contents:write"],
    installation: {
      installationId: 46,
      appId: 46,
      accountId: user.id,
      accountType: "User",
      permissions: { contents: "write" },
      repositoryIds: [],
      repositorySelection: "all",
    },
  });

  return { app, store };
}

function headers(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

describe("GitHub installation mutation permissions", () => {
  it("uses a user installation bot for issue, comment, and label writes", async () => {
    const { app } = createInstallationApp();
    const issueResponse = await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers: headers("user-install-write"),
      body: JSON.stringify({ title: "Installation issue" }),
    });
    expect(issueResponse.status).toBe(201);
    const issue = (await issueResponse.json()) as { user: { login: string }; number: number };
    expect(issue.user.login).toBe("app-42[bot]");

    const commentResponse = await app.request(`${base}/repos/octocat/hello-world/issues/${issue.number}/comments`, {
      method: "POST",
      headers: headers("user-install-write"),
      body: JSON.stringify({ body: "Installation comment" }),
    });
    expect(commentResponse.status).toBe(201);
    expect(((await commentResponse.json()) as { user: { login: string } }).user.login).toBe("app-42[bot]");

    const labelResponse = await app.request(`${base}/repos/octocat/hello-world/labels`, {
      method: "POST",
      headers: headers("user-install-write"),
      body: JSON.stringify({ name: "installation" }),
    });
    expect(labelResponse.status).toBe(201);
  });

  it("enforces installation write permission and selected repositories", async () => {
    const { app } = createInstallationApp();
    const readOnlyResponse = await app.request(`${base}/repos/acme/included/issues`, {
      method: "POST",
      headers: headers("org-install-read"),
      body: JSON.stringify({ title: "Read only" }),
    });
    expect(readOnlyResponse.status).toBe(403);

    const allowedResponse = await app.request(`${base}/repos/acme/included/issues`, {
      method: "POST",
      headers: headers("org-install-write"),
      body: JSON.stringify({ title: "Allowed" }),
    });
    expect(allowedResponse.status).toBe(201);
    expect(((await allowedResponse.json()) as { user: { login: string } }).user.login).toBe("app-44[bot]");

    const excludedResponse = await app.request(`${base}/repos/acme/excluded/issues`, {
      method: "POST",
      headers: headers("org-install-write"),
      body: JSON.stringify({ title: "Excluded" }),
    });
    expect(excludedResponse.status).toBe(403);
  });

  it("uses pull_requests permission for pull request mutations", async () => {
    const { app } = createInstallationApp();
    const allowedResponse = await app.request(`${base}/repos/octocat/hello-world/pulls`, {
      method: "POST",
      headers: headers("user-install-pr"),
      body: JSON.stringify({ title: "Allowed pull", head: "feature", base: "main" }),
    });
    expect(allowedResponse.status).toBe(201);
    const pull = (await allowedResponse.json()) as { number: number };

    const updateBranchResponse = await app.request(
      `${base}/repos/octocat/hello-world/pulls/${pull.number}/update-branch`,
      {
        method: "PUT",
        headers: headers("user-install-pr-head"),
        body: JSON.stringify({}),
      },
    );
    expect(updateBranchResponse.status).toBe(202);

    const missingContentsResponse = await app.request(
      `${base}/repos/octocat/hello-world/pulls/${pull.number}/update-branch`,
      {
        method: "PUT",
        headers: headers("user-install-pr-head-no-contents"),
        body: JSON.stringify({}),
      },
    );
    expect(missingContentsResponse.status).toBe(403);

    const deniedResponse = await app.request(`${base}/repos/octocat/hello-world/pulls`, {
      method: "POST",
      headers: headers("user-install-contents"),
      body: JSON.stringify({ title: "Denied pull", head: "feature-2", base: "main" }),
    });
    expect(deniedResponse.status).toBe(403);
  });

  it("requires selected head access and contents write for forked update branches", async () => {
    const { app, store } = createInstallationApp();
    const pullResponse = await app.request(`${base}/repos/octocat/hello-world/pulls`, {
      method: "POST",
      headers: headers("user-install-pr"),
      body: JSON.stringify({ title: "Forked pull", head: "head-feature", base: "main" }),
    });
    expect(pullResponse.status).toBe(201);
    const pull = (await pullResponse.json()) as { number: number };

    const gh = getGitHubStore(store);
    const baseRepo = gh.repos.findOneBy("full_name", "octocat/hello-world")!;
    const headRepo = gh.repos.findOneBy("full_name", "octocat/head-repo")!;
    const headBranch = gh.branches.findBy("repo_id", headRepo.id).find((branch) => branch.name === "main")!;
    const pullRow = gh.pullRequests.findBy("repo_id", baseRepo.id).find((row) => row.number === pull.number)!;
    gh.pullRequests.update(pullRow.id, {
      head_repo_id: headRepo.id,
      head_ref: headBranch.name,
      head_sha: headBranch.sha,
    });

    const unselectedHeadResponse = await app.request(
      `${base}/repos/octocat/hello-world/pulls/${pull.number}/update-branch`,
      {
        method: "PUT",
        headers: headers("user-install-pr-base-only"),
        body: JSON.stringify({}),
      },
    );
    expect(unselectedHeadResponse.status).toBe(403);

    const missingContentsResponse = await app.request(
      `${base}/repos/octocat/hello-world/pulls/${pull.number}/update-branch`,
      {
        method: "PUT",
        headers: headers("user-install-pr-head-no-contents"),
        body: JSON.stringify({}),
      },
    );
    expect(missingContentsResponse.status).toBe(403);

    const allowedResponse = await app.request(`${base}/repos/octocat/hello-world/pulls/${pull.number}/update-branch`, {
      method: "PUT",
      headers: headers("user-install-pr-head"),
      body: JSON.stringify({}),
    });
    expect(allowedResponse.status).toBe(202);
  });

  it("accepts pull_requests permission for shared issue comment mutations", async () => {
    const { app } = createInstallationApp();
    const issueResponse = await app.request(`${base}/repos/octocat/hello-world/issues`, {
      method: "POST",
      headers: headers("user-install-write"),
      body: JSON.stringify({ title: "Shared comment issue" }),
    });
    expect(issueResponse.status).toBe(201);
    const issue = (await issueResponse.json()) as { node_id: string; number: number };

    const commentResponse = await app.request(`${base}/repos/octocat/hello-world/issues/${issue.number}/comments`, {
      method: "POST",
      headers: headers("user-install-pr"),
      body: JSON.stringify({ body: "Pull request permission comment" }),
    });
    expect(commentResponse.status).toBe(201);
    const comment = (await commentResponse.json()) as { id: number };

    const patchResponse = await app.request(`${base}/repos/octocat/hello-world/issues/comments/${comment.id}`, {
      method: "PATCH",
      headers: headers("user-install-pr"),
      body: JSON.stringify({ body: "Edited with pull request permission" }),
    });
    expect(patchResponse.status).toBe(200);

    const deleteResponse = await app.request(`${base}/repos/octocat/hello-world/issues/comments/${comment.id}`, {
      method: "DELETE",
      headers: headers("user-install-pr"),
    });
    expect(deleteResponse.status).toBe(204);

    const graphqlResponse = await app.request(`${base}/graphql`, {
      method: "POST",
      headers: headers("user-install-pr"),
      body: JSON.stringify({
        query: `mutation AddComment($input: AddCommentInput!) {
          addComment(input: $input) { comment { body author { login } } }
        }`,
        variables: { input: { subjectId: issue.node_id, body: "GraphQL pull request permission comment" } },
      }),
    });
    expect(graphqlResponse.status).toBe(200);
    expect(await graphqlResponse.json()).toMatchObject({
      data: {
        addComment: { comment: { body: "GraphQL pull request permission comment", author: { login: "app-45[bot]" } } },
      },
    });
  });
});
