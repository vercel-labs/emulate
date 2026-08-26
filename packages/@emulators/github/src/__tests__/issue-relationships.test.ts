import { beforeEach, describe, expect, it } from "vitest";
import {
  Hono,
  Store,
  WebhookDispatcher,
  authMiddleware,
  createApiErrorHandler,
  createErrorHandler,
  type TokenMap,
} from "@emulators/core";
import { addSubIssue, getGitHubStore, githubPlugin, seedFromConfig, type GitHubIssue } from "../index.js";

const base = "http://localhost:4000";
const repository = "octocat/hello-world";

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("test-token", { login: "octocat", id: 1, scopes: ["repo", "user", "admin:org"] });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app as any, store, webhooks, base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "octocat" }, { login: "octolib" }, { login: "other" }],
    repos: [
      { owner: "octocat", name: "hello-world" },
      { owner: "octocat", name: "second-repo" },
      { owner: "octolib", name: "library" },
      { owner: "other", name: "private", private: true },
    ],
  });

  return { app, store, tokenMap, webhooks };
}

function authHeaders(token = "test-token"): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function jsonHeaders(token = "test-token"): Record<string, string> {
  return { ...authHeaders(token), "Content-Type": "application/json" };
}

async function createIssue(app: Hono, repo = repository, title = "Issue") {
  const response = await app.request(`${base}/repos/${repo}/issues`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ title }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: number; number: number; title: string };
}

function directIssue(
  gh: ReturnType<typeof getGitHubStore>,
  repoId: number,
  userId: number,
  number: number,
): GitHubIssue {
  const issue = gh.issues.insert({
    node_id: `direct-${number}`,
    number,
    repo_id: repoId,
    title: `Direct issue ${number}`,
    body: null,
    state: "open",
    state_reason: null,
    duplicate_issue_id: null,
    locked: false,
    active_lock_reason: null,
    user_id: userId,
    assignee_ids: [],
    label_ids: [],
    milestone_id: null,
    comments: 0,
    closed_at: null,
    closed_by_id: null,
    is_pull_request: false,
  });
  return issue;
}

