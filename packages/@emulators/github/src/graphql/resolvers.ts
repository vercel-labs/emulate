import type {
  GitHubCheckRun,
  GitHubComment,
  GitHubCommit,
  GitHubIssue,
  GitHubLabel,
  GitHubMilestone,
  GitHubOrg,
  GitHubPullRequest,
  GitHubRepo,
  GitHubReview,
  GitHubTeam,
  GitHubUser,
} from "../entities.js";
import { computeAuthorAssociation, generateNodeId, lookupRepo } from "../helpers.js";
import { diffTrees, findCommitBySha, listAncestors } from "../git-helpers.js";
import { assertAuthenticatedActor, hasRepoAdmin, hasRepoContentsWrite, ownerLoginOf } from "../route-helpers.js";
import { checkMergeRequirements } from "../routes/pulls.js";
import { issuePrMatchesFilters, parseSearchQuery } from "../routes/search.js";
import { connectionFromArray, type ConnectionArgs } from "./connection.js";
import { GitHubGraphQLError, canSeeRepo, decodeNodeId, notFound, type GraphQLContext } from "./context.js";

type Args = Record<string, any>;
type View = Record<string, unknown>;

function upper<T extends string>(value: T): Uppercase<T> {
  return value.toUpperCase() as Uppercase<T>;
}

function byOrder<T extends { created_at: string; updated_at: string; id: number }>(
  items: T[],
  order: { field?: string; direction?: string } | undefined,
  commentCount?: (item: T) => number,
): T[] {
  const mul = order?.direction === "DESC" ? -1 : 1;
  const key = (item: T): string | number => {
    if (order?.field === "UPDATED_AT") return item.updated_at;
    if (order?.field === "COMMENTS" && commentCount) return commentCount(item);
    return item.created_at;
  };
  return [...items].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka < kb) return -mul;
    if (ka > kb) return mul;
    return (a.id - b.id) * mul;
  });
}

function repoUrl(ctx: GraphQLContext, repo: GitHubRepo): string {
  return `${ctx.baseUrl}/${repo.full_name}`;
}

function prState(pr: GitHubPullRequest): "OPEN" | "CLOSED" | "MERGED" {
  if (pr.merged) return "MERGED";
  return pr.state === "open" ? "OPEN" : "CLOSED";
}

function users(ctx: GraphQLContext, ids: number[]): GitHubUser[] {
  return ids.map((id) => ctx.gh.users.get(id)).filter((u): u is GitHubUser => u !== undefined);
}

export function actorView(ctx: GraphQLContext, user: GitHubUser | undefined | null): View | null {
  if (!user) return null;
  const url = `${ctx.baseUrl}/${user.login}`;
  return {
    __typename: user.type === "Bot" ? "Bot" : "User",
    id: user.node_id,
    databaseId: user.id,
    login: user.login,
    name: user.name,
    email: user.email ?? "",
    bio: user.bio,
    company: user.company,
    location: user.location,
    isSiteAdmin: user.site_admin,
    isViewer: ctx.viewer?.id === user.id,
    avatarUrl: () => user.avatar_url,
    url,
    resourcePath: `/${user.login}`,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
    organizations: (args: ConnectionArgs) => {
      const orgIds = new Set(
        ctx.gh.teamMembers
          .findBy("user_id", user.id)
          .map((m) => ctx.gh.teams.get(m.team_id)?.org_id)
          .filter((id): id is number => id !== undefined),
      );
      const orgs = [...orgIds].map((id) => ctx.gh.orgs.get(id)).filter((o): o is GitHubOrg => o !== undefined);
      return connectionFromArray(
        orgs.map((o) => orgView(ctx, o)),
        args,
      );
    },
    repository: ({ name }: Args) => repositoryByName(ctx, user.login, name),
  };
}

function orgView(ctx: GraphQLContext, org: GitHubOrg): View {
  return {
    __typename: "Organization",
    id: org.node_id,
    databaseId: org.id,
    login: org.login,
    name: org.name,
    email: org.email,
    description: org.description,
    avatarUrl: () => `${ctx.baseUrl}/avatars/u/${org.login}`,
    url: `${ctx.baseUrl}/${org.login}`,
    resourcePath: `/${org.login}`,
    createdAt: org.created_at,
    updatedAt: org.updated_at,
    repository: ({ name }: Args) => repositoryByName(ctx, org.login, name),
  };
}

function teamView(ctx: GraphQLContext, team: GitHubTeam): View {
  const org = ctx.gh.orgs.get(team.org_id);
  return {
    __typename: "Team",
    id: team.node_id,
    databaseId: team.id,
    name: team.name,
    slug: team.slug,
    url: `${ctx.baseUrl}/orgs/${org?.login ?? "unknown"}/teams/${team.slug}`,
    organization: org ? orgView(ctx, org) : null,
  };
}

function ownerView(ctx: GraphQLContext, repo: GitHubRepo): View | null {
  if (repo.owner_type === "User") return actorView(ctx, ctx.gh.users.get(repo.owner_id));
  const org = ctx.gh.orgs.get(repo.owner_id);
  return org ? orgView(ctx, org) : null;
}

function repositoryByName(ctx: GraphQLContext, owner: string, name: string): View | null {
  const repo = lookupRepo(ctx.gh, owner, name);
  return canSeeRepo(ctx, repo) ? repoView(ctx, repo) : null;
}

function labelView(ctx: GraphQLContext, repo: GitHubRepo, label: GitHubLabel): View {
  return {
    id: label.node_id,
    name: label.name,
    color: label.color,
    description: label.description,
    isDefault: label.default,
    url: `${repoUrl(ctx, repo)}/labels/${encodeURIComponent(label.name)}`,
  };
}

function milestoneView(ctx: GraphQLContext, repo: GitHubRepo, milestone: GitHubMilestone): View {
  return {
    id: milestone.node_id,
    number: milestone.number,
    title: milestone.title,
    description: milestone.description,
    dueOn: milestone.due_on,
    state: upper(milestone.state),
    url: `${repoUrl(ctx, repo)}/milestone/${milestone.number}`,
  };
}

function labelsConnection(ctx: GraphQLContext, repo: GitHubRepo, labelIds: number[], args: Args) {
  let labels = labelIds.map((id) => ctx.gh.labels.get(id)).filter((l): l is GitHubLabel => l !== undefined);
  if (args.orderBy?.field === "NAME") {
    labels = [...labels].sort((a, b) => a.name.localeCompare(b.name));
    if (args.orderBy.direction === "DESC") labels.reverse();
  } else {
    labels = byOrder(labels, args.orderBy);
  }
  return connectionFromArray(
    labels.map((l) => labelView(ctx, repo, l)),
    args,
  );
}

