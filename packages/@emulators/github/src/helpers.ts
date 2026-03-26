import { randomBytes } from "crypto";
import type { GitHubUser, GitHubOrg, GitHubRepo, GitHubIssue, GitHubPullRequest, GitHubLabel, GitHubMilestone, GitHubComment, GitHubRelease, GitHubTeam, GitHubBranch, GitHubCommit, GitHubCheckRun, GitHubCheckSuite, GitHubReview, GitHubWorkflow, GitHubWorkflowRun, GitHubJob, GitHubArtifact, GitHubReleaseAsset, GitHubWebhook, GitHubRef, GitHubTag, GitHubBlob, GitHubTree } from "./entities.js";
import type { GitHubStore } from "./store.js";

export function generateNodeId(type: string, id: number): string {
  return Buffer.from(`0:${type}${id}`).toString("base64").replace(/=+$/, "");
}

export function generateSha(): string {
  return randomBytes(20).toString("hex");
}

export function timestamp(): string {
  return new Date().toISOString();
}

export function userUrl(baseUrl: string, login: string) {
  return {
    url: `${baseUrl}/users/${login}`,
    html_url: `${baseUrl}/${login}`,
    repos_url: `${baseUrl}/users/${login}/repos`,
    followers_url: `${baseUrl}/users/${login}/followers`,
    following_url: `${baseUrl}/users/${login}/following{/other_user}`,
    gists_url: `${baseUrl}/users/${login}/gists{/gist_id}`,
    starred_url: `${baseUrl}/users/${login}/starred{/owner}{/repo}`,
    subscriptions_url: `${baseUrl}/users/${login}/subscriptions`,
    organizations_url: `${baseUrl}/users/${login}/orgs`,
    events_url: `${baseUrl}/users/${login}/events{/privacy}`,
    received_events_url: `${baseUrl}/users/${login}/received_events`,
    avatar_url: `${baseUrl}/avatars/u/${login}`,
  };
}

export function formatUser(user: GitHubUser, baseUrl: string) {
  const urls = userUrl(baseUrl, user.login);
  return {
    login: user.login,
    id: user.id,
    node_id: user.node_id,
    avatar_url: urls.avatar_url,
    gravatar_id: user.gravatar_id,
    url: urls.url,
    html_url: urls.html_url,
    followers_url: urls.followers_url,
    following_url: urls.following_url,
    gists_url: urls.gists_url,
    starred_url: urls.starred_url,
    subscriptions_url: urls.subscriptions_url,
    organizations_url: urls.organizations_url,
    repos_url: urls.repos_url,
    events_url: urls.events_url,
    received_events_url: urls.received_events_url,
    type: user.type,
    site_admin: user.site_admin,
    user_view_type: "public",
  };
}

export function formatUserFull(user: GitHubUser, baseUrl: string) {
  return {
    ...formatUser(user, baseUrl),
    name: user.name,
    company: user.company,
    blog: user.blog,
    location: user.location,
    email: user.email,
    hireable: user.hireable,
    bio: user.bio,
    twitter_username: user.twitter_username,
    public_repos: user.public_repos,
    public_gists: user.public_gists,
    followers: user.followers,
    following: user.following,
    created_at: user.created_at,
    updated_at: user.updated_at,
  };
}

export function formatOwner(store: GitHubStore, ownerId: number, ownerType: string, baseUrl: string) {
  if (ownerType === "Organization") {
    const org = store.orgs.get(ownerId);
    if (!org) return null;
    return formatOrgBrief(org, baseUrl);
  }
  const user = store.users.get(ownerId);
  if (!user) return null;
  return formatUser(user, baseUrl);
}

export function formatOrgBrief(org: GitHubOrg, baseUrl: string) {
  return {
    login: org.login,
    id: org.id,
    node_id: org.node_id,
    url: `${baseUrl}/orgs/${org.login}`,
    html_url: `${baseUrl}/${org.login}`,
    repos_url: `${baseUrl}/orgs/${org.login}/repos`,
    events_url: `${baseUrl}/orgs/${org.login}/events`,
    hooks_url: `${baseUrl}/orgs/${org.login}/hooks`,
    issues_url: `${baseUrl}/orgs/${org.login}/issues`,
    members_url: `${baseUrl}/orgs/${org.login}/members{/member}`,
    public_members_url: `${baseUrl}/orgs/${org.login}/public_members{/member}`,
    avatar_url: `${baseUrl}/avatars/o/${org.login}`,
    description: org.description,
    type: "Organization",
    site_admin: false,
    user_view_type: "public",
  };
}

