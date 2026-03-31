import type { Entity } from "@emulators/core";

export interface GitHubUser extends Entity {
  login: string;
  node_id: string;
  avatar_url: string;
  gravatar_id: string;
  type: "User" | "Organization" | "Bot";
  site_admin: boolean;
  name: string | null;
  company: string | null;
  blog: string;
  location: string | null;
  email: string | null;
  hireable: boolean | null;
  bio: string | null;
  twitter_username: string | null;
  public_repos: number;
  public_gists: number;
  followers: number;
  following: number;
}

export interface GitHubOrg extends Entity {
  login: string;
  node_id: string;
  description: string | null;
  name: string | null;
  company: string | null;
  blog: string;
  location: string | null;
  email: string | null;
  twitter_username: string | null;
  is_verified: boolean;
  has_organization_projects: boolean;
  has_repository_projects: boolean;
  public_repos: number;
  public_gists: number;
  followers: number;
  following: number;
  members_can_create_repositories: boolean;
  default_repository_permission: string;
  billing_email: string | null;
}

export interface GitHubTeam extends Entity {
  node_id: string;
  name: string;
  slug: string;
  description: string | null;
  privacy: "closed" | "secret";
  permission: string;
  org_id: number;
  parent_id: number | null;
  members_count: number;
  repos_count: number;
}

export interface GitHubTeamMember extends Entity {
  team_id: number;
  user_id: number;
  role: "member" | "maintainer";
}

export interface GitHubTeamRepo extends Entity {
  team_id: number;
  repo_id: number;
}

export interface GitHubRepo extends Entity {
  node_id: string;
  name: string;
  full_name: string;
  owner_id: number;
  owner_type: "User" | "Organization";
  private: boolean;
  description: string | null;
  fork: boolean;
  forked_from_id: number | null;
  homepage: string | null;
  language: string | null;
  languages: Record<string, number>;
  forks_count: number;
  stargazers_count: number;
  watchers_count: number;
  size: number;
  default_branch: string;
  open_issues_count: number;
  topics: string[];
  has_issues: boolean;
  has_projects: boolean;
  has_wiki: boolean;
  has_pages: boolean;
  has_downloads: boolean;
  has_discussions: boolean;
  archived: boolean;
  disabled: boolean;
  visibility: "public" | "private" | "internal";
  pushed_at: string | null;
  allow_rebase_merge: boolean;
  allow_squash_merge: boolean;
  allow_merge_commit: boolean;
  allow_auto_merge: boolean;
  delete_branch_on_merge: boolean;
  allow_forking: boolean;
  is_template: boolean;
  license: { key: string; name: string; spdx_id: string } | null;
}

export interface GitHubCollaborator extends Entity {
  repo_id: number;
  user_id: number;
  permission: "pull" | "triage" | "push" | "maintain" | "admin";
}

export interface GitHubIssue extends Entity {
  node_id: string;
  number: number;
  repo_id: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  state_reason: "completed" | "not_planned" | "reopened" | null;
  locked: boolean;
  active_lock_reason: string | null;
  user_id: number;
  assignee_ids: number[];
  label_ids: number[];
  milestone_id: number | null;
  comments: number;
  closed_at: string | null;
  closed_by_id: number | null;
  is_pull_request: boolean;
}

export interface GitHubPullRequest extends Entity {
  node_id: string;
  number: number;
  repo_id: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  locked: boolean;
  user_id: number;
  assignee_ids: number[];
  label_ids: number[];
  milestone_id: number | null;
  head_ref: string;
  head_sha: string;
  head_repo_id: number;
  base_ref: string;
  base_sha: string;
  base_repo_id: number;
  merged: boolean;
  merged_at: string | null;
  merged_by_id: number | null;
  merge_commit_sha: string | null;
  mergeable: boolean | null;
  mergeable_state: string;
  comments: number;
  review_comments: number;
  commits: number;
  additions: number;
  deletions: number;
  changed_files: number;
  draft: boolean;
  requested_reviewer_ids: number[];
  requested_team_ids: number[];
  closed_at: string | null;
  auto_merge: null;
}

export interface GitHubLabel extends Entity {
  node_id: string;
  repo_id: number;
  name: string;
  description: string | null;
  color: string;
  default: boolean;
}

export interface GitHubMilestone extends Entity {
  node_id: string;
  repo_id: number;
  number: number;
  title: string;
  description: string | null;
  state: "open" | "closed";
  open_issues: number;
  closed_issues: number;
  due_on: string | null;
  closed_at: string | null;
  creator_id: number;
}

export interface GitHubComment extends Entity {
  node_id: string;
  repo_id: number;
  issue_number: number | null;
  pull_number: number | null;
  commit_sha: string | null;
  body: string;
  user_id: number;
  in_reply_to_id: number | null;
  path: string | null;
  position: number | null;
  line: number | null;
  side: "LEFT" | "RIGHT" | null;
  subject_type: "line" | "file" | null;
  comment_type: "issue" | "review" | "commit";
  /** Set for line comments created as part of a pull request review. */
  review_id: number | null;
}

export interface GitHubReview extends Entity {
  node_id: string;
  repo_id: number;
  pull_number: number;
  user_id: number;
  body: string | null;
  state: "PENDING" | "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
  commit_id: string;
  submitted_at: string | null;
}

export interface GitHubIssueEvent extends Entity {
  node_id: string;
  repo_id: number;
  issue_number: number;
  event: string;
  actor_id: number;
  commit_id: string | null;
  commit_url: string | null;
  label_name: string | null;
  assignee_id: number | null;
  milestone_title: string | null;
  rename: { from: string; to: string } | null;
}

