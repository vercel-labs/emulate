import type { Store } from "@emulators/core";
import type { GitHubIssue } from "./entities.js";
import type { ValidatedGitHubSeedPlan } from "./seed-graph-validation.js";
import { getGitHubStore } from "./store.js";
import { generateNodeId } from "./helpers.js";

export function materializeIssueGraph(store: Store, plan: ValidatedGitHubSeedPlan): void {
  const gh = getGitHubStore(store);
  const issueSpecs = plan.issues;
  const issueByKey = new Map<string, GitHubIssue>();
  const issueByRepoNumber = new Map<string, GitHubIssue>();
  const labelByKey = new Map<string, ReturnType<typeof gh.labels.insert>>();
  const numbersByRepo = new Map<number, Set<number>>();
  const resolveRepo = (name: string | undefined) => {
    const repo = name ? gh.repos.findOneBy("full_name", name) : undefined;
    if (!repo) throw new Error(`GitHub seed references missing repository: ${name ?? "<missing>"}`);
    return repo;
  };
  const author = (login?: string) => {
    const user = gh.users.findOneBy("login", login ?? "ghost");
    if (!user) throw new Error(`GitHub seed references missing user: ${login}`);
    return user;
  };

  for (const spec of issueSpecs) issueByKey.set(spec.key, { id: -1 } as GitHubIssue);
  const commentSpecs = plan.comments ?? [];
  for (const spec of plan.labels) {
    const repo = resolveRepo(spec.repo);
    const inserted = gh.labels.insert({
      node_id: "",
      repo_id: repo.id,
      name: spec.name ?? spec.key,
      description: spec.description ?? null,
      color: spec.color ?? "ededed",
      default: spec.default ?? false,
    });
    gh.labels.update(inserted.id, { node_id: generateNodeId("Label", inserted.id) });
    labelByKey.set(`${repo.full_name}:${spec.key}`, inserted);
  }
  for (const spec of issueSpecs) {
    const repo = resolveRepo(spec.repo);
    const numbers =
      numbersByRepo.get(repo.id) ?? new Set(gh.issues.findBy("repo_id", repo.id).map((issue) => issue.number));
    if (spec.number !== undefined && numbers.has(spec.number))
      throw new Error(`Duplicate GitHub seed issue number: ${repo.full_name}#${spec.number}`);
    const state = spec.state ?? (spec.state_reason && spec.state_reason !== "reopened" ? "closed" : "open");
    const reason = spec.state_reason ?? (state === "closed" ? "completed" : null);
    const number = spec.number ?? Math.max(0, ...numbers) + 1;
    numbers.add(number);
    numbersByRepo.set(repo.id, numbers);
    const created = new Date(0).toISOString();
    const inserted = gh.issues.insert({
      node_id: "",
      number,
      repo_id: repo.id,
      title: spec.title,
      body: spec.body ?? null,
      state,
      state_reason: reason,
      duplicate_issue_id: null,
      locked: false,
      active_lock_reason: null,
      user_id: author(spec.author).id,
      assignee_ids: [],
      label_ids: [],
      milestone_id: null,
      comments: 0,
      closed_at: state === "closed" ? created : null,
      closed_by_id: state === "closed" ? author(spec.author).id : null,
      is_pull_request: false,
    });
    gh.issues.update(inserted.id, { node_id: generateNodeId("Issue", inserted.id) });
    issueByKey.set(spec.key, inserted);
    issueByRepoNumber.set(`${repo.full_name}:${number}`, inserted);
    if (state === "open") {
      const currentRepo = gh.repos.get(repo.id);
      if (currentRepo) gh.repos.update(repo.id, { open_issues_count: currentRepo.open_issues_count + 1 });
    }
  }
  for (const spec of issueSpecs) {
    const issue = issueByKey.get(spec.key)!;
    const repo = gh.repos.get(issue.repo_id)!;
    const labelIds: number[] = [];
    if (plan.canonicalRefs.has(spec.key)) {
      const canonical = issueByKey.get(plan.canonicalRefs.get(spec.key)!);
      if (!canonical || canonical.id === issue.id || canonical.duplicate_issue_id !== null)
        throw new Error(`Invalid canonical duplicate target for seed issue "${spec.key}"`);
      issue.duplicate_issue_id = canonical.id;
      gh.issues.update(issue.id, { duplicate_issue_id: canonical.id });
    }
    for (const labelKey of spec.labels ?? []) {
      const label = labelByKey.get(`${repo.full_name}:${labelKey}`);
      if (!label || label.id === -1) throw new Error(`Seed issue "${spec.key}" references missing label: ${labelKey}`);
      labelIds.push(label.id);
    }
    if (labelIds.length > 0) gh.issues.update(issue.id, { label_ids: labelIds });
  }
  for (const spec of commentSpecs) {
    const repo = resolveRepo(spec.repo);
    const issue =
      typeof spec.issue === "string"
        ? issueByKey.get(spec.issue)
        : issueByRepoNumber.get(`${repo.full_name}:${spec.issue}`);
    if (!issue || issue.repo_id !== repo.id) throw new Error(`Seed comment "${spec.key}" references missing issue`);
    const row = gh.comments.insert({
      node_id: "",
      repo_id: repo.id,
      issue_number: issue.number,
      pull_number: null,
      commit_sha: null,
      body: spec.body,
      user_id: author(spec.author).id,
      in_reply_to_id: null,
      path: null,
      position: null,
      line: null,
      side: null,
      subject_type: null,
      comment_type: "issue",
      review_id: null,
    });
    gh.comments.update(row.id, { node_id: generateNodeId("IssueComment", row.id) });
    const currentIssue = gh.issues.get(issue.id);
    if (!currentIssue) throw new Error(`Seed comment references missing issue: ${spec.issue}`);
    gh.issues.update(issue.id, { comments: currentIssue.comments + 1 });
  }
  for (const edge of plan.subIssues) {
    const parent = issueByKey.get(edge.parent);
    const child = issueByKey.get(edge.child);
    if (!parent || !child || parent.id === child.id)
      throw new Error(`Invalid seed parent-child edge: ${edge.parent} -> ${edge.child}`);
    if (gh.issueSubIssues.findOneBy("child_issue_id", child.id))
      throw new Error(`Seed child issue already has a parent: ${edge.child}`);
    gh.issueSubIssues.insert({ parent_issue_id: parent.id, child_issue_id: child.id, position: edge.position });
  }
  for (const edge of plan.dependencies ?? []) {
    const blocked = issueByKey.get(edge.blocked);
    const blocking = issueByKey.get(edge.blocking);
    if (!blocked || !blocking || blocked.id === blocking.id)
      throw new Error(`Invalid seed dependency: ${edge.blocked} -> ${edge.blocking}`);
    if (
      gh.issueDependencies.findBy("blocked_issue_id", blocked.id).some((row) => row.blocking_issue_id === blocking.id)
    )
      throw new Error("Duplicate seed dependency");
    gh.issueDependencies.insert({ blocked_issue_id: blocked.id, blocking_issue_id: blocking.id });
  }
}