function permissionsFromLevel(level: string) {
  const levels = ["pull", "triage", "push", "maintain", "admin"];
  const idx = levels.indexOf(level);
  return {
    admin: idx >= 4,
    maintain: idx >= 3,
    push: idx >= 2,
    triage: idx >= 1,
    pull: idx >= 0,
  };
}

function computeRepoPermissions(store: GitHubStore, repo: GitHubRepo, authUserId: number) {
  if (repo.owner_type === "User" && repo.owner_id === authUserId) {
    return { admin: true, maintain: true, push: true, triage: true, pull: true };
  }
  if (repo.owner_type === "Organization") {
    for (const team of store.teams.all()) {
      if (team.org_id !== repo.owner_id) continue;
      const member = store.teamMembers.findBy("team_id", team.id).find((m) => m.user_id === authUserId);
      if (member) {
        return { admin: true, maintain: true, push: true, triage: true, pull: true };
      }
    }
  }
  const collab = store.collaborators.findBy("repo_id", repo.id).find((c) => c.user_id === authUserId);
  if (collab) {
    return permissionsFromLevel(collab.permission);
  }
  if (!repo.private) {
    return { admin: false, maintain: false, push: false, triage: false, pull: true };
  }
  return { admin: false, maintain: false, push: false, triage: false, pull: false };
}

export function computeAuthorAssociation(store: GitHubStore, userId: number, repoId: number): string {
  const repo = store.repos.get(repoId);
  if (!repo) return "NONE";

  if (repo.owner_type === "User" && repo.owner_id === userId) return "OWNER";

  if (repo.owner_type === "Organization") {
    for (const team of store.teams.all()) {
      if (team.org_id !== repo.owner_id) continue;
      const member = store.teamMembers.findBy("team_id", team.id).find((m) => m.user_id === userId);
      if (member) return "MEMBER";
    }
  }

  const collab = store.collaborators.findBy("repo_id", repoId).find((c) => c.user_id === userId);
  if (collab) return "COLLABORATOR";

  return "NONE";
}

export function formatOrgFull(org: GitHubOrg, baseUrl: string) {
  return {
    ...formatOrgBrief(org, baseUrl),
    name: org.name,
    company: org.company,
    blog: org.blog,
    location: org.location,
    email: org.email,
    twitter_username: org.twitter_username,
    is_verified: org.is_verified,
    has_organization_projects: org.has_organization_projects,
    has_repository_projects: org.has_repository_projects,
    public_repos: org.public_repos,
    public_gists: org.public_gists,
    followers: org.followers,
    following: org.following,
    created_at: org.created_at,
    updated_at: org.updated_at,
    members_can_create_repositories: org.members_can_create_repositories,
    default_repository_permission: org.default_repository_permission,
    billing_email: org.billing_email ?? null,
  };
}