function gitActorView(ctx: GraphQLContext, name: string, email: string, date: string, userId: number | null) {
  return {
    name,
    email,
    date,
    user: () => actorView(ctx, userId !== null ? ctx.gh.users.get(userId) : undefined),
  };
}

function commitView(ctx: GraphQLContext, repo: GitHubRepo, commit: GitHubCommit): View {
  const [headline, ...rest] = commit.message.split("\n");
  const author = gitActorView(ctx, commit.author_name, commit.author_email, commit.author_date, commit.user_id);
  return {
    __typename: "Commit",
    id: commit.node_id,
    oid: commit.sha,
    abbreviatedOid: commit.sha.slice(0, 7),
    message: commit.message,
    messageHeadline: headline,
    messageBody: rest.join("\n").replace(/^\n+/, ""),
    authoredDate: commit.author_date,
    committedDate: commit.committer_date,
    author,
    committer: gitActorView(ctx, commit.committer_name, commit.committer_email, commit.committer_date, commit.user_id),
    authors: (args: ConnectionArgs) => connectionFromArray([author], args),
    url: `${repoUrl(ctx, repo)}/commit/${commit.sha}`,
    statusCheckRollup: () => statusCheckRollupView(ctx, repo, commit),
  };
}

function commitBySha(ctx: GraphQLContext, repo: GitHubRepo, sha: string | null): View | null {
  if (!sha) return null;
  const commit = findCommitBySha(ctx.gh, repo.id, sha);
  return commit ? commitView(ctx, repo, commit) : null;
}

function requiredCheckNames(ctx: GraphQLContext, repo: GitHubRepo, branch: string): string[] {
  const rule = ctx.gh.branchProtections.findBy("repo_id", repo.id).find((p) => p.branch_name === branch);
  return rule?.required_status_checks?.contexts ?? [];
}

function checkRunView(ctx: GraphQLContext, repo: GitHubRepo, run: GitHubCheckRun): View {
  const url = `${repoUrl(ctx, repo)}/runs/${run.id}`;
  return {
    __typename: "CheckRun",
    id: run.node_id,
    databaseId: run.id,
    name: run.name,
    status: upper(run.status),
    conclusion: run.conclusion ? upper(run.conclusion) : null,
    startedAt: run.started_at,
    completedAt: run.completed_at,
    detailsUrl: run.details_url ?? url,
    title: run.output.title,
    url,
    permalink: url,
    checkSuite: { id: generateNodeId("CheckSuite", run.check_suite_id ?? run.id), workflowRun: null },
    isRequired: ({ pullRequestId, pullRequestNumber }: Args) => {
      const pr = pullRequestId
        ? pullRequestFromNodeId(ctx, pullRequestId)
        : ctx.gh.pullRequests.findBy("repo_id", repo.id).find((p) => p.number === pullRequestNumber);
      return pr ? requiredCheckNames(ctx, repo, pr.base_ref).includes(run.name) : false;
    },
  };
}

const FAILING = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);

function rollupState(runs: GitHubCheckRun[]): "SUCCESS" | "FAILURE" | "PENDING" {
  if (runs.some((r) => r.status === "completed" && r.conclusion !== null && FAILING.has(r.conclusion))) {
    return "FAILURE";
  }
  if (runs.some((r) => r.status !== "completed")) return "PENDING";
  return "SUCCESS";
}

function latestCheckRuns(ctx: GraphQLContext, repo: GitHubRepo, sha: string): GitHubCheckRun[] {
  const latest = new Map<string, GitHubCheckRun>();
  for (const run of ctx.gh.checkRuns.findBy("repo_id", repo.id)) {
    if (run.head_sha !== sha) continue;
    const prev = latest.get(run.name);
    if (!prev || prev.id < run.id) latest.set(run.name, run);
  }
  return [...latest.values()].sort((a, b) => a.id - b.id);
}

function statusCheckRollupView(ctx: GraphQLContext, repo: GitHubRepo, commit: GitHubCommit): View | null {
  const runs = latestCheckRuns(ctx, repo, commit.sha);
  if (runs.length === 0) return null;
  const countsByState = new Map<string, number>();
  for (const run of runs) {
    const state = upper(run.conclusion ?? run.status);
    countsByState.set(state, (countsByState.get(state) ?? 0) + 1);
  }
  return {
    id: generateNodeId("StatusCheckRollup", commit.id),
    state: rollupState(runs),
    commit: () => commitView(ctx, repo, commit),
    contexts: (args: ConnectionArgs) =>
      connectionFromArray(
        runs.map((r) => checkRunView(ctx, repo, r)),
        args,
        {
          checkRunCount: runs.length,
          checkRunCountsByState: [...countsByState].map(([state, count]) => ({ state, count })),
          statusContextCount: 0,
          statusContextCountsByState: [],
        },
      ),
  };
}

function branchProtectionView(ctx: GraphQLContext, repo: GitHubRepo, branch: string): View | null {
  const rule = ctx.gh.branchProtections.findBy("repo_id", repo.id).find((p) => p.branch_name === branch);
  if (!rule) return null;
  const reviews = rule.required_pull_request_reviews;
  const checks = rule.required_status_checks;
  return {
    id: generateNodeId("BranchProtectionRule", rule.id),
    pattern: rule.branch_name,
    requiresApprovingReviews: reviews !== null,
    requiredApprovingReviewCount: reviews?.required_approving_review_count ?? null,
    requiresStatusChecks: checks !== null,
    requiresStrictStatusChecks: checks?.strict ?? false,
    requiredStatusCheckContexts: checks?.contexts ?? [],
  };
}

function refView(ctx: GraphQLContext, repo: GitHubRepo, branchName: string): View | null {
  const branch = ctx.gh.branches.findBy("repo_id", repo.id).find((b) => b.name === branchName);
  if (!branch) return null;
  const ref = ctx.gh.refs.findBy("repo_id", repo.id).find((r) => r.ref === `refs/heads/${branchName}`);
  return {
    id: ref?.node_id ?? generateNodeId("Ref", branch.id),
    name: branch.name,
    prefix: "refs/heads/",
    repository: () => repoView(ctx, repo),
    target: () => commitBySha(ctx, repo, branch.sha),
    branchProtectionRule: () => branchProtectionView(ctx, repo, branch.name),
  };
}

function viewerPermission(ctx: GraphQLContext, repo: GitHubRepo): string | null {
  const viewer = ctx.viewer;
  if (!viewer) return repo.private ? null : "READ";
  if (hasRepoAdmin(ctx.gh, viewer, repo)) return "ADMIN";
  const collab = ctx.gh.collaborators.findBy("repo_id", repo.id).find((c) => c.user_id === viewer.id);
  if (collab?.permission === "maintain") return "MAINTAIN";
  if (collab?.permission === "triage") return "TRIAGE";
  if (hasRepoContentsWrite(ctx.gh, viewer, repo)) return "WRITE";
  return "READ";
}

