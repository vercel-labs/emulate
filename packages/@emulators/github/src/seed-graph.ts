import type { Store } from "@emulators/core";
import type { GitHubIssue } from "./entities.js";
import type { GitHubSeedConfig } from "./index.js";
import { getGitHubStore } from "./store.js";
import { generateNodeId } from "./helpers.js";
import { normalizeGitHubSeedGraph } from "./seed-graph-validation.js";

export function materializeIssueGraph(store: Store, baseUrl: string, config: GitHubSeedConfig): void {
  config = normalizeGitHubSeedGraph(config);
  const gh = getGitHubStore(store);
  const nestedIssues = (config.repos ?? []).flatMap((repo) =>
    (repo.issues ?? []).map((issue) => ({ ...issue, repo: `${repo.owner}/${repo.name}` })),
  );
  const issueSpecs = [...(config.issues ?? []), ...nestedIssues];
  const issueByKey = new Map<string, GitHubIssue>();
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

  for (const spec of [
    ...(config.labels ?? []),
    ...(config.repos ?? []).flatMap((r) =>
      (r.labels ?? []).map((label) => ({ ...label, repo: `${r.owner}/${r.name}` })),
    ),
  ]) {
    const repo = resolveRepo(spec.repo);
    const key = `${repo.full_name}:${spec.key}`;
    if (labelByKey.has(key)) throw new Error(`Duplicate GitHub seed label key: ${spec.key}`);
    labelByKey.set(key, { id: -1 } as ReturnType<typeof gh.labels.insert>);
  }
  for (const spec of issueSpecs) {
    if (!spec.repo) throw new Error(`GitHub seed issue "${spec.key}" requires repo`);
    const repo = resolveRepo(spec.repo);
    if (issueByKey.has(spec.key)) throw new Error(`Duplicate GitHub seed issue key: ${spec.key}`);
    if (spec.number !== undefined && gh.issues.findOneBy("repo_id", repo.id)?.number === spec.number) {
      throw new Error(`Duplicate GitHub seed issue number: ${repo.full_name}#${spec.number}`);
    }
    const duplicateNumber =
      spec.number !== undefined && gh.issues.findBy("repo_id", repo.id).some((i) => i.number === spec.number);
    if (duplicateNumber) throw new Error(`Duplicate GitHub seed issue number: ${repo.full_name}#${spec.number}`);
    if (spec.number !== undefined) {
      const numbers = numbersByRepo.get(repo.id) ?? new Set<number>();
      if (numbers.has(spec.number))
        throw new Error(`Duplicate GitHub seed issue number: ${repo.full_name}#${spec.number}`);
      numbers.add(spec.number);
      numbersByRepo.set(repo.id, numbers);
    }
    issueByKey.set(spec.key, { id: -1 } as GitHubIssue);
  }
  const issueSpecByKey = new Map(issueSpecs.map((spec) => [spec.key, spec]));
  const commentSpecs = [
    ...(config.comments ?? []),
    ...issueSpecs.flatMap((issue) =>
      (issue.comments ?? []).map((comment) => ({ ...comment, repo: issue.repo!, issue: issue.key })),
    ),
  ];
  const commentKeys = new Set<string>();
  for (const spec of commentSpecs) {
    if (commentKeys.has(spec.key)) throw new Error(`Duplicate GitHub seed comment key: ${spec.key}`);
    commentKeys.add(spec.key);
    resolveRepo(spec.repo);
    if (typeof spec.issue === "string" && !issueSpecByKey.has(spec.issue)) {
      throw new Error(`Seed comment "${spec.key}" references missing issue`);
    }
    if (spec.author && !gh.users.findOneBy("login", spec.author)) {
      throw new Error(`GitHub seed references missing user: ${spec.author}`);
    }
  }
  for (const spec of issueSpecs) {
    if (spec.author && !gh.users.findOneBy("login", spec.author)) {
      throw new Error(`GitHub seed references missing user: ${spec.author}`);
    }
    if (spec.duplicate_of) {
      const canonical = issueSpecByKey.get(spec.duplicate_of);
      if (!canonical || canonical.key === spec.key || canonical.state_reason === "duplicate") {
        throw new Error(`Invalid canonical duplicate target for seed issue "${spec.key}"`);
      }
    }
    if (spec.state_reason === "duplicate" && !spec.duplicate_of) {
      throw new Error(`Duplicate seed issue "${spec.key}" requires duplicate_of`);
    }
    if (spec.state_reason !== "duplicate" && spec.duplicate_of) {
      throw new Error(`Seed issue "${spec.key}" has duplicate_of without duplicate state_reason`);
    }
    for (const labelKey of spec.labels ?? []) {
      const repo = resolveRepo(spec.repo);
      if (!labelByKey.has(`${repo.full_name}:${labelKey}`)) {
        throw new Error(`Seed issue "${spec.key}" references missing label: ${labelKey}`);
      }
    }
  }
  for (const edge of config.sub_issues ?? []) {
    if (!issueSpecByKey.has(edge.parent) || !issueSpecByKey.has(edge.child) || edge.parent === edge.child) {
      throw new Error(`Invalid seed parent-child edge: ${edge.parent} -> ${edge.child}`);
    }
  }
  const parentByChild = new Map<string, string>();
  for (const edge of config.sub_issues ?? []) {
    if (parentByChild.has(edge.child)) throw new Error(`Seed child issue already has a parent: ${edge.child}`);
    parentByChild.set(edge.child, edge.parent);
    const seen = new Set<string>([edge.child]);
    let cursor: string | undefined = edge.parent;
    while (cursor) {
      if (seen.has(cursor)) throw new Error(`Cyclic seed parent-child graph at issue: ${cursor}`);
      seen.add(cursor);
      cursor = parentByChild.get(cursor);
    }
  }
  for (const edge of config.dependencies ?? []) {
    if (!issueSpecByKey.has(edge.blocked) || !issueSpecByKey.has(edge.blocking) || edge.blocked === edge.blocking) {
      throw new Error(`Invalid seed dependency: ${edge.blocked} -> ${edge.blocking}`);
    }
  }
  const dependencyKeys = new Set<string>();
  for (const edge of config.dependencies ?? []) {
    const key = `${edge.blocked}:${edge.blocking}`;
    if (dependencyKeys.has(key)) throw new Error(`Duplicate seed dependency: ${key}`);
    dependencyKeys.add(key);
  }
  for (const spec of [
    ...(config.labels ?? []),
    ...(config.repos ?? []).flatMap((r) =>
      (r.labels ?? []).map((label) => ({ ...label, repo: `${r.owner}/${r.name}` })),
    ),
  ]) {
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
    const state = spec.state ?? (spec.state_reason && spec.state_reason !== "reopened" ? "closed" : "open");
    const reason = spec.state_reason ?? (state === "closed" ? "completed" : null);
    if (reason === "duplicate" && !spec.duplicate_of)
      throw new Error(`Duplicate seed issue "${spec.key}" requires duplicate_of`);
    if (reason !== "duplicate" && spec.duplicate_of)
      throw new Error(`Seed issue "${spec.key}" has duplicate_of without duplicate state_reason`);
    const number =
      spec.number ??
      Math.max(
        0,
        ...gh.issues.findBy("repo_id", repo.id).map((i) => i.number),
        ...issueSpecs.filter((i) => i.repo === repo.full_name && i.number !== undefined).map((i) => i.number!),
      ) + 1;
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
  }
  for (const spec of issueSpecs) {
    const issue = issueByKey.get(spec.key)!;
    const repo = gh.repos.get(issue.repo_id)!;
    const labelIds: number[] = [];
    if (spec.duplicate_of) {
      const canonical = issueByKey.get(spec.duplicate_of);
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
        : gh.issues.findBy("repo_id", repo.id).find((candidate) => candidate.number === spec.issue);
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
    gh.issues.update(issue.id, { comments: issue.comments + 1 });
  }
  for (const edge of config.sub_issues ?? []) {
    const parent = issueByKey.get(edge.parent);
    const child = issueByKey.get(edge.child);
    if (!parent || !child || parent.id === child.id)
      throw new Error(`Invalid seed parent-child edge: ${edge.parent} -> ${edge.child}`);
    if (gh.issueSubIssues.findOneBy("child_issue_id", child.id))
      throw new Error(`Seed child issue already has a parent: ${edge.child}`);
    gh.issueSubIssues.insert({ parent_issue_id: parent.id, child_issue_id: child.id, position: edge.position ?? 0 });
  }
  for (const edge of config.dependencies ?? []) {
    const blocked = issueByKey.get(edge.blocked);
    const blocking = issueByKey.get(edge.blocking);
    if (!blocked || !blocking || blocked.id === blocking.id)
      throw new Error(`Invalid seed dependency: ${edge.blocked} -> ${edge.blocking}`);
    if (
      gh.issueDependencies.findOneBy("blocked_issue_id", blocked.id) &&
      gh.issueDependencies.findOneBy("blocking_issue_id", blocking.id)
    )
      throw new Error("Duplicate seed dependency");
    gh.issueDependencies.insert({ blocked_issue_id: blocked.id, blocking_issue_id: blocking.id });
  }
}