export function formatRepo(repo: GitHubRepo, store: GitHubStore, baseUrl: string, authUserId?: number) {
  const owner = formatOwner(store, repo.owner_id, repo.owner_type, baseUrl);
  const ownerLogin = owner?.login ?? "unknown";
  const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
  const htmlUrl = `${baseUrl}/${repo.full_name}`;

  return {
    id: repo.id,
    node_id: repo.node_id,
    name: repo.name,
    full_name: repo.full_name,
    private: repo.private,
    owner,
    html_url: htmlUrl,
    description: repo.description,
    fork: repo.fork,
    url: repoUrl,
    forks_url: `${repoUrl}/forks`,
    keys_url: `${repoUrl}/keys{/key_id}`,
    collaborators_url: `${repoUrl}/collaborators{/collaborator}`,
    teams_url: `${repoUrl}/teams`,
    hooks_url: `${repoUrl}/hooks`,
    issue_events_url: `${repoUrl}/issues/events{/number}`,
    events_url: `${repoUrl}/events`,
    assignees_url: `${repoUrl}/assignees{/user}`,
    branches_url: `${repoUrl}/branches{/branch}`,
    tags_url: `${repoUrl}/tags`,
    blobs_url: `${repoUrl}/git/blobs{/sha}`,
    git_tags_url: `${repoUrl}/git/tags{/sha}`,
    git_refs_url: `${repoUrl}/git/ref{/sha}`,
    trees_url: `${repoUrl}/git/trees{/sha}`,
    statuses_url: `${repoUrl}/statuses/{sha}`,
    languages_url: `${repoUrl}/languages`,
    stargazers_url: `${repoUrl}/stargazers`,
    contributors_url: `${repoUrl}/contributors`,
    subscribers_url: `${repoUrl}/subscribers`,
    subscription_url: `${repoUrl}/subscription`,
    commits_url: `${repoUrl}/commits{/sha}`,
    git_commits_url: `${repoUrl}/git/commits{/sha}`,
    comments_url: `${repoUrl}/comments{/number}`,
    issue_comment_url: `${repoUrl}/issues/comments{/number}`,
    contents_url: `${repoUrl}/contents/{+path}`,
    compare_url: `${repoUrl}/compare/{base}...{head}`,
    merges_url: `${repoUrl}/merges`,
    archive_url: `${repoUrl}/{archive_format}{/ref}`,
    downloads_url: `${repoUrl}/downloads`,
    issues_url: `${repoUrl}/issues{/number}`,
    pulls_url: `${repoUrl}/pulls{/number}`,
    milestones_url: `${repoUrl}/milestones{/number}`,
    notifications_url: `${repoUrl}/notifications{?since,all,participating}`,
    labels_url: `${repoUrl}/labels{/name}`,
    releases_url: `${repoUrl}/releases{/id}`,
    deployments_url: `${repoUrl}/deployments`,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
    git_url: `git://${baseUrl.replace(/^https?:\/\//, "")}/${repo.full_name}.git`,
    ssh_url: `git@${baseUrl.replace(/^https?:\/\//, "")}:${repo.full_name}.git`,
    clone_url: `${htmlUrl}.git`,
    svn_url: htmlUrl,
    homepage: repo.homepage,
    size: repo.size,
    stargazers_count: repo.stargazers_count,
    watchers_count: repo.watchers_count,
    language: repo.language,
    has_issues: repo.has_issues,
    has_projects: repo.has_projects,
    has_downloads: repo.has_downloads,
    has_wiki: repo.has_wiki,
    has_pages: repo.has_pages,
    has_discussions: repo.has_discussions,
    forks_count: repo.forks_count,
    mirror_url: null,
    archived: repo.archived,
    disabled: repo.disabled,
    open_issues_count: repo.open_issues_count,
    license: repo.license,
    allow_forking: repo.allow_forking,
    is_template: repo.is_template,
    topics: repo.topics,
    visibility: repo.visibility,
    forks: repo.forks_count,
    open_issues: repo.open_issues_count,
    watchers: repo.watchers_count,
    default_branch: repo.default_branch,
    permissions:
      authUserId !== undefined
        ? computeRepoPermissions(store, repo, authUserId)
        : {
            admin: true,
            maintain: true,
            push: true,
            triage: true,
            pull: true,
          },
    allow_rebase_merge: repo.allow_rebase_merge,
    allow_squash_merge: repo.allow_squash_merge,
    allow_merge_commit: repo.allow_merge_commit,
    allow_auto_merge: repo.allow_auto_merge,
    delete_branch_on_merge: repo.delete_branch_on_merge,
  };
}