function repoMembers(ctx: GraphQLContext, repo: GitHubRepo): GitHubUser[] {
  const ids = new Set<number>();
  if (repo.owner_type === "User") ids.add(repo.owner_id);
  else {
    for (const team of ctx.gh.teams.findBy("org_id", repo.owner_id)) {
      for (const m of ctx.gh.teamMembers.findBy("team_id", team.id)) ids.add(m.user_id);
    }
  }
  for (const c of ctx.gh.collaborators.findBy("repo_id", repo.id)) ids.add(c.user_id);
  return users(ctx, [...ids]).sort((a, b) => a.login.localeCompare(b.login));
}

function assigneesConnection(ctx: GraphQLContext, ids: number[], args: ConnectionArgs) {
  return connectionFromArray(
    users(ctx, ids).map((u) => actorView(ctx, u)),
    args,
  );
}

function usersConnection(ctx: GraphQLContext, list: GitHubUser[], args: Args) {
  const q = typeof args.query === "string" ? args.query.toLowerCase() : "";
  const filtered = q
    ? list.filter((u) => u.login.toLowerCase().includes(q) || (u.name ?? "").toLowerCase().includes(q))
    : list;
  return connectionFromArray(
    filtered.map((u) => actorView(ctx, u)),
    args,
  );
}