export interface GitHubBranch extends Entity {
  repo_id: number;
  name: string;
  sha: string;
  protected: boolean;
}

export interface GitHubBranchProtection extends Entity {
  repo_id: number;
  branch_name: string;
  required_status_checks: {
    strict: boolean;
    contexts: string[];
  } | null;
  enforce_admins: boolean;
  required_pull_request_reviews: {
    required_approving_review_count: number;
    dismiss_stale_reviews: boolean;
    require_code_owner_reviews: boolean;
  } | null;
  restrictions: {
    users: string[];
    teams: string[];
  } | null;
  required_linear_history: boolean;
  allow_force_pushes: boolean;
  allow_deletions: boolean;
  required_signatures: boolean;
}

export interface GitHubRef extends Entity {
  repo_id: number;
  ref: string;
  sha: string;
  node_id: string;
}

export interface GitHubCommit extends Entity {
  repo_id: number;
  sha: string;
  node_id: string;
  message: string;
  author_name: string;
  author_email: string;
  author_date: string;
  committer_name: string;
  committer_email: string;
  committer_date: string;
  tree_sha: string;
  parent_shas: string[];
  user_id: number | null;
}

export interface GitHubTree extends Entity {
  repo_id: number;
  sha: string;
  node_id: string;
  tree: Array<{
    path: string;
    mode: string;
    type: "blob" | "tree";
    sha: string;
    size?: number;
  }>;
  truncated: boolean;
}

export interface GitHubBlob extends Entity {
  repo_id: number;
  sha: string;
  node_id: string;
  content: string;
  encoding: "base64" | "utf-8";
  size: number;
}

export interface GitHubTag extends Entity {
  repo_id: number;
  tag: string;
  sha: string;
  node_id: string;
  message: string;
  tagger_name: string;
  tagger_email: string;
  tagger_date: string;
  object_type: string;
  object_sha: string;
}

export interface GitHubRelease extends Entity {
  node_id: string;
  repo_id: number;
  tag_name: string;
  target_commitish: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  author_id: number;
  published_at: string | null;
}

export interface GitHubReleaseAsset extends Entity {
  node_id: string;
  release_id: number;
  repo_id: number;
  name: string;
  label: string | null;
  state: "uploaded" | "open";
  content_type: string;
  size: number;
  download_count: number;
  uploader_id: number;
}

export interface GitHubWebhook extends Entity {
  repo_id: number | null;
  org_id: number | null;
  name: string;
  active: boolean;
  events: string[];
  config: {
    url: string;
    content_type: string;
    secret?: string;
    insecure_ssl: string;
  };
  last_response: {
    code: number | null;
    status: string;
    message: string | null;
  };
}

export interface GitHubWorkflow extends Entity {
  node_id: string;
  repo_id: number;
  name: string;
  path: string;
  state: "active" | "disabled_manually" | "disabled_inactivity";
  badge_url: string;
}

export interface GitHubWorkflowRun extends Entity {
  node_id: string;
  repo_id: number;
  workflow_id: number;
  name: string;
  head_branch: string;
  head_sha: string;
  run_number: number;
  event: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required" | null;
  actor_id: number;
  run_attempt: number;
  run_started_at: string;
}

export interface GitHubJob extends Entity {
  node_id: string;
  repo_id: number;
  run_id: number;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required" | null;
  started_at: string | null;
  completed_at: string | null;
  runner_id: number | null;
  runner_name: string | null;
  steps: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    number: number;
    started_at: string | null;
    completed_at: string | null;
  }>;
}

export interface GitHubArtifact extends Entity {
  node_id: string;
  repo_id: number;
  run_id: number;
  name: string;
  size_in_bytes: number;
  expired: boolean;
  expires_at: string;
}

export interface GitHubSecret extends Entity {
  repo_id: number | null;
  org_id: number | null;
  name: string;
  visibility: "all" | "private" | "selected";
}

export interface GitHubCheckAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: string;
  message: string;
}

export interface GitHubCheckRun extends Entity {
  node_id: string;
  repo_id: number;
  head_sha: string;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required" | null;
  started_at: string | null;
  completed_at: string | null;
  external_id: string;
  details_url: string | null;
  actions: { id: string; label: string; description: string }[] | null;
  output: {
    title: string | null;
    summary: string | null;
    text: string | null;
    annotations_count: number;
    annotations: GitHubCheckAnnotation[];
  };
  check_suite_id: number | null;
  app_id: number | null;
}

export interface GitHubCheckSuite extends Entity {
  node_id: string;
  repo_id: number;
  head_branch: string;
  head_sha: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required" | null;
  before: string;
  after: string;
  app_id: number | null;
}

export interface GitHubOAuthApp extends Entity {
  client_id: string;
  client_secret: string;
  name: string;
  redirect_uris: string[];
}

export interface GitHubApp extends Entity {
  app_id: number;
  slug: string;
  name: string;
  private_key: string;
  permissions: Record<string, string>;
  events: string[];
  webhook_url: string | null;
  webhook_secret: string | null;
  description: string | null;
}

export interface GitHubAppInstallation extends Entity {
  installation_id: number;
  app_id: number;
  account_type: "User" | "Organization";
  account_id: number;
  account_login: string;
  repository_selection: "all" | "selected";
  repository_ids: number[];
  permissions: Record<string, string>;
  events: string[];
  suspended_at: string | null;
}

export interface GitHubOAuthGrant extends Entity {
  user_id: number;
  oauth_app_id: number;
  client_id: string;
  scopes: string[];
  org_access: Record<string, "granted" | "denied" | "requested">;
}
