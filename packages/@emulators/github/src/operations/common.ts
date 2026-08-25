import type { WebhookDispatcher } from "@emulators/core";
import { generateNodeId } from "../helpers.js";
import type { GitHubIssueEvent, GitHubRepo } from "../entities.js";
import type { GitHubStore } from "../store.js";

export interface GitHubMutationContext {
  gh: GitHubStore;
  webhooks: WebhookDispatcher;
  baseUrl: string;
}

export function adjustRepoOpenIssues(gh: GitHubStore, repoId: number, delta: number): void {
  const repo = gh.repos.get(repoId);
  if (!repo) return;
  gh.repos.update(repoId, { open_issues_count: Math.max(0, repo.open_issues_count + delta) });
}

export function insertIssueEvent(
  gh: GitHubStore,
  repo: GitHubRepo,
  issueNumber: number,
  event: string,
  actorId: number,
  extra?: Partial<
    Pick<
      GitHubIssueEvent,
      | "commit_id"
      | "commit_url"
      | "label_name"
      | "assignee_id"
      | "milestone_title"
      | "rename"
      | "comment_id"
      | "comment_body"
      | "timeline_only"
    >
  >,
): GitHubIssueEvent {
  const row = gh.issueEvents.insert({
    node_id: "",
    repo_id: repo.id,
    issue_number: issueNumber,
    event,
    actor_id: actorId,
    commit_id: null,
    commit_url: null,
    label_name: null,
    assignee_id: null,
    milestone_title: null,
    rename: null,
    comment_id: null,
    comment_body: null,
    timeline_only: false,
    ...extra,
  } as Omit<GitHubIssueEvent, "id" | "created_at" | "updated_at">);
  gh.issueEvents.update(row.id, { node_id: generateNodeId("IssueEvent", row.id) });
  return gh.issueEvents.get(row.id)!;
}

export function dispatchGitHubWebhook(
  context: GitHubMutationContext,
  event: string,
  action: string | undefined,
  payload: unknown,
  owner: string,
  repo?: string,
): void {
  void context.webhooks.dispatch(event, action, payload, owner, repo);
}