export function formatIssue(
  issue: GitHubIssue,
  store: GitHubStore,
  baseUrl: string
) {
  const repo = store.repos.get(issue.repo_id);
  if (!repo) return null;
  const user = store.users.get(issue.user_id);
  const repoUrl = `${baseUrl}/repos/${repo.full_name}`;

  const labels = issue.label_ids
    .map((id) => store.labels.get(id))
    .filter(Boolean)
    .map((l) => formatLabel(l!, repo, baseUrl));

  const assignees = issue.assignee_ids
    .map((id) => store.users.get(id))
    .filter(Boolean)
    .map((u) => formatUser(u!, baseUrl));

  const milestone = issue.milestone_id ? store.milestones.get(issue.milestone_id) : null;
  const closedBy = issue.closed_by_id ? store.users.get(issue.closed_by_id) : null;

  return {
    url: `${repoUrl}/issues/${issue.number}`,
    repository_url: repoUrl,
    labels_url: `${repoUrl}/issues/${issue.number}/labels{/name}`,
    comments_url: `${repoUrl}/issues/${issue.number}/comments`,
    events_url: `${repoUrl}/issues/${issue.number}/events`,
    html_url: `${baseUrl}/${repo.full_name}/issues/${issue.number}`,
    id: issue.id,
    node_id: issue.node_id,
    number: issue.number,
    title: issue.title,
    user: user ? formatUser(user, baseUrl) : null,
    labels,
    state: issue.state,
    state_reason: issue.state_reason,
    locked: issue.locked,
    active_lock_reason: issue.active_lock_reason,
    assignee: assignees[0] ?? null,
    assignees,
    milestone: milestone ? formatMilestone(milestone, repo, store, baseUrl) : null,
    comments: issue.comments,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    closed_by: closedBy ? formatUser(closedBy, baseUrl) : null,
    body: issue.body,
    reactions: defaultReactions(`${repoUrl}/issues/${issue.number}`),
    timeline_url: `${repoUrl}/issues/${issue.number}/timeline`,
    performed_via_github_app: null,
    author_association: computeAuthorAssociation(store, issue.user_id, issue.repo_id),
  };
}

export function formatPullRequest(
  pr: GitHubPullRequest,
  store: GitHubStore,
  baseUrl: string
) {
  const repo = store.repos.get(pr.repo_id);
  if (!repo) return null;
  const user = store.users.get(pr.user_id);
  const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
  const headRepo = store.repos.get(pr.head_repo_id);
  const baseRepo = store.repos.get(pr.base_repo_id);

  const labels = pr.label_ids
    .map((id) => store.labels.get(id))
    .filter(Boolean)
    .map((l) => formatLabel(l!, repo, baseUrl));

  const assignees = pr.assignee_ids
    .map((id) => store.users.get(id))
    .filter(Boolean)
    .map((u) => formatUser(u!, baseUrl));

  const requestedReviewers = pr.requested_reviewer_ids
    .map((id) => store.users.get(id))
    .filter(Boolean)
    .map((u) => formatUser(u!, baseUrl));

  const requestedTeams = pr.requested_team_ids
    .map((id) => store.teams.get(id))
    .filter(Boolean)
    .map((t) => formatTeamBrief(t!, store, baseUrl));

  const milestone = pr.milestone_id ? store.milestones.get(pr.milestone_id) : null;
  const mergedBy = pr.merged_by_id ? store.users.get(pr.merged_by_id) : null;

  return {
    url: `${repoUrl}/pulls/${pr.number}`,
    id: pr.id,
    node_id: pr.node_id,
    html_url: `${baseUrl}/${repo.full_name}/pull/${pr.number}`,
    diff_url: `${baseUrl}/${repo.full_name}/pull/${pr.number}.diff`,
    patch_url: `${baseUrl}/${repo.full_name}/pull/${pr.number}.patch`,
    issue_url: `${repoUrl}/issues/${pr.number}`,
    number: pr.number,
    state: pr.state,
    locked: pr.locked,
    title: pr.title,
    user: user ? formatUser(user, baseUrl) : null,
    body: pr.body,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    closed_at: pr.closed_at,
    merged_at: pr.merged_at,
    merge_commit_sha: pr.merge_commit_sha,
    assignee: assignees[0] ?? null,
    assignees,
    requested_reviewers: requestedReviewers,
    requested_teams: requestedTeams,
    labels,
    milestone: milestone ? formatMilestone(milestone, repo, store, baseUrl) : null,
    draft: pr.draft,
    commits_url: `${repoUrl}/pulls/${pr.number}/commits`,
    review_comments_url: `${repoUrl}/pulls/${pr.number}/comments`,
    review_comment_url: `${repoUrl}/pulls/comments{/number}`,
    comments_url: `${repoUrl}/issues/${pr.number}/comments`,
    statuses_url: `${repoUrl}/statuses/${pr.head_sha}`,
    head: {
      label: `${headRepo?.full_name?.split("/")[0] ?? "unknown"}:${pr.head_ref}`,
      ref: pr.head_ref,
      sha: pr.head_sha,
      user: headRepo ? formatOwner(store, headRepo.owner_id, headRepo.owner_type, baseUrl) : null,
      repo: headRepo ? formatRepo(headRepo, store, baseUrl) : null,
    },
    base: {
      label: `${baseRepo?.full_name?.split("/")[0] ?? "unknown"}:${pr.base_ref}`,
      ref: pr.base_ref,
      sha: pr.base_sha,
      user: baseRepo ? formatOwner(store, baseRepo.owner_id, baseRepo.owner_type, baseUrl) : null,
      repo: baseRepo ? formatRepo(baseRepo, store, baseUrl) : null,
    },
    _links: {
      self: { href: `${repoUrl}/pulls/${pr.number}` },
      html: { href: `${baseUrl}/${repo.full_name}/pull/${pr.number}` },
      issue: { href: `${repoUrl}/issues/${pr.number}` },
      comments: { href: `${repoUrl}/issues/${pr.number}/comments` },
      review_comments: { href: `${repoUrl}/pulls/${pr.number}/comments` },
      review_comment: { href: `${repoUrl}/pulls/comments{/number}` },
      commits: { href: `${repoUrl}/pulls/${pr.number}/commits` },
      statuses: { href: `${repoUrl}/statuses/${pr.head_sha}` },
    },
    author_association: computeAuthorAssociation(store, pr.user_id, pr.repo_id),
    auto_merge: pr.auto_merge,
    merged: pr.merged,
    mergeable: pr.mergeable,
    rebaseable: true,
    mergeable_state: pr.mergeable_state,
    merged_by: mergedBy ? formatUser(mergedBy, baseUrl) : null,
    comments: pr.comments,
    review_comments: pr.review_comments,
    maintainer_can_modify: true,
    commits: pr.commits,
    additions: pr.additions,
    deletions: pr.deletions,
    changed_files: pr.changed_files,
  };
}

