import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ghAvailable, startGhEmulator, type GhEmulator } from "./gh-cli-harness.js";

// Scenarios adapted from cli/cli acceptance/testdata/pr/*.txtar. Git clone and push
// steps are replaced by REST seeding: a branch ref plus a commit through the contents API.
const hasGh = await ghAvailable();
const REPO = ["--repo", "octocat/hello-world"];

describe.skipIf(!hasGh)("gh CLI against the GitHub emulator", () => {
  let emu: GhEmulator;

  async function pushBranch(branch: string, file = `${branch}.txt`) {
    const main = await emu.rest("GET", "/repos/octocat/hello-world/git/ref/heads/main");
    await emu.rest("POST", "/repos/octocat/hello-world/git/refs", {
      ref: `refs/heads/${branch}`,
      sha: main.object.sha,
    });
    const put = await emu.rest("PUT", `/repos/octocat/hello-world/contents/${file}`, {
      message: `Add ${file}`,
      content: Buffer.from("Unimportant contents\n").toString("base64"),
      branch,
    });
    return put.commit.sha as string;
  }

  async function createPr(branch: string, ...extra: string[]) {
    const { stdout } = await emu.gh(
      "pr",
      "create",
      ...REPO,
      "--head",
      branch,
      "--title",
      branch,
      "--body",
      "Feature Body",
      ...extra,
    );
    return stdout.trim();
  }

  const viewJson = async (pr: string, fields: string) =>
    JSON.parse((await emu.gh("pr", "view", pr, ...REPO, "--json", fields)).stdout);

  beforeEach(async () => {
    emu = await startGhEmulator({
      users: [{ login: "octocat", name: "The Octocat" }],
      repos: [{ owner: "octocat", name: "hello-world" }],
    });
  });

  afterEach(async () => {
    await emu.close();
  });

  it("pr-create-no-local-repo: creates a pull request and views its head ref", async () => {
    await pushBranch("feature");
    const url = await createPr("feature");
    expect(url).toBe("http://github.localhost/octocat/hello-world/pull/1");
    const { stdout } = await emu.gh("pr", "view", url, "--json", "headRefName", "--jq", ".headRefName");
    expect(stdout.trim()).toBe("feature");
  });

  it("pr-view: shows the default view", async () => {
    await pushBranch("feature");
    const url = await createPr("feature");
    const { stdout } = await emu.gh("pr", "view", url);
    expect(stdout).toMatch(/^title:\tfeature$/m);
    expect(stdout).toMatch(/^state:\tOPEN$/m);
    expect(stdout).toContain("Feature Body");
  });

  it("pr-list: lists the new pull request", async () => {
    await pushBranch("feature");
    await createPr("feature");
    const { stdout } = await emu.gh("pr", "list", ...REPO, "--limit", "1000");
    expect(stdout).toMatch(/^1\tfeature\tfeature\tOPEN\t/m);
  });

  it("pr-create-with-metadata: applies labels and assignees", async () => {
    await emu.rest("POST", "/repos/octocat/hello-world/labels", { name: "bug", color: "d73a4a" });
    await pushBranch("feature");
    const url = await createPr("feature", "--assignee", "@me", "--label", "bug");
    const { stdout } = await emu.gh("pr", "view", url);
    expect(stdout).toMatch(/^assignees:\t.+$/m);
    expect(stdout).toMatch(/^labels:\tbug$/m);
  });

  it("pr-comment-new: comments and shows the comment", async () => {
    await pushBranch("feature");
    const url = await createPr("feature");
    await emu.gh("pr", "comment", url, "--body", "Looks like a great feature!");
    const { stdout } = await emu.gh("pr", "view", url, "--comments");
    expect(stdout).toContain("Looks like a great feature!");
  });

  it("pr-merge-merge-strategy: merges and deletes the remote branch", async () => {
    await pushBranch("feature", "file.txt");
    const url = await createPr("feature");
    await emu.gh("pr", "merge", url, "--merge", "--delete-branch");
    const { stdout } = await emu.gh("pr", "view", url);
    expect(stdout).toMatch(/^state:\tMERGED$/m);
    const branches = await emu.rest("GET", "/repos/octocat/hello-world/branches");
    expect(branches.map((b: { name: string }) => b.name)).toEqual(["main"]);
    const contents = await emu.rest("GET", "/repos/octocat/hello-world/contents/file.txt?ref=main");
    expect(contents.type).toBe("file");
    const head = await emu.rest("GET", "/repos/octocat/hello-world/commits/main");
    expect(head.commit.message).toMatch(/^Merge pull request #1/);
  });

  it("reviews, toggles draft, closes, and reopens", async () => {
    await pushBranch("feature");
    const url = await createPr("feature", "--draft");
    expect(await viewJson(url, "isDraft")).toEqual({ isDraft: true });

    await expect(emu.gh("pr", "merge", url, "--merge")).rejects.toMatchObject({
      stderr: expect.stringContaining("Draft pull requests cannot be merged."),
    });

    await emu.gh("pr", "ready", url);
    await emu.gh("pr", "review", url, "--approve", "--body", "lgtm");
    expect(await viewJson(url, "isDraft,reviewDecision,latestReviews")).toMatchObject({
      isDraft: false,
      reviewDecision: "APPROVED",
      latestReviews: [{ author: { login: "octocat" }, body: "lgtm", state: "APPROVED" }],
    });

    await emu.gh("pr", "close", url);
    expect(await viewJson(url, "state")).toEqual({ state: "CLOSED" });
    await emu.gh("pr", "reopen", url);
    expect(await viewJson(url, "state")).toEqual({ state: "OPEN" });
  });

  it("reports check runs in pr checks and statusCheckRollup", async () => {
    const sha = await pushBranch("feature");
    const url = await createPr("feature");
    await emu.rest("POST", "/repos/octocat/hello-world/check-runs", {
      name: "build",
      head_sha: sha,
      status: "completed",
      conclusion: "success",
    });
    const { stdout } = await emu.gh("pr", "checks", url);
    expect(stdout).toMatch(/^build\tpass\t/m);
    expect(await viewJson(url, "statusCheckRollup")).toMatchObject({
      statusCheckRollup: [{ __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" }],
    });
  });

  it("shows pull requests created by the viewer in pr status", async () => {
    await pushBranch("feature");
    await createPr("feature");
    const { stdout } = await emu.gh("pr", "status", ...REPO);
    expect(stdout).toContain("#1  feature [feature]");
  });
});
