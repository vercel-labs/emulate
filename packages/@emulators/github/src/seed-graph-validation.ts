import type { GitHubSeedConfig } from "./index.js";

export interface ValidatedGitHubSeedPlan {
  config: GitHubSeedConfig;
  labels: GitHubSeedConfig["labels"];
  issues: Array<NonNullable<GitHubSeedConfig["issues"]>[number] & { repo: string }>;
  comments: GitHubSeedConfig["comments"];
  subIssues: Array<{ parent: string; child: string; position: number }>;
  dependencies: GitHubSeedConfig["dependencies"];
  canonicalRefs: Map<string, string>;
}

function requireReference(set: Set<string>, value: string, description: string): void {
  if (!set.has(value)) throw new Error(`GitHub seed references missing ${description}: ${value}`);
}

/** Validate the graph portion of a seed before the store is changed. */
export function normalizeGitHubSeedGraph(config: GitHubSeedConfig): GitHubSeedConfig {
  const edges = (config.sub_issues ?? []).map((edge) => ({ ...edge }));
  const byParent = new Map<string, typeof edges>();
  for (const edge of edges) {
    const group = byParent.get(edge.parent) ?? [];
    group.push(edge);
    byParent.set(edge.parent, group);
  }
  for (const group of byParent.values()) {
    const explicit = group.some((edge) => edge.position !== undefined);
    if (explicit && group.some((edge) => edge.position === undefined)) {
      throw new Error("Seed hierarchy positions must be specified for every sibling or omitted for every sibling");
    }
    if (!explicit) group.forEach((edge, index) => (edge.position = index));
  }
  return { ...config, sub_issues: edges };
}