export function formatLabel(label: GitHubLabel, repo: GitHubRepo, baseUrl: string) {
  return {
    id: label.id,
    node_id: label.node_id,
    url: `${baseUrl}/repos/${repo.full_name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    description: label.description,
    color: label.color,
    default: label.default,
  };
}

export function formatMilestone(
  m: GitHubMilestone,
  repo: GitHubRepo,
  store: GitHubStore,
  baseUrl: string
) {
  const creator = store.users.get(m.creator_id);
  return {
    url: `${baseUrl}/repos/${repo.full_name}/milestones/${m.number}`,
    html_url: `${baseUrl}/${repo.full_name}/milestone/${m.number}`,
    labels_url: `${baseUrl}/repos/${repo.full_name}/milestones/${m.number}/labels`,
    id: m.id,
    node_id: m.node_id,
    number: m.number,
    title: m.title,
    description: m.description,
    creator: creator ? formatUser(creator, baseUrl) : null,
    open_issues: m.open_issues,
    closed_issues: m.closed_issues,
    state: m.state,
    created_at: m.created_at,
    updated_at: m.updated_at,
    due_on: m.due_on,
    closed_at: m.closed_at,
  };
}

export function formatComment(
  comment: GitHubComment,
  store: GitHubStore,
  baseUrl: string
) {
  const repo = store.repos.get(comment.repo_id);
  if (!repo) return null;
  const user = store.users.get(comment.user_id);
  const repoUrl = `${baseUrl}/repos/${repo.full_name}`;

  if (comment.comment_type === "issue") {
    return {
      url: `${repoUrl}/issues/comments/${comment.id}`,
      html_url: `${baseUrl}/${repo.full_name}/issues/${comment.issue_number}#issuecomment-${comment.id}`,
      issue_url: `${repoUrl}/issues/${comment.issue_number}`,
      id: comment.id,
      node_id: comment.node_id,
      user: user ? formatUser(user, baseUrl) : null,
      created_at: comment.created_at,
      updated_at: comment.updated_at,
      author_association: computeAuthorAssociation(store, comment.user_id, comment.repo_id),
      body: comment.body,
      reactions: defaultReactions(`${repoUrl}/issues/comments/${comment.id}`),
      performed_via_github_app: null,
    };
  }

  if (comment.comment_type === "review") {
    return {
      url: `${repoUrl}/pulls/comments/${comment.id}`,
      html_url: `${baseUrl}/${repo.full_name}/pull/${comment.pull_number}#discussion_r${comment.id}`,
      pull_request_url: `${repoUrl}/pulls/${comment.pull_number}`,
      id: comment.id,
      node_id: comment.node_id,
      diff_hunk: "",
      path: comment.path ?? "",
      position: comment.position,
      original_position: comment.position,
      commit_id: comment.commit_sha ?? "",
      original_commit_id: comment.commit_sha ?? "",
      in_reply_to_id: comment.in_reply_to_id,
      user: user ? formatUser(user, baseUrl) : null,
      body: comment.body,
      created_at: comment.created_at,
      updated_at: comment.updated_at,
      author_association: computeAuthorAssociation(store, comment.user_id, comment.repo_id),
      reactions: defaultReactions(`${repoUrl}/pulls/comments/${comment.id}`),
      line: comment.line,
      side: comment.side ?? "RIGHT",
      subject_type: comment.subject_type ?? "line",
      pull_request_review_id: comment.review_id,
    };
  }

  return {
    url: `${repoUrl}/comments/${comment.id}`,
    html_url: `${baseUrl}/${repo.full_name}/commit/${comment.commit_sha}#commitcomment-${comment.id}`,
    id: comment.id,
    node_id: comment.node_id,
    user: user ? formatUser(user, baseUrl) : null,
    body: comment.body,
    path: comment.path,
    position: comment.position,
    line: comment.line,
    commit_id: comment.commit_sha,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    author_association: computeAuthorAssociation(store, comment.user_id, comment.repo_id),
    reactions: defaultReactions(`${repoUrl}/comments/${comment.id}`),
  };
}