describe("GitHub issue relationship store operations and REST routes", () => {
  let app: Hono;
  let store: Store;

  beforeEach(() => {
    const testApp = createTestApp();
    app = testApp.app;
    store = testApp.store;
  });

  it("keeps ordered sub-issues coherent across add, list, parent, reprioritize, and remove", async () => {
    const parent = await createIssue(app, repository, "Parent");
    const first = await createIssue(app, repository, "First");
    const second = await createIssue(app, repository, "Second");
    const third = await createIssue(app, repository, "Third");

    for (const child of [first, second, third]) {
      const response = await app.request(`${base}/repos/${repository}/issues/${parent.number}/sub_issues`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ sub_issue_id: child.id }),
      });
      expect(response.status).toBe(201);
    }

    const firstPage = await app.request(`${base}/repos/${repository}/issues/${parent.number}/sub_issues?per_page=2`, {
      headers: authHeaders(),
    });
    expect(firstPage.status).toBe(200);
    expect(((await firstPage.json()) as Array<{ id: number }>).map((issue) => issue.id)).toEqual([first.id, second.id]);
    expect(firstPage.headers.get("Link")).toContain('rel="next"');
    expect(firstPage.headers.get("Link")).toContain('rel="last"');

    const secondPage = await app.request(
      `${base}/repos/${repository}/issues/${parent.number}/sub_issues?page=2&per_page=2`,
      { headers: authHeaders() },
    );
    expect(((await secondPage.json()) as Array<{ id: number }>).map((issue) => issue.id)).toEqual([third.id]);
    expect(secondPage.headers.get("Link")).toContain('rel="first"');
    expect(secondPage.headers.get("Link")).toContain('rel="prev"');

    const parentResponse = await app.request(`${base}/repos/${repository}/issues/${first.number}/parent`, {
      headers: authHeaders(),
    });
    expect(parentResponse.status).toBe(200);
    expect(((await parentResponse.json()) as { id: number }).id).toBe(parent.id);

    const reprioritized = await app.request(`${base}/repos/${repository}/issues/${parent.number}/sub_issues/priority`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ sub_issue_id: third.id, before_id: first.id }),
    });
    expect(reprioritized.status).toBe(200);

    const afterReprioritize = await app.request(
      `${base}/repos/${repository}/issues/${parent.number}/sub_issues?per_page=100`,
      { headers: authHeaders() },
    );
    expect(((await afterReprioritize.json()) as Array<{ id: number }>).map((issue) => issue.id)).toEqual([
      third.id,
      first.id,
      second.id,
    ]);

    const removed = await app.request(`${base}/repos/${repository}/issues/${parent.number}/sub_issue`, {
      method: "DELETE",
      headers: jsonHeaders(),
      body: JSON.stringify({ sub_issue_id: first.id }),
    });
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as { id: number }).id).toBe(first.id);

    const gh = getGitHubStore(store);
    expect(
      gh.issueSubIssues
        .all()
        .sort((left, right) => left.position - right.position)
        .map((relation) => relation.child_issue_id),
    ).toEqual([third.id, second.id]);
    expect(
      gh.issueSubIssues
        .all()
        .map((relation) => relation.position)
        .sort(),
    ).toEqual([0, 1]);
  });

  it("rejects self, duplicate, conflicting-parent, and cyclic hierarchy mutations atomically", async () => {
    const first = await createIssue(app, repository, "First");
    const second = await createIssue(app, repository, "Second");
    const third = await createIssue(app, repository, "Third");
    const alternateParent = await createIssue(app, repository, "Alternate parent");

    const add = async (parent: number, child: number, replaceParent?: boolean) => {
      const response = await app.request(`${base}/repos/${repository}/issues/${parent}/sub_issues`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          sub_issue_id: child,
          ...(replaceParent === undefined ? {} : { replace_parent: replaceParent }),
        }),
      });
      return response;
    };

    expect((await add(first.number, first.id)).status).toBe(422);
    expect((await add(first.number, second.id)).status).toBe(201);
    expect((await add(first.number, second.id)).status).toBe(422);
    expect((await add(alternateParent.number, second.id)).status).toBe(422);

    const gh = getGitHubStore(store);
    expect(gh.issueSubIssues.count()).toBe(1);

    expect((await add(alternateParent.number, second.id, true)).status).toBe(201);
    expect((await add(second.number, third.id)).status).toBe(201);
    expect((await add(third.number, alternateParent.id)).status).toBe(422);

    const currentParent = await app.request(`${base}/repos/${repository}/issues/${second.number}/parent`, {
      headers: authHeaders(),
    });
    expect(((await currentParent.json()) as { id: number }).id).toBe(alternateParent.id);
  });

  it("allows same-owner cross-repository sub-issues and rejects another owner's issue", async () => {
    const parent = await createIssue(app, repository, "Parent");
    const sameOwnerChild = await createIssue(app, "octocat/second-repo", "Same owner child");
    const otherOwnerChild = await createIssue(app, "octolib/library", "Other owner child");

    const sameOwner = await app.request(`${base}/repos/${repository}/issues/${parent.number}/sub_issues`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ sub_issue_id: sameOwnerChild.id }),
    });
    expect(sameOwner.status).toBe(201);

    const otherOwner = await app.request(`${base}/repos/${repository}/issues/${parent.number}/sub_issues`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ sub_issue_id: otherOwnerChild.id }),
    });
    expect(otherOwner.status).toBe(422);
  });

  it("requires selected installations to include both repositories for relationship reads and writes", async () => {
    const testApp = createTestApp();
    app = testApp.app;
    store = testApp.store;
    const { tokenMap } = testApp;
    const parent = await createIssue(app, repository, "Selected parent");
    const child = await createIssue(app, "octocat/second-repo", "Selected child");
    const gh = getGitHubStore(store);
    const parentRepo = gh.repos.findOneBy("full_name", repository)!;
    const childRepo = gh.repos.findOneBy("full_name", "octocat/second-repo")!;
    const octocat = gh.users.findOneBy("login", "octocat")!;

    const installation = (repositoryIds: number[]) => ({
      login: octocat.login,
      id: octocat.id,
      scopes: ["issues:read", "issues:write"],
      installation: {
        installationId: 42,
        appId: 42,
        accountId: octocat.id,
        accountType: "User" as const,
        permissions: { issues: "write" },
        repositoryIds,
        repositorySelection: "selected" as const,
      },
    });
    tokenMap.set("selected-parent-only", installation([parentRepo.id]));
    tokenMap.set("selected-both", installation([parentRepo.id, childRepo.id]));

    const deniedWrite = await app.request(`${base}/repos/${repository}/issues/${parent.number}/sub_issues`, {
      method: "POST",
      headers: jsonHeaders("selected-parent-only"),
      body: JSON.stringify({ sub_issue_id: child.id }),
    });
    expect(deniedWrite.status).toBe(403);
    expect(gh.issueSubIssues.count()).toBe(0);

    const allowedWrite = await app.request(`${base}/repos/${repository}/issues/${parent.number}/sub_issues`, {
      method: "POST",
      headers: jsonHeaders("selected-both"),
      body: JSON.stringify({ sub_issue_id: child.id }),
    });
    expect(allowedWrite.status).toBe(201);

    const deniedRead = await app.request(`${base}/repos/${repository}/issues/${parent.number}/sub_issues`, {
      headers: authHeaders("selected-parent-only"),
    });
    expect(deniedRead.status).toBe(403);

    const allowedRead = await app.request(`${base}/repos/${repository}/issues/${parent.number}/sub_issues`, {
      headers: authHeaders("selected-both"),
    });
    expect(allowedRead.status).toBe(200);
    expect(((await allowedRead.json()) as Array<{ id: number }>).map((issue) => issue.id)).toEqual([child.id]);
  });

  it("lists exactly 100 sub-issues on the first page and one on the next", async () => {
    const gh = getGitHubStore(store);
    const repo = gh.repos.findOneBy("full_name", repository)!;
    const user = gh.users.findOneBy("login", "octocat")!;
    const parent = directIssue(gh, repo.id, user.id, 1000);
    for (let number = 1001; number <= 1101; number += 1) {
      const child = directIssue(gh, repo.id, user.id, number);
      addSubIssue(gh, parent.id, child.id);
    }

    const firstPage = await app.request(`${base}/repos/${repository}/issues/${parent.number}/sub_issues?per_page=100`, {
      headers: authHeaders(),
    });
    expect(firstPage.status).toBe(200);
    expect(await firstPage.json()).toHaveLength(100);
    expect(firstPage.headers.get("Link")).toContain("page=2");

    const secondPage = await app.request(
      `${base}/repos/${repository}/issues/${parent.number}/sub_issues?page=2&per_page=100`,
      { headers: authHeaders() },
    );
    expect(await secondPage.json()).toHaveLength(1);
  });

  it("keeps dependency direction distinct and rejects duplicate, self, and cyclic edges", async () => {
    const blocked = await createIssue(app, repository, "Blocked");
    const blocker = await createIssue(app, repository, "Blocker");
    const transitiveBlocker = await createIssue(app, repository, "Transitive blocker");

    const add = async (blockedNumber: number, blockingId: number) =>
      app.request(`${base}/repos/${repository}/issues/${blockedNumber}/dependencies/blocked_by`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ issue_id: blockingId }),
      });

    const added = await add(blocked.number, blocker.id);
    expect(added.status).toBe(201);
    expect(((await added.json()) as { id: number }).id).toBe(blocker.id);
    expect((await add(blocker.number, transitiveBlocker.id)).status).toBe(201);
    expect((await add(blocked.number, blocker.id)).status).toBe(422);
    expect((await add(blocked.number, blocked.id)).status).toBe(422);
    expect((await add(transitiveBlocker.number, blocked.id)).status).toBe(422);

    const blockedBy = await app.request(
      `${base}/repos/${repository}/issues/${blocked.number}/dependencies/blocked_by`,
      { headers: authHeaders() },
    );
    expect(((await blockedBy.json()) as Array<{ id: number }>).map((issue) => issue.id)).toEqual([blocker.id]);

    const blocking = await app.request(`${base}/repos/${repository}/issues/${blocker.number}/dependencies/blocking`, {
      headers: authHeaders(),
    });
    expect(((await blocking.json()) as Array<{ id: number }>).map((issue) => issue.id)).toEqual([blocked.id]);

    const removed = await app.request(
      `${base}/repos/${repository}/issues/${blocked.number}/dependencies/blocked_by/${blocker.id}`,
      { method: "DELETE", headers: authHeaders() },
    );
    expect(removed.status).toBe(204);
    expect(
      await (
        await app.request(`${base}/repos/${repository}/issues/${blocked.number}/dependencies/blocked_by`, {
          headers: authHeaders(),
        })
      ).json(),
    ).toEqual([]);

    const gh = getGitHubStore(store);
    const dependencyEvents = gh.issueEvents.all().filter((event) => {
      return event.blocked_issue_id === blocked.id && event.blocking_issue_id === blocker.id;
    });
    expect(dependencyEvents.map((event) => event.event).sort()).toEqual([
      "blocked_by_added",
      "blocked_by_removed",
      "blocking_added",
      "blocking_removed",
    ]);
  });

  it("rejects inaccessible dependency targets before mutating the relation store", async () => {
    const blocked = await createIssue(app, repository, "Blocked");
    const inaccessible = await createIssue(app, "octolib/library", "Private blocker");
    const gh = getGitHubStore(store);
    const relationCount = gh.issueDependencies.count();
    const privateRepo = gh.repos.findOneBy("full_name", "octolib/library");
    expect(privateRepo).toBeDefined();
    gh.repos.update(privateRepo!.id, { private: true, visibility: "private" });

    const response = await app.request(`${base}/repos/${repository}/issues/${blocked.number}/dependencies/blocked_by`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ issue_id: inaccessible.id }),
    });
    expect(response.status).toBe(403);
    expect(gh.issueDependencies.count()).toBe(relationCount);
  });

  it("records relationship events for both affected issue sides", async () => {
    const parent = await createIssue(app, repository, "Parent");
    const child = await createIssue(app, repository, "Child");
    const addSub = await app.request(`${base}/repos/${repository}/issues/${parent.number}/sub_issues`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ sub_issue_id: child.id }),
    });
    expect(addSub.status).toBe(201);

    const gh = getGitHubStore(store);
    const relationshipEvents = gh.issueEvents.all().filter((event) => event.sub_issue_id === child.id);
    expect(relationshipEvents).toHaveLength(2);
    expect(relationshipEvents.map((event) => event.event).sort()).toEqual(["parent_issue_added", "sub_issue_added"]);

    const timeline = await app.request(`${base}/repos/${repository}/issues/${parent.number}/events`, {
      headers: authHeaders(),
    });
    const timelineEvents = (await timeline.json()) as Array<{ event: string; sub_issue_id?: number }>;
    expect(timelineEvents.find((event) => event.event === "sub_issue_added")?.sub_issue_id).toBe(child.id);
  });
});