export function validateGitHubSeedGraph(input: GitHubSeedConfig): ValidatedGitHubSeedPlan {
  const config = normalizeGitHubSeedGraph(input);
  const users = new Set(["ghost", "admin", ...(config.users ?? []).map((user) => user.login)]);
  const repos = new Set((config.repos ?? []).map((repo) => `${repo.owner}/${repo.name}`));
  const labels = new Set<string>();
  for (const label of [
    ...(config.labels ?? []),
    ...(config.repos ?? []).flatMap((repo) =>
      (repo.labels ?? []).map((entry) => ({ ...entry, repo: `${repo.owner}/${repo.name}` })),
    ),
  ]) {
    if (!repos.has(label.repo)) throw new Error(`GitHub seed references missing repository: ${label.repo}`);
    const key = `${label.repo}:${label.key}`;
    if (labels.has(key)) throw new Error(`Duplicate GitHub seed label key: ${label.key}`);
    labels.add(key);
  }

  const issues = [
    ...(config.issues ?? []),
    ...(config.repos ?? []).flatMap((repo) =>
      (repo.issues ?? []).map((issue) => ({ ...issue, repo: `${repo.owner}/${repo.name}` })),
    ),
  ].map((issue) => ({ ...issue, repo: issue.repo! }));
  const issueKeys = new Set<string>();
  const issueNumbers = new Map<string, Set<number>>();
  for (const issue of issues) {
    if (!issue.repo || !repos.has(issue.repo))
      throw new Error(`GitHub seed issue references missing repository: ${issue.repo}`);
    if (issueKeys.has(issue.key)) throw new Error(`Duplicate GitHub seed issue key: ${issue.key}`);
    issueKeys.add(issue.key);
    if (issue.number !== undefined) {
      if (!Number.isSafeInteger(issue.number) || issue.number < 1)
        throw new Error(`Invalid GitHub seed issue number: ${issue.number}`);
      const numbers = issueNumbers.get(issue.repo) ?? new Set<number>();
      if (numbers.has(issue.number))
        throw new Error(`Duplicate GitHub seed issue number: ${issue.repo}#${issue.number}`);
      numbers.add(issue.number);
      issueNumbers.set(issue.repo, numbers);
    }
    const state = issue.state ?? (issue.state_reason && issue.state_reason !== "reopened" ? "closed" : "open");
    if (issue.state_reason === "duplicate" && state !== "closed")
      throw new Error(`Duplicate seed issue must be closed: ${issue.key}`);
    if (state === "open" && issue.state_reason && issue.state_reason !== "reopened") {
      throw new Error(`Open seed issue has contradictory state_reason: ${issue.key}`);
    }
    if (state === "closed" && issue.state_reason === "reopened") {
      throw new Error(`Closed seed issue has contradictory state_reason: ${issue.key}`);
    }
    for (const label of issue.labels ?? [])
      requireReference(labels, `${issue.repo}:${label}`, `label for issue ${issue.key}`);
  }
  const issueByKey = new Map(issues.map((issue) => [issue.key, issue]));
  for (const issue of issues) {
    if (issue.duplicate_of) {
      const canonical = issueByKey.get(issue.duplicate_of);
      if (
        !canonical ||
        canonical.key === issue.key ||
        canonical.state_reason === "duplicate" ||
        canonical.repo !== issue.repo
      ) {
        throw new Error(`Invalid canonical duplicate target for seed issue "${issue.key}"`);
      }
      if (issue.state_reason !== "duplicate") {
        throw new Error(`Seed issue "${issue.key}" has duplicate_of without duplicate state_reason`);
      }
    }
    if (issue.state_reason === "duplicate" && !issue.duplicate_of) {
      throw new Error(`Duplicate seed issue "${issue.key}" requires duplicate_of`);
    }
    if (issue.author && !users.has(issue.author))
      throw new Error(`GitHub seed references missing user: ${issue.author}`);
  }

  const comments = [
    ...(config.comments ?? []),
    ...issues.flatMap((issue) =>
      (issue.comments ?? []).map((comment) => ({ ...comment, issue: issue.key, repo: issue.repo! })),
    ),
  ];
  const commentKeys = new Set<string>();
  for (const comment of comments) {
    if (commentKeys.has(comment.key)) throw new Error(`Duplicate GitHub seed comment key: ${comment.key}`);
    commentKeys.add(comment.key);
    if (!repos.has(comment.repo)) throw new Error(`GitHub seed references missing repository: ${comment.repo}`);
    if (typeof comment.issue === "string") {
      const issue = issueByKey.get(comment.issue);
      if (!issue || issue.repo !== comment.repo)
        throw new Error(`Seed comment "${comment.key}" references missing issue`);
    } else if (!issueNumbers.get(comment.repo)?.has(comment.issue)) {
      throw new Error(`Seed comment "${comment.key}" references missing issue number: ${comment.issue}`);
    }
    if (comment.author && !users.has(comment.author))
      throw new Error(`GitHub seed references missing user: ${comment.author}`);
  }

  const parentByChild = new Map<string, string>();
  for (const edge of config.sub_issues ?? []) {
    requireReference(issueKeys, edge.parent, "parent issue");
    requireReference(issueKeys, edge.child, "child issue");
    if (edge.parent === edge.child) throw new Error(`Self-referencing seed hierarchy: ${edge.parent}`);
    const parent = issueByKey.get(edge.parent)!;
    const child = issueByKey.get(edge.child)!;
    if (parent.repo!.split("/")[0] !== child.repo!.split("/")[0]) throw new Error("Seed hierarchy must share an owner");
    if (parentByChild.has(edge.child)) throw new Error(`Seed child issue already has a parent: ${edge.child}`);
    parentByChild.set(edge.child, edge.parent);
    if (edge.position !== undefined && (!Number.isSafeInteger(edge.position) || edge.position < 0)) {
      throw new Error(`Invalid seed hierarchy position: ${edge.position}`);
    }
    const seen = new Set<string>([edge.child]);
    let cursor: string | undefined = edge.parent;
    while (cursor) {
      if (seen.has(cursor)) throw new Error(`Cyclic seed parent-child graph at issue: ${cursor}`);
      seen.add(cursor);
      cursor = parentByChild.get(cursor);
    }
  }
  const positionsByParent = new Map<string, number[]>();
  for (const [index, edge] of (config.sub_issues ?? []).entries()) {
    const positions = positionsByParent.get(edge.parent) ?? [];
    positions.push(edge.position ?? index);
    positionsByParent.set(edge.parent, positions);
  }
  for (const positions of positionsByParent.values()) {
    positions.sort((a, b) => a - b);
    if (positions.some((position, index) => position !== index))
      throw new Error("Seed hierarchy positions must be contiguous");
  }

  const dependencies = new Set<string>();
  const dependencyGraph = new Map<string, string[]>();
  for (const edge of config.dependencies ?? []) {
    requireReference(issueKeys, edge.blocked, "blocked issue");
    requireReference(issueKeys, edge.blocking, "blocking issue");
    if (edge.blocked === edge.blocking) throw new Error(`Self-referencing seed dependency: ${edge.blocked}`);
    const key = `${edge.blocked}:${edge.blocking}`;
    if (dependencies.has(key)) throw new Error(`Duplicate seed dependency: ${key}`);
    dependencies.add(key);
    const next = dependencyGraph.get(edge.blocked) ?? [];
    next.push(edge.blocking);
    dependencyGraph.set(edge.blocked, next);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (issue: string): void => {
    if (visiting.has(issue)) throw new Error(`Cyclic seed dependency graph at issue: ${issue}`);
    if (visited.has(issue)) return;
    visiting.add(issue);
    for (const next of dependencyGraph.get(issue) ?? []) visit(next);
    visiting.delete(issue);
    visited.add(issue);
  };
  for (const issue of issueKeys) visit(issue);

  return {
    config,
    labels: config.labels,
    issues,
    comments,
    subIssues: (config.sub_issues ?? []).map((edge) => ({ ...edge, position: edge.position! })),
    dependencies: config.dependencies,
    canonicalRefs: new Map(issues.flatMap((issue) => (issue.duplicate_of ? [[issue.key, issue.duplicate_of]] : []))),
  };
}