export function repoView(ctx: GraphQLContext, repo: GitHubRepo): View {
  const host = new URL(ctx.baseUrl).host;
  const pulls = () => ctx.gh.pullRequests.findBy("repo_id", repo.id);
  return {
    __typename: "Repository",
    id: repo.node_id,
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.full_name,
    description: repo.description,
    homepageUrl: repo.homepage,
    url: repoUrl(ctx, repo),
    resourcePath: `/${repo.full_name}`,
    sshUrl: `git@${host}:${repo.full_name}.git`,
    createdAt: repo.created_at,
    updatedAt: repo.updated_at,
    pushedAt: repo.pushed_at,
    isPrivate: repo.private,
    visibility: upper(repo.visibility),
    isArchived: repo.archived,
    isFork: repo.fork,
    isTemplate: repo.is_template,
    isEmpty: () => ctx.gh.branches.findBy("repo_id", repo.id).length === 0,
    isInOrganization: repo.owner_type === "Organization",
    hasIssuesEnabled: repo.has_issues,
    hasWikiEnabled: repo.has_wiki,
    hasProjectsEnabled: repo.has_projects,
    hasDiscussionsEnabled: repo.has_discussions,
    forkCount: repo.forks_count,
    stargazerCount: repo.stargazers_count,
    mergeCommitAllowed: repo.allow_merge_commit,
    squashMergeAllowed: repo.allow_squash_merge,
    rebaseMergeAllowed: repo.allow_rebase_merge,
    autoMergeAllowed: repo.allow_auto_merge,
    deleteBranchOnMerge: repo.delete_branch_on_merge,
    viewerDefaultMergeMethod: repo.allow_merge_commit ? "MERGE" : repo.allow_squash_merge ? "SQUASH" : "REBASE",
    viewerPermission: () => viewerPermission(ctx, repo),
    viewerCanAdminister: () => viewerPermission(ctx, repo) === "ADMIN",
    owner: () => ownerView(ctx, repo),
    parent: () => {
      const parent = repo.forked_from_id !== null ? ctx.gh.repos.get(repo.forked_from_id) : undefined;
      return canSeeRepo(ctx, parent) ? repoView(ctx, parent) : null;
    },
    defaultBranchRef: () => refView(ctx, repo, repo.default_branch),
    ref: ({ qualifiedName }: Args) => refView(ctx, repo, String(qualifiedName).replace(/^refs\/heads\//, "")),
    pullRequestTemplates: [],
    assignableUsers: (args: Args) => usersConnection(ctx, repoMembers(ctx, repo), args),
    mentionableUsers: (args: Args) => usersConnection(ctx, repoMembers(ctx, repo), args),
    label: ({ name }: Args) => {
      const label = ctx.gh.labels.findBy("repo_id", repo.id).find((l) => l.name === name);
      return label ? labelView(ctx, repo, label) : null;
    },
    labels: (args: Args) => {
      const q = typeof args.query === "string" ? args.query.toLowerCase() : "";
      const ids = ctx.gh.labels
        .findBy("repo_id", repo.id)
        .filter((l) => !q || l.name.toLowerCase().includes(q))
        .map((l) => l.id);
      return labelsConnection(ctx, repo, ids, args);
    },
    milestone: ({ number }: Args) => {
      const m = ctx.gh.milestones.findBy("repo_id", repo.id).find((x) => x.number === number);
      return m ? milestoneView(ctx, repo, m) : null;
    },
    milestones: (args: Args) => {
      const states: string[] | undefined = args.states;
      const list = ctx.gh.milestones
        .findBy("repo_id", repo.id)
        .filter((m) => !states?.length || states.includes(upper(m.state)));
      return connectionFromArray(
        byOrder(list, args.orderBy).map((m) => milestoneView(ctx, repo, m)),
        args,
      );
    },
    pullRequest: ({ number }: Args) => {
      const pr = pulls().find((p) => p.number === number);
      if (!pr) throw notFound(`Could not resolve to a PullRequest with the number of ${number}.`);
      return prView(ctx, pr);
    },
    pullRequests: (args: Args) => {
      const states: string[] | undefined = args.states;
      const labels: string[] | undefined = args.labels;
      const list = pulls().filter((pr) => {
        if (states?.length && !states.includes(prState(pr))) return false;
        if (args.headRefName && pr.head_ref !== args.headRefName) return false;
        if (args.baseRefName && pr.base_ref !== args.baseRefName) return false;
        if (labels?.length) {
          const names = pr.label_ids.map((id) => ctx.gh.labels.get(id)?.name);
          if (!labels.every((name) => names.includes(name))) return false;
        }
        return true;
      });
      return connectionFromArray(
        byOrder(list, args.orderBy, (pr) => pr.comments).map((pr) => prView(ctx, pr)),
        args,
      );
    },
  };
}

function visibleReviews(ctx: GraphQLContext, pr: GitHubPullRequest): GitHubReview[] {
  return ctx.gh.reviews
    .findBy("repo_id", pr.repo_id)
    .filter((r) => r.pull_number === pr.number && (r.state !== "PENDING" || r.user_id === ctx.viewer?.id))
    .sort((a, b) => a.id - b.id);
}

function latestReviewsByAuthor(reviews: GitHubReview[]): GitHubReview[] {
  const latest = new Map<number, GitHubReview>();
  for (const r of reviews) {
    if (r.state === "PENDING") continue;
    const prev = latest.get(r.user_id);
    const opinionated = r.state !== "COMMENTED";
    if (!prev || opinionated || prev.state === "COMMENTED") latest.set(r.user_id, r);
  }
  return [...latest.values()].sort((a, b) => a.id - b.id);
}

function reviewDecision(ctx: GraphQLContext, pr: GitHubPullRequest): string | null {
  const latest = latestReviewsByAuthor(visibleReviews(ctx, pr)).map((r) => r.state);
  if (latest.includes("CHANGES_REQUESTED")) return "CHANGES_REQUESTED";
  const rule = ctx.gh.branchProtections.findBy("repo_id", pr.base_repo_id).find((p) => p.branch_name === pr.base_ref);
  const required = rule?.required_pull_request_reviews?.required_approving_review_count ?? 0;
  const approvals = latest.filter((s) => s === "APPROVED").length;
  if (required > 0) return approvals >= required ? "APPROVED" : "REVIEW_REQUIRED";
  return approvals > 0 ? "APPROVED" : null;
}

function reviewView(ctx: GraphQLContext, review: GitHubReview): View | null {
  const repo = ctx.gh.repos.get(review.repo_id);
  const pr = repo && ctx.gh.pullRequests.findBy("repo_id", repo.id).find((p) => p.number === review.pull_number);
  if (!repo || !pr) return null;
  const resourcePath = `/${repo.full_name}/pull/${pr.number}#pullrequestreview-${review.id}`;
  return {
    __typename: "PullRequestReview",
    id: review.node_id,
    databaseId: review.id,
    body: review.body ?? "",
    state: review.state,
    submittedAt: review.submitted_at,
    createdAt: review.created_at,
    updatedAt: review.updated_at,
    author: () => actorView(ctx, ctx.gh.users.get(review.user_id)),
    authorAssociation: computeAuthorAssociation(ctx.gh, review.user_id, repo.id),
    commit: () => commitBySha(ctx, repo, review.commit_id),
    includesCreatedEdit: false,
    isMinimized: false,
    minimizedReason: null,
    reactionGroups: [],
    viewerDidAuthor: ctx.viewer?.id === review.user_id,
    url: `${ctx.baseUrl}${resourcePath}`,
    resourcePath,
    repository: () => repoView(ctx, repo),
    pullRequest: () => prView(ctx, pr),
  };
}

function commentView(ctx: GraphQLContext, comment: GitHubComment): View | null {
  const repo = ctx.gh.repos.get(comment.repo_id);
  if (!repo || comment.comment_type !== "issue" || comment.issue_number === null) return null;
  const number = comment.issue_number;
  const pr = ctx.gh.pullRequests.findBy("repo_id", repo.id).find((p) => p.number === number);
  const issue = ctx.gh.issues.findBy("repo_id", repo.id).find((i) => i.number === number);
  const url = `${repoUrl(ctx, repo)}/${pr ? "pull" : "issues"}/${number}#issuecomment-${comment.id}`;
  return {
    __typename: "IssueComment",
    id: comment.node_id,
    databaseId: comment.id,
    body: comment.body,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    author: () => actorView(ctx, ctx.gh.users.get(comment.user_id)),
    authorAssociation: computeAuthorAssociation(ctx.gh, comment.user_id, repo.id),
    includesCreatedEdit: comment.updated_at !== comment.created_at,
    isMinimized: false,
    minimizedReason: null,
    reactionGroups: [],
    viewerDidAuthor: ctx.viewer?.id === comment.user_id,
    url,
    resourcePath: `/${repo.full_name}/${pr ? "pull" : "issues"}/${number}#issuecomment-${comment.id}`,
    repository: () => repoView(ctx, repo),
    issue: () => (issue ? issueView(ctx, issue) : null),
    pullRequest: () => (pr ? prView(ctx, pr) : null),
  };
}

function issueView(ctx: GraphQLContext, issue: GitHubIssue): View | null {
  const repo = ctx.gh.repos.get(issue.repo_id);
  if (!repo) return null;
  return {
    __typename: "Issue",
    id: issue.node_id,
    number: issue.number,
    title: issue.title,
    state: upper(issue.state),
    url: `${repoUrl(ctx, repo)}/issues/${issue.number}`,
    resourcePath: `/${repo.full_name}/issues/${issue.number}`,
    repository: () => repoView(ctx, repo),
    labels: (args: Args) => labelsConnection(ctx, repo, issue.label_ids, args),
    assignedActors: (args: ConnectionArgs) => assigneesConnection(ctx, issue.assignee_ids, args),
  };
}

interface PullRequestDiff {
  commits: GitHubCommit[];
  files: Array<{ path: string; additions: number; deletions: number; changeType: string }>;
}

const CHANGE_TYPES = { added: "ADDED", removed: "DELETED", modified: "MODIFIED", renamed: "RENAMED" } as const;

function pullRequestDiff(ctx: GraphQLContext, pr: GitHubPullRequest): PullRequestDiff {
  const headRepo = ctx.gh.repos.get(pr.head_repo_id);
  if (!headRepo) return { commits: [], files: [] };
  const baseAncestors = new Set(listAncestors(ctx.gh, pr.base_repo_id, pr.base_sha).map((c) => c.sha));
  const headAncestors = listAncestors(ctx.gh, headRepo.id, pr.head_sha);
  const own = headAncestors.filter((c) => !baseAncestors.has(c.sha));
  const head = headAncestors[0];
  const commits = own.length > 0 ? own.reverse() : head ? [head] : [];
  if (!head || pr.head_repo_id !== pr.base_repo_id) return { commits, files: [] };
  const mergeBase = headAncestors.find((c) => baseAncestors.has(c.sha));
  const files = diffTrees(ctx.gh, headRepo.id, mergeBase?.tree_sha ?? null, head.tree_sha).map((f) => ({
    path: f.filename,
    additions: f.additions,
    deletions: f.deletions,
    changeType: CHANGE_TYPES[f.status],
  }));
  return { commits, files };
}

function mergeStateStatus(ctx: GraphQLContext, pr: GitHubPullRequest): string {
  if (pr.state !== "open") return "UNKNOWN";
  if (pr.draft) return "DRAFT";
  if (pr.mergeable === false) return "DIRTY";
  try {
    checkMergeRequirements(ctx.gh, pr);
  } catch {
    return "BLOCKED";
  }
  const repo = ctx.gh.repos.get(pr.base_repo_id);
  if (repo && rollupState(latestCheckRuns(ctx, repo, pr.head_sha)) !== "SUCCESS") return "UNSTABLE";
  return "CLEAN";
}

export function prView(ctx: GraphQLContext, pr: GitHubPullRequest): View | null {
  const repo = ctx.gh.repos.get(pr.repo_id);
  if (!repo) return null;
  const headRepo = ctx.gh.repos.get(pr.head_repo_id);
  let diff: PullRequestDiff | undefined;
  const getDiff = () => (diff ??= pullRequestDiff(ctx, pr));
  const url = `${repoUrl(ctx, repo)}/pull/${pr.number}`;
  const comments = () =>
    ctx.gh.comments
      .findBy("repo_id", repo.id)
      .filter((c) => c.comment_type === "issue" && c.issue_number === pr.number);

  return {
    __typename: "PullRequest",
    id: pr.node_id,
    databaseId: pr.id,
    fullDatabaseId: String(pr.id),
    number: pr.number,
    title: pr.title,
    body: pr.body ?? "",
    bodyText: pr.body ?? "",
    state: prState(pr),
    closed: pr.state === "closed",
    closedAt: pr.closed_at,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    locked: pr.locked,
    isDraft: pr.draft,
    merged: pr.merged,
    mergedAt: pr.merged_at,
    mergedBy: () => actorView(ctx, pr.merged_by_id !== null ? ctx.gh.users.get(pr.merged_by_id) : undefined),
    mergeCommit: () => commitBySha(ctx, repo, pr.merge_commit_sha),
    potentialMergeCommit: null,
    mergeable: pr.state !== "open" ? "UNKNOWN" : pr.mergeable === false ? "CONFLICTING" : "MERGEABLE",
    mergeStateStatus: () => mergeStateStatus(ctx, pr),
    isInMergeQueue: false,
    isMergeQueueEnabled: false,
    autoMergeRequest: null,
    maintainerCanModify: false,
    url,
    permalink: url,
    resourcePath: `/${repo.full_name}/pull/${pr.number}`,
    author: () => actorView(ctx, ctx.gh.users.get(pr.user_id)),
    authorAssociation: computeAuthorAssociation(ctx.gh, pr.user_id, repo.id),
    viewerDidAuthor: ctx.viewer?.id === pr.user_id,
    repository: () => repoView(ctx, repo),
    baseRepository: () => repoView(ctx, repo),
    baseRefName: pr.base_ref,
    baseRefOid: pr.base_sha,
    baseRef: () => refView(ctx, repo, pr.base_ref),
    headRefName: pr.head_ref,
    headRefOid: pr.head_sha,
    headRef: () => (headRepo ? refView(ctx, headRepo, pr.head_ref) : null),
    headRepository: () => (canSeeRepo(ctx, headRepo) ? repoView(ctx, headRepo) : null),
    headRepositoryOwner: () => (headRepo ? ownerView(ctx, headRepo) : null),
    isCrossRepository: pr.head_repo_id !== pr.base_repo_id,
    additions: () => getDiff().files.reduce((n, f) => n + f.additions, 0),
    deletions: () => getDiff().files.reduce((n, f) => n + f.deletions, 0),
    changedFiles: () => getDiff().files.length,
    files: (args: ConnectionArgs) => connectionFromArray(getDiff().files, args),
    commits: (args: ConnectionArgs) =>
      connectionFromArray(
        getDiff().commits.map((c) => ({
          id: generateNodeId("PullRequestCommit", c.id),
          url: `${url}/commits/${c.sha}`,
          commit: commitView(ctx, headRepo ?? repo, c),
          pullRequest: () => prView(ctx, pr),
        })),
        args,
      ),
    statusCheckRollup: () => {
      const head = findCommitBySha(ctx.gh, repo.id, pr.head_sha);
      return head ? statusCheckRollupView(ctx, repo, head) : null;
    },
    labels: (args: Args) => labelsConnection(ctx, repo, pr.label_ids, args),
    assignees: (args: ConnectionArgs) => assigneesConnection(ctx, pr.assignee_ids, args),
    assignedActors: (args: ConnectionArgs) => assigneesConnection(ctx, pr.assignee_ids, args),
    milestone: () => {
      const m = pr.milestone_id !== null ? ctx.gh.milestones.get(pr.milestone_id) : undefined;
      return m ? milestoneView(ctx, repo, m) : null;
    },
    comments: (args: Args) =>
      connectionFromArray(
        byOrder(comments(), args.orderBy).map((c) => commentView(ctx, c)),
        args,
      ),
    reviews: (args: Args) => {
      const states: string[] | undefined = args.states;
      const list = visibleReviews(ctx, pr).filter((r) => {
        if (states?.length && !states.includes(r.state)) return false;
        if (args.author && ctx.gh.users.get(r.user_id)?.login !== args.author) return false;
        return true;
      });
      return connectionFromArray(
        list.map((r) => reviewView(ctx, r)),
        args,
      );
    },
    latestReviews: (args: ConnectionArgs) =>
      connectionFromArray(
        latestReviewsByAuthor(visibleReviews(ctx, pr)).map((r) => reviewView(ctx, r)),
        args,
      ),
    reviewDecision: () => reviewDecision(ctx, pr),
    reviewRequests: (args: ConnectionArgs) => {
      const requested = [
        ...users(ctx, pr.requested_reviewer_ids).map((u) => ({
          id: Buffer.from(`0:ReviewRequest${pr.id}:User${u.id}`).toString("base64"),
          requestedReviewer: actorView(ctx, u),
        })),
        ...pr.requested_team_ids
          .map((id) => ctx.gh.teams.get(id))
          .filter((t): t is GitHubTeam => t !== undefined)
          .map((t) => ({
            id: Buffer.from(`0:ReviewRequest${pr.id}:Team${t.id}`).toString("base64"),
            requestedReviewer: teamView(ctx, t),
          })),
      ];
      return connectionFromArray(requested, args);
    },
    closingIssuesReferences: (args: ConnectionArgs) => connectionFromArray([], args),
    reactionGroups: [],
  };
}

function pullRequestFromNodeId(ctx: GraphQLContext, id: string): GitHubPullRequest | undefined {
  const decoded = decodeNodeId(id);
  if (decoded?.type !== "PullRequest") return undefined;
  const pr = ctx.gh.pullRequests.get(decoded.id);
  return pr && canSeeRepo(ctx, ctx.gh.repos.get(pr.repo_id)) ? pr : undefined;
}

function repoScoped<T extends { repo_id: number }>(ctx: GraphQLContext, row: T | undefined): T | undefined {
  return row && canSeeRepo(ctx, ctx.gh.repos.get(row.repo_id)) ? row : undefined;
}

export function nodeById(ctx: GraphQLContext, id: string): View | null {
  const decoded = decodeNodeId(id);
  if (!decoded) return null;
  const { gh } = ctx;
  switch (decoded.type) {
    case "PullRequest": {
      const pr = repoScoped(ctx, gh.pullRequests.get(decoded.id));
      return pr ? prView(ctx, pr) : null;
    }
    case "Issue": {
      const issue = repoScoped(ctx, gh.issues.get(decoded.id));
      if (!issue) return null;
      const pr = issue.is_pull_request
        ? gh.pullRequests.findBy("repo_id", issue.repo_id).find((p) => p.number === issue.number)
        : undefined;
      return pr ? prView(ctx, pr) : issueView(ctx, issue);
    }
    case "Repository": {
      const repo = gh.repos.get(decoded.id);
      return canSeeRepo(ctx, repo) ? repoView(ctx, repo) : null;
    }
    case "User":
    case "Bot":
      return actorView(ctx, gh.users.get(decoded.id));
    case "Org": {
      const org = gh.orgs.get(decoded.id);
      return org ? orgView(ctx, org) : null;
    }
    case "Team": {
      const team = gh.teams.get(decoded.id);
      return team ? teamView(ctx, team) : null;
    }
    case "IssueComment": {
      const comment = repoScoped(ctx, gh.comments.get(decoded.id));
      return comment ? commentView(ctx, comment) : null;
    }
    case "PullRequestReview": {
      const review = repoScoped(ctx, gh.reviews.get(decoded.id));
      return review ? reviewView(ctx, review) : null;
    }
    case "Label": {
      const label = repoScoped(ctx, gh.labels.get(decoded.id));
      return label ? { __typename: "Label", ...labelView(ctx, gh.repos.get(label.repo_id)!, label) } : null;
    }
    case "Milestone": {
      const m = repoScoped(ctx, gh.milestones.get(decoded.id));
      return m ? { __typename: "Milestone", ...milestoneView(ctx, gh.repos.get(m.repo_id)!, m) } : null;
    }
    case "Commit": {
      const commit = repoScoped(ctx, gh.commits.get(decoded.id));
      return commit ? commitView(ctx, gh.repos.get(commit.repo_id)!, commit) : null;
    }
    case "CheckRun": {
      const run = repoScoped(ctx, gh.checkRuns.get(decoded.id));
      return run ? checkRunView(ctx, gh.repos.get(run.repo_id)!, run) : null;
    }
    default:
      return null;
  }
}

function search(ctx: GraphQLContext, args: Args) {
  if (args.type !== "ISSUE") return connectionFromArray([], args, { issueCount: 0 });
  const login = ctx.viewer?.login ?? "";
  const parsed = parseSearchQuery(String(args.query).replace(/@me\b/g, login));
  const reviewRequested = parsed.qualifiers.get("review-requested") ?? [];
  const hits: View[] = [];
  const issues = [...ctx.gh.issues.all()].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
  for (const issue of issues) {
    const repo = ctx.gh.repos.get(issue.repo_id);
    if (!canSeeRepo(ctx, repo)) continue;
    const pr = issue.is_pull_request
      ? (ctx.gh.pullRequests.findBy("repo_id", repo.id).find((p) => p.number === issue.number) ?? null)
      : null;
    if (issue.is_pull_request && !pr) continue;
    if (!issuePrMatchesFilters(ctx.gh, parsed, repo, issue, pr)) continue;
    if (reviewRequested.length) {
      const ids = pr?.requested_reviewer_ids ?? [];
      const wanted = reviewRequested.map((l) => ctx.gh.users.findOneBy("login", l)?.id);
      if (!wanted.every((id) => id !== undefined && ids.includes(id))) continue;
    }
    const view = pr ? prView(ctx, pr) : issueView(ctx, issue);
    if (view) hits.push(view);
  }
  return connectionFromArray(hits, args, { issueCount: hits.length });
}

export function createQueryRoot(ctx: GraphQLContext) {
  return {
    id: generateNodeId("Query", 0),
    viewer: () => actorView(ctx, assertAuthenticatedActor(ctx.gh, ctx.authUser)),
    user: ({ login }: Args) => {
      const user = ctx.gh.users.findOneBy("login", login);
      if (!user) throw notFound(`Could not resolve to a User with the login of '${login}'.`);
      return actorView(ctx, user);
    },
    organization: ({ login }: Args) => {
      const org = ctx.gh.orgs.findOneBy("login", login);
      if (!org) throw notFound(`Could not resolve to an Organization with the login of '${login}'.`);
      return orgView(ctx, org);
    },
    repositoryOwner: ({ login }: Args) => {
      const user = ctx.gh.users.findOneBy("login", login);
      if (user) return actorView(ctx, user);
      const org = ctx.gh.orgs.findOneBy("login", login);
      return org ? orgView(ctx, org) : null;
    },
    repository: ({ owner, name }: Args) => {
      const view = repositoryByName(ctx, owner, name);
      if (!view) throw notFound(`Could not resolve to a Repository with the name '${owner}/${name}'.`);
      return view;
    },
    node: ({ id }: Args) => nodeById(ctx, id),
    nodes: ({ ids }: Args) => (ids as string[]).map((id) => nodeById(ctx, id)),
    search: (args: Args) => search(ctx, args),
    rateLimit: () => ({
      cost: 1,
      limit: 5000,
      nodeCount: 1,
      remaining: 4999,
      used: 1,
      resetAt: new Date(Date.now() + 3600_000).toISOString(),
    }),
  };
}

function restRepoPath(repo: GitHubRepo): string {
  const [owner, name] = repo.full_name.split("/");
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function requirePullRequest(ctx: GraphQLContext, id: string): { pr: GitHubPullRequest; repo: GitHubRepo } {
  const pr = pullRequestFromNodeId(ctx, id);
  const repo = pr && ctx.gh.repos.get(pr.repo_id);
  if (!pr || !repo) throw notFound(`Could not resolve to a node with the global id of '${id}'`);
  return { pr, repo };
}

function freshPr(ctx: GraphQLContext, pr: GitHubPullRequest): View | null {
  return prView(ctx, ctx.gh.pullRequests.get(pr.id) ?? pr);
}

function idsOfType(ids: string[] | undefined, type: string): number[] {
  return (ids ?? []).map((id) => {
    const decoded = decodeNodeId(id);
    if (decoded?.type !== type) throw notFound(`Could not resolve to a node with the global id of '${id}'`);
    return decoded.id;
  });
}

function setPullAssignees(ctx: GraphQLContext, pr: GitHubPullRequest, assigneeIds: number[]): void {
  ctx.gh.pullRequests.update(pr.id, { assignee_ids: assigneeIds });
  const issue = ctx.gh.issues.findBy("repo_id", pr.repo_id).find((i) => i.number === pr.number && i.is_pull_request);
  if (issue) ctx.gh.issues.update(issue.id, { assignee_ids: assigneeIds });
}

function setPullMilestone(ctx: GraphQLContext, pr: GitHubPullRequest, milestoneId: number | null): void {
  ctx.gh.pullRequests.update(pr.id, { milestone_id: milestoneId });
  const issue = ctx.gh.issues.findBy("repo_id", pr.repo_id).find((i) => i.number === pr.number && i.is_pull_request);
  if (issue) ctx.gh.issues.update(issue.id, { milestone_id: milestoneId });
}

function requireLabelable(
  ctx: GraphQLContext,
  id: string,
): { number: number; repo: GitHubRepo; view: () => View | null } {
  const node = decodeNodeId(id);
  if (node?.type === "PullRequest") {
    const { pr, repo } = requirePullRequest(ctx, id);
    return { number: pr.number, repo, view: () => freshPr(ctx, pr) };
  }
  if (node?.type === "Issue") {
    const issue = repoScoped(ctx, ctx.gh.issues.get(node.id));
    const repo = issue && ctx.gh.repos.get(issue.repo_id);
    if (issue && repo) return { number: issue.number, repo, view: () => nodeById(ctx, id) };
  }
  throw notFound(`Could not resolve to a node with the global id of '${id}'`);
}

async function replaceLabels(ctx: GraphQLContext, repo: GitHubRepo, number: number, labelIds: number[]) {
  const names = labelIds.map((id) => {
    const label = repoScoped(ctx, ctx.gh.labels.get(id));
    if (!label) throw notFound(`Could not resolve to a Label with the id of '${id}'.`);
    return label.name;
  });
  await ctx.rest("PUT", `${restRepoPath(repo)}/issues/${number}/labels`, { labels: names });
}

async function setReviewRequests(
  ctx: GraphQLContext,
  pr: GitHubPullRequest,
  repo: GitHubRepo,
  logins: string[],
  teamSlugs: string[],
  union: boolean,
) {
  const path = `${restRepoPath(repo)}/pulls/${pr.number}/requested_reviewers`;
  if (!union) {
    const dropUsers = users(ctx, pr.requested_reviewer_ids)
      .map((u) => u.login)
      .filter((l) => !logins.includes(l));
    const dropTeams = pr.requested_team_ids
      .map((id) => ctx.gh.teams.get(id)?.slug)
      .filter((s): s is string => s !== undefined && !teamSlugs.includes(s));
    if (dropUsers.length || dropTeams.length) {
      await ctx.rest("DELETE", path, { reviewers: dropUsers, team_reviewers: dropTeams });
    }
  }
  if (logins.length || teamSlugs.length) {
    await ctx.rest("POST", path, { reviewers: logins, team_reviewers: teamSlugs });
  }
}

function pendingReviewFor(ctx: GraphQLContext, pr: GitHubPullRequest): GitHubReview {
  const review = ctx.gh.reviews
    .findBy("repo_id", pr.repo_id)
    .find((r) => r.pull_number === pr.number && r.state === "PENDING" && r.user_id === ctx.viewer?.id);
  if (!review) throw new GitHubGraphQLError("UNPROCESSABLE", "Could not find a pending review for this user.");
  return review;
}

export function createMutationRoot(ctx: GraphQLContext) {
  const { gh } = ctx;
  const payload = (input: Args, rest: View) => ({ clientMutationId: input.clientMutationId ?? null, ...rest });
  const actor = () => actorView(ctx, assertAuthenticatedActor(gh, ctx.authUser));

  return {
    createPullRequest: async ({ input }: Args) => {
      const decoded = decodeNodeId(input.repositoryId);
      const repo = decoded?.type === "Repository" ? gh.repos.get(decoded.id) : undefined;
      if (!canSeeRepo(ctx, repo))
        throw notFound(`Could not resolve to a node with the global id of '${input.repositoryId}'`);
      let head: string = input.headRefName;
      if (input.headRepositoryId) {
        const headDecoded = decodeNodeId(input.headRepositoryId);
        const headRepo = headDecoded?.type === "Repository" ? gh.repos.get(headDecoded.id) : undefined;
        if (!canSeeRepo(ctx, headRepo)) {
          throw notFound(`Could not resolve to a node with the global id of '${input.headRepositoryId}'`);
        }
        if (headRepo.id !== repo.id) head = `${ownerLoginOf(gh, headRepo)}:${input.headRefName}`;
      }
      const created = await ctx.rest("POST", `${restRepoPath(repo)}/pulls`, {
        title: input.title,
        body: input.body ?? null,
        head,
        base: input.baseRefName,
        draft: input.draft ?? false,
      });
      return payload(input, { pullRequest: prView(ctx, gh.pullRequests.get(created.id)!) });
    },

    updatePullRequest: async ({ input }: Args) => {
      const { pr, repo } = requirePullRequest(ctx, input.pullRequestId);
      const patch: Args = {};
      if (input.title != null) patch.title = input.title;
      if (input.body !== undefined) patch.body = input.body;
      if (input.baseRefName != null) patch.base = input.baseRefName;
      if (input.state != null) patch.state = String(input.state).toLowerCase();
      if (Object.keys(patch).length) await ctx.rest("PATCH", `${restRepoPath(repo)}/pulls/${pr.number}`, patch);
      if (input.labelIds) await replaceLabels(ctx, repo, pr.number, idsOfType(input.labelIds, "Label"));
      if (input.assigneeIds) setPullAssignees(ctx, pr, idsOfType(input.assigneeIds, "User"));
      if (input.milestoneId !== undefined) {
        setPullMilestone(ctx, pr, input.milestoneId === null ? null : idsOfType([input.milestoneId], "Milestone")[0]);
      }
      return payload(input, { actor, pullRequest: freshPr(ctx, pr) });
    },

    closePullRequest: async ({ input }: Args) => {
      const { pr, repo } = requirePullRequest(ctx, input.pullRequestId);
      await ctx.rest("PATCH", `${restRepoPath(repo)}/pulls/${pr.number}`, { state: "closed" });
      return payload(input, { pullRequest: freshPr(ctx, pr) });
    },

    reopenPullRequest: async ({ input }: Args) => {
      const { pr, repo } = requirePullRequest(ctx, input.pullRequestId);
      if (pr.merged) throw new GitHubGraphQLError("UNPROCESSABLE", "Could not reopen a merged pull request.");
      await ctx.rest("PATCH", `${restRepoPath(repo)}/pulls/${pr.number}`, { state: "open" });
      return payload(input, { pullRequest: freshPr(ctx, pr) });
    },

    markPullRequestReadyForReview: async ({ input }: Args) => {
      const { pr, repo } = requirePullRequest(ctx, input.pullRequestId);
      await ctx.rest("PATCH", `${restRepoPath(repo)}/pulls/${pr.number}`, { draft: false });
      return payload(input, { pullRequest: freshPr(ctx, pr) });
    },

    convertPullRequestToDraft: async ({ input }: Args) => {
      const { pr, repo } = requirePullRequest(ctx, input.pullRequestId);
      await ctx.rest("PATCH", `${restRepoPath(repo)}/pulls/${pr.number}`, { draft: true });
      return payload(input, { pullRequest: freshPr(ctx, pr) });
    },

    mergePullRequest: async ({ input }: Args) => {
      const { pr, repo } = requirePullRequest(ctx, input.pullRequestId);
      await ctx.rest("PUT", `${restRepoPath(repo)}/pulls/${pr.number}/merge`, {
        merge_method: String(input.mergeMethod ?? "MERGE").toLowerCase(),
        commit_title: input.commitHeadline ?? undefined,
        commit_message: input.commitBody ?? undefined,
        sha: input.expectedHeadOid ?? undefined,
      });
      return payload(input, { actor, pullRequest: freshPr(ctx, pr) });
    },

    addPullRequestReview: async ({ input }: Args) => {
      const { pr, repo } = requirePullRequest(ctx, input.pullRequestId);
      if (input.event === "DISMISS") {
        throw new GitHubGraphQLError("UNPROCESSABLE", "DISMISS is not a valid event for a new review.");
      }
      const comments = [
        ...(input.comments ?? []).map((c: Args) => ({ path: c.path, position: c.position, body: c.body })),
        ...(input.threads ?? []).map((t: Args) => ({ path: t.path, line: t.line, side: t.side, body: t.body })),
      ];
      const review = await ctx.rest("POST", `${restRepoPath(repo)}/pulls/${pr.number}/reviews`, {
        body: input.body ?? null,
        event: input.event ?? undefined,
        commit_id: input.commitOID ?? undefined,
        comments,
      });
      return payload(input, { pullRequestReview: reviewView(ctx, gh.reviews.get(review.id)!) });
    },

    submitPullRequestReview: async ({ input }: Args) => {
      let review: GitHubReview | undefined;
      if (input.pullRequestReviewId) {
        const decoded = decodeNodeId(input.pullRequestReviewId);
        review = decoded?.type === "PullRequestReview" ? repoScoped(ctx, gh.reviews.get(decoded.id)) : undefined;
        if (!review) throw notFound(`Could not resolve to a node with the global id of '${input.pullRequestReviewId}'`);
      } else if (input.pullRequestId) {
        review = pendingReviewFor(ctx, requirePullRequest(ctx, input.pullRequestId).pr);
      } else {
        throw new GitHubGraphQLError("UNPROCESSABLE", "Either pullRequestId or pullRequestReviewId is required.");
      }
      const repo = gh.repos.get(review.repo_id)!;
      await ctx.rest("POST", `${restRepoPath(repo)}/pulls/${review.pull_number}/reviews/${review.id}/events`, {
        event: input.event,
        body: input.body ?? undefined,
      });
      return payload(input, { pullRequestReview: reviewView(ctx, gh.reviews.get(review.id)!) });
    },

    addComment: async ({ input }: Args) => {
      const target = requireLabelable(ctx, input.subjectId);
      const created = await ctx.rest("POST", `${restRepoPath(target.repo)}/issues/${target.number}/comments`, {
        body: input.body,
      });
      const comment = gh.comments.get(created.id)!;
      const all = gh.comments
        .findBy("repo_id", target.repo.id)
        .filter((c) => c.comment_type === "issue" && c.issue_number === target.number)
        .sort((a, b) => a.id - b.id);
      const edge = connectionFromArray(all, { first: all.length }).edges.find((e) => e.node.id === comment.id)!;
      return payload(input, {
        commentEdge: { cursor: edge.cursor, node: commentView(ctx, comment) },
        subject: target.view,
      });
    },

    updateIssueComment: async ({ input }: Args) => {
      const decoded = decodeNodeId(input.id);
      const comment = decoded?.type === "IssueComment" ? repoScoped(ctx, gh.comments.get(decoded.id)) : undefined;
      if (!comment) throw notFound(`Could not resolve to a node with the global id of '${input.id}'`);
      const repo = gh.repos.get(comment.repo_id)!;
      await ctx.rest("PATCH", `${restRepoPath(repo)}/issues/comments/${comment.id}`, { body: input.body });
      return payload(input, { issueComment: commentView(ctx, gh.comments.get(comment.id)!) });
    },

    deleteIssueComment: async ({ input }: Args) => {
      const decoded = decodeNodeId(input.id);
      const comment = decoded?.type === "IssueComment" ? repoScoped(ctx, gh.comments.get(decoded.id)) : undefined;
      if (!comment) throw notFound(`Could not resolve to a node with the global id of '${input.id}'`);
      const repo = gh.repos.get(comment.repo_id)!;
      await ctx.rest("DELETE", `${restRepoPath(repo)}/issues/comments/${comment.id}`);
      return payload(input, {});
    },

    addLabelsToLabelable: async ({ input }: Args) => {
      const target = requireLabelable(ctx, input.labelableId);
      const names = idsOfType(input.labelIds, "Label").map((id) => {
        const label = repoScoped(ctx, gh.labels.get(id));
        if (!label) throw notFound(`Could not resolve to a Label with the id of '${id}'.`);
        return label.name;
      });
      await ctx.rest("POST", `${restRepoPath(target.repo)}/issues/${target.number}/labels`, { labels: names });
      return payload(input, { labelable: target.view });
    },

    removeLabelsFromLabelable: async ({ input }: Args) => {
      const target = requireLabelable(ctx, input.labelableId);
      for (const id of idsOfType(input.labelIds, "Label")) {
        const label = repoScoped(ctx, gh.labels.get(id));
        if (!label) continue;
        await ctx.rest(
          "DELETE",
          `${restRepoPath(target.repo)}/issues/${target.number}/labels/${encodeURIComponent(label.name)}`,
        );
      }
      return payload(input, { labelable: target.view });
    },

    requestReviews: async ({ input }: Args) => {
      const { pr, repo } = requirePullRequest(ctx, input.pullRequestId);
      const logins = users(ctx, idsOfType(input.userIds, "User")).map((u) => u.login);
      const slugs = idsOfType(input.teamIds, "Team").map((id) => gh.teams.get(id)?.slug ?? "");
      await setReviewRequests(ctx, pr, repo, logins, slugs, input.union ?? false);
      return payload(input, { actor, pullRequest: freshPr(ctx, pr) });
    },

    requestReviewsByLogin: async ({ input }: Args) => {
      const { pr, repo } = requirePullRequest(ctx, input.pullRequestId);
      const logins = [...(input.userLogins ?? []), ...(input.botLogins ?? [])];
      const slugs = (input.teamSlugs ?? []).map((s: string) => s.split("/").pop()!);
      await setReviewRequests(ctx, pr, repo, logins, slugs, input.union);
      return payload(input, { pullRequest: freshPr(ctx, pr) });
    },

    replaceActorsForAssignable: async ({ input }: Args) => {
      const { pr } = requirePullRequest(ctx, input.assignableId);
      const ids = (input.actorLogins as string[]).map((login) => {
        const user = gh.users.findOneBy("login", login);
        if (!user) throw notFound(`Could not resolve to a User with the login of '${login}'.`);
        return user.id;
      });
      setPullAssignees(ctx, pr, ids);
      return payload(input, {});
    },
  };
}
