import type { WebhookDispatcher } from "@emulators/core";
import type { GitHubRepo, GitHubUser } from "./entities.js";
import type { GitHubStore } from "./store.js";
import { formatPullRequest, formatRepo, formatUser } from "./helpers.js";
import { ownerLoginOf } from "./route-helpers.js";

/** Advance open pull requests and notify their base repositories when a head branch changes. */
export function synchronizePullRequestHeads(
  gh: GitHubStore,
  webhooks: WebhookDispatcher,
  repo: GitHubRepo,
  ref: string,
  sha: string,
  user: GitHubUser,
  baseUrl: string,
): void {
  if (!ref.startsWith("refs/heads/")) return;
  const branch = ref.slice("refs/heads/".length);
  for (const pr of gh.pullRequests.all()) {
    if (pr.state !== "open" || pr.head_repo_id !== repo.id || pr.head_ref !== branch || pr.head_sha === sha) continue;
    const baseRepo = gh.repos.get(pr.repo_id);
    if (!baseRepo) continue;
    const before = pr.head_sha;
    const updated = gh.pullRequests.update(pr.id, { head_sha: sha })!;
    webhooks.dispatch(
      "pull_request",
      "synchronize",
      {
        action: "synchronize",
        before,
        after: sha,
        number: pr.number,
        pull_request: formatPullRequest(updated, gh, baseUrl),
        repository: formatRepo(baseRepo, gh, baseUrl),
        sender: formatUser(user, baseUrl),
      },
      ownerLoginOf(gh, baseRepo),
      baseRepo.name,
    );
  }
}