export function formatReview(
  review: GitHubReview,
  store: GitHubStore,
  baseUrl: string
) {
  const repo = store.repos.get(review.repo_id);
  if (!repo) return null;
  const user = store.users.get(review.user_id);
  const repoUrl = `${baseUrl}/repos/${repo.full_name}`;

  return {
    id: review.id,
    node_id: review.node_id,
    user: user ? formatUser(user, baseUrl) : null,
    body: review.body ?? "",
    state: review.state,
    html_url: `${baseUrl}/${repo.full_name}/pull/${review.pull_number}#pullrequestreview-${review.id}`,
    pull_request_url: `${repoUrl}/pulls/${review.pull_number}`,
    _links: {
      html: { href: `${baseUrl}/${repo.full_name}/pull/${review.pull_number}#pullrequestreview-${review.id}` },
      pull_request: { href: `${repoUrl}/pulls/${review.pull_number}` },
    },
    submitted_at: review.submitted_at,
    commit_id: review.commit_id,
    author_association: computeAuthorAssociation(store, review.user_id, review.repo_id),
    created_at: review.created_at,
    updated_at: review.updated_at,
  };
}

export function formatTeamBrief(team: GitHubTeam, store: GitHubStore, baseUrl: string) {
  const org = store.orgs.get(team.org_id);
  return {
    id: team.id,
    node_id: team.node_id,
    url: `${baseUrl}/teams/${team.id}`,
    html_url: `${baseUrl}/orgs/${org?.login}/teams/${team.slug}`,
    name: team.name,
    slug: team.slug,
    description: team.description,
    privacy: team.privacy,
    permission: team.permission,
    members_url: `${baseUrl}/teams/${team.id}/members{/member}`,
    repositories_url: `${baseUrl}/teams/${team.id}/repos`,
  };
}

export function formatBranch(branch: GitHubBranch, repo: GitHubRepo, baseUrl: string) {
  const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
  return {
    name: branch.name,
    commit: {
      sha: branch.sha,
      url: `${repoUrl}/commits/${branch.sha}`,
    },
    protected: branch.protected,
    protection_url: `${repoUrl}/branches/${branch.name}/protection`,
  };
}

