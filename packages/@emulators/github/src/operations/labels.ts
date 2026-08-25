import { ApiError } from "@emulators/core";
import type { GitHubLabel, GitHubIssue, GitHubRepo, GitHubUser } from "../entities.js";
import { formatLabel, formatRepo, formatUser, generateNodeId } from "../helpers.js";
import { ownerLoginOf } from "../route-helpers.js";
import type { GitHubStore } from "../store.js";
import { dispatchGitHubWebhook, type GitHubMutationContext } from "./common.js";

function randomLabelColor(): string {
  return Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0");
}

function normalizeColor(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new ApiError(422, "Validation failed");
  }
  const color = raw.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(color)) {
    throw new ApiError(422, "Validation failed");
  }
  return color.toLowerCase();
}

function insertLabel(
  gh: GitHubStore,
  repo: GitHubRepo,
  name: string,
  color: string,
  description: string | null,
): GitHubLabel {
  const row = gh.labels.insert({
    node_id: "",
    repo_id: repo.id,
    name,
    description,
    color,
    default: false,
  } as Omit<GitHubLabel, "id" | "created_at" | "updated_at">);
  gh.labels.update(row.id, { node_id: generateNodeId("Label", row.id) });
  return gh.labels.get(row.id)!;
}

/** Find a repository label by its exact, repository-scoped name. */
export function findRepositoryLabel(gh: GitHubStore, repo: GitHubRepo, name: string): GitHubLabel | undefined {
  return gh.labels.findBy("repo_id", repo.id).find((label) => label.name === name);
}

/** Create an issue attachment label without emitting a repository-label webhook. */
export function ensureIssueLabel(
  gh: GitHubStore,
  repo: GitHubRepo,
  name: string,
  missingColor: "default" | "random" = "default",
): GitHubLabel {
  return (
    findRepositoryLabel(gh, repo, name) ??
    insertLabel(gh, repo, name, missingColor === "random" ? randomLabelColor() : "ededed", null)
  );
}

export interface IssueLabelPlan {
  existingIds: number[];
  createNames: string[];
}

/** Validate issue label references without mutating the repository. */
export function planIssueLabelReferences(gh: GitHubStore, repo: GitHubRepo, raw: unknown): IssueLabelPlan {
  if (raw === undefined) return { existingIds: [], createNames: [] };
  if (!Array.isArray(raw)) throw new ApiError(422, "Validation failed");

  const existingIds: number[] = [];
  const createNames: string[] = [];
  const knownNames = new Set(gh.labels.findBy("repo_id", repo.id).map((label) => label.name));

  for (const item of raw) {
    if (typeof item === "number" && Number.isFinite(item)) {
      const label = gh.labels.get(item);
      if (!label || label.repo_id !== repo.id) throw new ApiError(422, "Validation failed");
      existingIds.push(item);
      continue;
    }

    if (typeof item === "string") {
      const existing = findRepositoryLabel(gh, repo, item);
      if (existing) {
        existingIds.push(existing.id);
        continue;
      }
      if (!knownNames.has(item)) {
        knownNames.add(item);
        createNames.push(item);
      }
      continue;
    }

    throw new ApiError(422, "Validation failed");
  }

  return { existingIds: [...new Set(existingIds)], createNames };
}

/** Materialize a previously validated issue label plan. */
export function applyIssueLabelPlan(gh: GitHubStore, repo: GitHubRepo, plan: IssueLabelPlan): number[] {
  const ids = [...plan.existingIds];
  for (const name of plan.createNames) {
    const label = ensureIssueLabel(gh, repo, name);
    if (!ids.includes(label.id)) ids.push(label.id);
  }
  return ids;
}

export interface CreateRepositoryLabelInput {
  repo: GitHubRepo;
  actor: GitHubUser;
  name: unknown;
  color?: unknown;
  description?: unknown;
}

export function createRepositoryLabel(context: GitHubMutationContext, input: CreateRepositoryLabelInput): GitHubLabel {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new ApiError(422, "Validation failed");
  if (findRepositoryLabel(context.gh, input.repo, name)) {
    throw new ApiError(422, "Validation failed");
  }

  const color = input.color !== undefined && input.color !== null ? normalizeColor(input.color) : randomLabelColor();
  const description =
    typeof input.description === "string" || input.description === null ? (input.description as string | null) : null;
  const label = insertLabel(context.gh, input.repo, name, color, description);

  const ownerLogin = ownerLoginOf(context.gh, input.repo);
  dispatchGitHubWebhook(
    context,
    "label",
    "created",
    {
      action: "created",
      label: formatLabel(label, input.repo, context.baseUrl),
      repository: formatRepo(input.repo, context.gh, context.baseUrl),
      sender: formatUser(input.actor, context.baseUrl),
    },
    ownerLogin,
    input.repo.name,
  );

  return label;
}

export interface DeleteRepositoryLabelInput {
  repo: GitHubRepo;
  actor: GitHubUser;
  name: string;
}

export function setIssueLabelIds(gh: GitHubStore, issue: GitHubIssue, labelIds: number[]): void {
  gh.issues.update(issue.id, { label_ids: labelIds });
  if (!issue.is_pull_request) return;
  const pull = gh.pullRequests.findBy("repo_id", issue.repo_id).find((candidate) => candidate.number === issue.number);
  if (pull) gh.pullRequests.update(pull.id, { label_ids: labelIds });
}

function removeLabelFromAllIssuesAndPulls(gh: GitHubStore, repoId: number, labelId: number): void {
  for (const issue of gh.issues.findBy("repo_id", repoId)) {
    if (!issue.label_ids.includes(labelId)) continue;
    setIssueLabelIds(
      gh,
      issue,
      issue.label_ids.filter((id) => id !== labelId),
    );
  }
}

export function deleteRepositoryLabel(context: GitHubMutationContext, input: DeleteRepositoryLabelInput): GitHubLabel {
  const label = findRepositoryLabel(context.gh, input.repo, input.name);
  if (!label) throw new ApiError(404, "Not Found");

  const payload = formatLabel(label, input.repo, context.baseUrl);
  removeLabelFromAllIssuesAndPulls(context.gh, input.repo.id, label.id);
  if (!context.gh.labels.delete(label.id)) throw new ApiError(404, "Not Found");

  const ownerLogin = ownerLoginOf(context.gh, input.repo);
  dispatchGitHubWebhook(
    context,
    "label",
    "deleted",
    {
      action: "deleted",
      label: payload,
      repository: formatRepo(input.repo, context.gh, context.baseUrl),
      sender: formatUser(input.actor, context.baseUrl),
    },
    ownerLogin,
    input.repo.name,
  );

  return label;
}