export function formatRelease(
  release: GitHubRelease,
  store: GitHubStore,
  baseUrl: string
) {
  const repo = store.repos.get(release.repo_id);
  if (!repo) return null;
  const author = store.users.get(release.author_id);
  const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
  const assets = store.releaseAssets.findBy("release_id", release.id);

  return {
    url: `${repoUrl}/releases/${release.id}`,
    html_url: `${baseUrl}/${repo.full_name}/releases/tag/${release.tag_name}`,
    assets_url: `${repoUrl}/releases/${release.id}/assets`,
    upload_url: `${repoUrl}/releases/${release.id}/assets{?name,label}`,
    tarball_url: `${repoUrl}/tarball/${release.tag_name}`,
    zipball_url: `${repoUrl}/zipball/${release.tag_name}`,
    id: release.id,
    node_id: release.node_id,
    tag_name: release.tag_name,
    target_commitish: release.target_commitish,
    name: release.name,
    draft: release.draft,
    prerelease: release.prerelease,
    created_at: release.created_at,
    published_at: release.published_at,
    author: author ? formatUser(author, baseUrl) : null,
    assets: assets.map((a) => formatReleaseAsset(a, repo, baseUrl)),
    body: release.body,
  };
}

export function formatReleaseAsset(asset: GitHubReleaseAsset, repo: GitHubRepo, baseUrl: string) {
  const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
  const uploader = null;
  return {
    url: `${repoUrl}/releases/assets/${asset.id}`,
    id: asset.id,
    node_id: asset.node_id,
    name: asset.name,
    label: asset.label,
    uploader,
    content_type: asset.content_type,
    state: asset.state,
    size: asset.size,
    download_count: asset.download_count,
    created_at: asset.created_at,
    updated_at: asset.updated_at,
    browser_download_url: `${baseUrl}/${repo.full_name}/releases/download/${asset.name}`,
  };
}

export function formatWebhook(wh: GitHubWebhook, baseUrl: string, ownerPath: string) {
  const pathPrefix = wh.repo_id != null ? `repos/${ownerPath}` : `orgs/${ownerPath}`;
  return {
    type: wh.repo_id ? "Repository" : "Organization",
    id: wh.id,
    name: wh.name,
    active: wh.active,
    events: wh.events,
    config: {
      content_type: wh.config.content_type,
      insecure_ssl: wh.config.insecure_ssl,
      url: wh.config.url,
    },
    updated_at: wh.updated_at,
    created_at: wh.created_at,
    url: `${baseUrl}/${pathPrefix}/hooks/${wh.id}`,
    test_url: `${baseUrl}/${pathPrefix}/hooks/${wh.id}/tests`,
    ping_url: `${baseUrl}/${pathPrefix}/hooks/${wh.id}/pings`,
    deliveries_url: `${baseUrl}/${pathPrefix}/hooks/${wh.id}/deliveries`,
    last_response: wh.last_response,
  };
}

function defaultReactions(url: string) {
  return {
    url: `${url}/reactions`,
    total_count: 0,
    "+1": 0,
    "-1": 0,
    laugh: 0,
    hooray: 0,
    confused: 0,
    heart: 0,
    rocket: 0,
    eyes: 0,
  };
}

export function lookupRepo(store: GitHubStore, owner: string, repoName: string) {
  const fullName = `${owner}/${repoName}`;
  return store.repos.findOneBy("full_name", fullName);
}

export function lookupOwner(store: GitHubStore, login: string) {
  const user = store.users.findOneBy("login", login);
  if (user) return { type: "User" as const, id: user.id, login: user.login };
  const org = store.orgs.findOneBy("login", login);
  if (org) return { type: "Organization" as const, id: org.id, login: org.login };
  return null;
}

export function getNextIssueNumber(store: GitHubStore, repoId: number): number {
  const issues = store.issues.findBy("repo_id", repoId);
  const prs = store.pullRequests.findBy("repo_id", repoId);
  const maxIssue = issues.reduce((max, i) => Math.max(max, i.number), 0);
  const maxPr = prs.reduce((max, p) => Math.max(max, p.number), 0);
  return Math.max(maxIssue, maxPr) + 1;
}

export function getNextMilestoneNumber(store: GitHubStore, repoId: number): number {
  const milestones = store.milestones.findBy("repo_id", repoId);
  return milestones.reduce((max, m) => Math.max(max, m.number), 0) + 1;
}
