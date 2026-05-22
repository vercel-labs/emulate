export const serviceName = "github";
export const serviceLabel = "GitHub REST, OAuth, and webhooks";
export const runtime = "native-go";

export interface CompatEntity {
  id: number;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export type CompatInsertInput<T extends CompatEntity> = Omit<T, "id" | "created_at" | "updated_at"> & { id?: number };

export interface CompatQueryOptions<T> {
  filter?: (item: T) => boolean;
  sort?: (a: T, b: T) => number;
  page?: number;
  per_page?: number;
}

export interface CompatPaginatedResult<T> {
  items: T[];
  total_count: number;
  page: number;
  per_page: number;
  has_next: boolean;
  has_prev: boolean;
}

export interface CompatCollection<T extends CompatEntity = CompatEntity> {
  readonly fieldNames?: string[];
  insert(data: CompatInsertInput<T>): T;
  get(id: number): T | undefined;
  findBy(field: keyof T, value: T[keyof T] | string | number): T[];
  findOneBy(field: keyof T, value: T[keyof T] | string | number): T | undefined;
  update(id: number, data: Partial<T>): T | undefined;
  delete(id: number): boolean;
  all(): T[];
  query(options?: CompatQueryOptions<T>): CompatPaginatedResult<T>;
  count(filter?: (item: T) => boolean): number;
  clear(): void;
  snapshot(): unknown;
  restore(snapshot: unknown): void;
}

export interface CompatStoreSource {
  collection<T extends CompatEntity>(name: string, indexFields?: string[]): CompatCollection<T>;
}

export interface GitHubUser extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubOrg extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubTeam extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubTeamMember extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubTeamRepo extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubRepo extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubCollaborator extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubIssue extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubPullRequest extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubLabel extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubMilestone extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubComment extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubReview extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubIssueEvent extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubBranch extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubBranchProtection extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubRef extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubCommit extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubTree extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubBlob extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubTag extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubRelease extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubReleaseAsset extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubWebhook extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubWorkflow extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubWorkflowRun extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubJob extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubArtifact extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubSecret extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubCheckAnnotation {
  [key: string]: unknown;
}
export interface GitHubCheckRun extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubCheckSuite extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubOAuthApp extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubApp extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubAppInstallation extends CompatEntity {
  [key: string]: unknown;
}
export interface GitHubOAuthGrant extends CompatEntity {
  [key: string]: unknown;
}

export interface GitHubSeedConfig {
  [key: string]: unknown;
}

export interface GitHubStore {
  users: CompatCollection<GitHubUser>;
  orgs: CompatCollection<GitHubOrg>;
  teams: CompatCollection<GitHubTeam>;
  teamMembers: CompatCollection<GitHubTeamMember>;
  teamRepos: CompatCollection<GitHubTeamRepo>;
  repos: CompatCollection<GitHubRepo>;
  collaborators: CompatCollection<GitHubCollaborator>;
  issues: CompatCollection<GitHubIssue>;
  pullRequests: CompatCollection<GitHubPullRequest>;
  labels: CompatCollection<GitHubLabel>;
  milestones: CompatCollection<GitHubMilestone>;
  comments: CompatCollection<GitHubComment>;
  reviews: CompatCollection<GitHubReview>;
  issueEvents: CompatCollection<GitHubIssueEvent>;
  branches: CompatCollection<GitHubBranch>;
  branchProtections: CompatCollection<GitHubBranchProtection>;
  refs: CompatCollection<GitHubRef>;
  commits: CompatCollection<GitHubCommit>;
  trees: CompatCollection<GitHubTree>;
  blobs: CompatCollection<GitHubBlob>;
  tags: CompatCollection<GitHubTag>;
  releases: CompatCollection<GitHubRelease>;
  releaseAssets: CompatCollection<GitHubReleaseAsset>;
  webhooks: CompatCollection<GitHubWebhook>;
  workflows: CompatCollection<GitHubWorkflow>;
  workflowRuns: CompatCollection<GitHubWorkflowRun>;
  jobs: CompatCollection<GitHubJob>;
  artifacts: CompatCollection<GitHubArtifact>;
  secrets: CompatCollection<GitHubSecret>;
  checkRuns: CompatCollection<GitHubCheckRun>;
  checkSuites: CompatCollection<GitHubCheckSuite>;
  oauthApps: CompatCollection<GitHubOAuthApp>;
  apps: CompatCollection<GitHubApp>;
  appInstallations: CompatCollection<GitHubAppInstallation>;
  oauthGrants: CompatCollection<GitHubOAuthGrant>;
}

function compatCollection<T extends CompatEntity>(
  store: CompatStoreSource,
  name: string,
  indexFields: string[],
): CompatCollection<T> {
  return store.collection<T>(name, indexFields);
}

export function getGitHubStore(store: CompatStoreSource): GitHubStore {
  return {
    users: compatCollection<GitHubUser>(store, "github.users", ["login"]),
    orgs: compatCollection<GitHubOrg>(store, "github.orgs", ["login"]),
    teams: compatCollection<GitHubTeam>(store, "github.teams", ["org_id", "slug"]),
    teamMembers: compatCollection<GitHubTeamMember>(store, "github.team_members", ["team_id", "user_id"]),
    teamRepos: compatCollection<GitHubTeamRepo>(store, "github.team_repos", ["team_id", "repo_id"]),
    repos: compatCollection<GitHubRepo>(store, "github.repos", ["owner_id", "full_name"]),
    collaborators: compatCollection<GitHubCollaborator>(store, "github.collaborators", ["repo_id", "user_id"]),
    issues: compatCollection<GitHubIssue>(store, "github.issues", ["repo_id", "number"]),
    pullRequests: compatCollection<GitHubPullRequest>(store, "github.pull_requests", ["repo_id", "number"]),
    labels: compatCollection<GitHubLabel>(store, "github.labels", ["repo_id"]),
    milestones: compatCollection<GitHubMilestone>(store, "github.milestones", ["repo_id", "number"]),
    comments: compatCollection<GitHubComment>(store, "github.comments", ["repo_id"]),
    reviews: compatCollection<GitHubReview>(store, "github.reviews", ["repo_id", "pull_number"]),
    issueEvents: compatCollection<GitHubIssueEvent>(store, "github.issue_events", ["repo_id", "issue_number"]),
    branches: compatCollection<GitHubBranch>(store, "github.branches", ["repo_id"]),
    branchProtections: compatCollection<GitHubBranchProtection>(store, "github.branch_protections", ["repo_id"]),
    refs: compatCollection<GitHubRef>(store, "github.refs", ["repo_id"]),
    commits: compatCollection<GitHubCommit>(store, "github.commits", ["repo_id", "sha"]),
    trees: compatCollection<GitHubTree>(store, "github.trees", ["repo_id", "sha"]),
    blobs: compatCollection<GitHubBlob>(store, "github.blobs", ["repo_id", "sha"]),
    tags: compatCollection<GitHubTag>(store, "github.tags", ["repo_id"]),
    releases: compatCollection<GitHubRelease>(store, "github.releases", ["repo_id"]),
    releaseAssets: compatCollection<GitHubReleaseAsset>(store, "github.release_assets", ["release_id", "repo_id"]),
    webhooks: compatCollection<GitHubWebhook>(store, "github.webhooks", ["repo_id", "org_id"]),
    workflows: compatCollection<GitHubWorkflow>(store, "github.workflows", ["repo_id"]),
    workflowRuns: compatCollection<GitHubWorkflowRun>(store, "github.workflow_runs", ["repo_id", "workflow_id"]),
    jobs: compatCollection<GitHubJob>(store, "github.jobs", ["run_id"]),
    artifacts: compatCollection<GitHubArtifact>(store, "github.artifacts", ["run_id", "repo_id"]),
    secrets: compatCollection<GitHubSecret>(store, "github.secrets", ["repo_id", "org_id"]),
    checkRuns: compatCollection<GitHubCheckRun>(store, "github.check_runs", ["repo_id", "head_sha"]),
    checkSuites: compatCollection<GitHubCheckSuite>(store, "github.check_suites", ["repo_id", "head_sha"]),
    oauthApps: compatCollection<GitHubOAuthApp>(store, "github.oauth_apps", ["client_id"]),
    apps: compatCollection<GitHubApp>(store, "github.apps", ["slug"]),
    appInstallations: compatCollection<GitHubAppInstallation>(store, "github.app_installations", [
      "app_id",
      "installation_id",
    ]),
    oauthGrants: compatCollection<GitHubOAuthGrant>(store, "github.oauth_grants", ["user_id", "client_id"]),
  };
}

// Legacy public entity type augmentations.
export interface GitHubUser extends CompatEntity {
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

export interface GitHubOrg extends CompatEntity {
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

export interface GitHubTeam extends CompatEntity {
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

export interface GitHubTeamMember extends CompatEntity {
  team_id: number;
  user_id: number;
  role: "member" | "maintainer";
}

export interface GitHubTeamRepo extends CompatEntity {
  team_id: number;
  repo_id: number;
}

export interface GitHubRepo extends CompatEntity {
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

export interface GitHubCollaborator extends CompatEntity {
  repo_id: number;
  user_id: number;
  permission: "pull" | "triage" | "push" | "maintain" | "admin";
}

export interface GitHubIssue extends CompatEntity {
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

export interface GitHubPullRequest extends CompatEntity {
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

export interface GitHubLabel extends CompatEntity {
  node_id: string;
  repo_id: number;
  name: string;
  description: string | null;
  color: string;
  default: boolean;
}

export interface GitHubMilestone extends CompatEntity {
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

export interface GitHubComment extends CompatEntity {
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

export interface GitHubReview extends CompatEntity {
  node_id: string;
  repo_id: number;
  pull_number: number;
  user_id: number;
  body: string | null;
  state: "PENDING" | "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
  commit_id: string;
  submitted_at: string | null;
}

export interface GitHubIssueEvent extends CompatEntity {
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

export interface GitHubBranch extends CompatEntity {
  repo_id: number;
  name: string;
  sha: string;
  protected: boolean;
}

export interface GitHubBranchProtection extends CompatEntity {
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

export interface GitHubRef extends CompatEntity {
  repo_id: number;
  ref: string;
  sha: string;
  node_id: string;
}

export interface GitHubCommit extends CompatEntity {
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

export interface GitHubTree extends CompatEntity {
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

export interface GitHubBlob extends CompatEntity {
  repo_id: number;
  sha: string;
  node_id: string;
  content: string;
  encoding: "base64" | "utf-8";
  size: number;
}

export interface GitHubTag extends CompatEntity {
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

export interface GitHubRelease extends CompatEntity {
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

export interface GitHubReleaseAsset extends CompatEntity {
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

export interface GitHubWebhook extends CompatEntity {
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

export interface GitHubWorkflow extends CompatEntity {
  node_id: string;
  repo_id: number;
  name: string;
  path: string;
  state: "active" | "disabled_manually" | "disabled_inactivity";
  badge_url: string;
}

export interface GitHubWorkflowRun extends CompatEntity {
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

export interface GitHubJob extends CompatEntity {
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

export interface GitHubArtifact extends CompatEntity {
  node_id: string;
  repo_id: number;
  run_id: number;
  name: string;
  size_in_bytes: number;
  expired: boolean;
  expires_at: string;
}

export interface GitHubSecret extends CompatEntity {
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

export interface GitHubCheckRun extends CompatEntity {
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

export interface GitHubCheckSuite extends CompatEntity {
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

export interface GitHubOAuthApp extends CompatEntity {
  client_id: string;
  client_secret: string;
  name: string;
  redirect_uris: string[];
}

export interface GitHubApp extends CompatEntity {
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

export interface GitHubAppInstallation extends CompatEntity {
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

export interface GitHubOAuthGrant extends CompatEntity {
  user_id: number;
  oauth_app_id: number;
  client_id: string;
  scopes: string[];
  org_access: Record<string, "granted" | "denied" | "requested">;
}

// Legacy public seed config type augmentations.
export interface GitHubSeedConfig {
  port?: number;
  users?: Array<{
    login: string;
    name?: string;
    email?: string;
    bio?: string;
    company?: string;
    location?: string;
    blog?: string;
    twitter_username?: string;
    site_admin?: boolean;
  }>;
  orgs?: Array<{
    login: string;
    name?: string;
    description?: string;
    email?: string;
  }>;
  tokens?: Record<string, { login: string; scopes?: string[] }>;
  repos?: Array<{
    owner: string;
    name: string;
    description?: string;
    private?: boolean;
    language?: string;
    topics?: string[];
    default_branch?: string;
    auto_init?: boolean;
  }>;
  oauth_apps?: Array<{
    client_id: string;
    client_secret: string;
    name: string;
    redirect_uris: string[];
  }>;
  apps?: Array<{
    app_id: number;
    slug: string;
    name: string;
    private_key: string;
    permissions?: Record<string, string>;
    events?: string[];
    webhook_url?: string;
    webhook_secret?: string;
    description?: string;
    installations?: Array<{
      installation_id: number;
      account: string;
      repository_selection?: "all" | "selected";
      repositories?: string[];
      permissions?: Record<string, string>;
      events?: string[];
    }>;
  }>;
}
export const service = {
  name: serviceName,
  label: serviceLabel,
  runtime,
} as const;

export const plugin = {
  ...service,
  register(): void {
    return undefined;
  },
  seed(): void {
    return undefined;
  },
} as const;

export const githubPlugin = plugin;

export function seedFromConfig(_store?: unknown, _baseUrl?: string, _config?: GitHubSeedConfig): void {
  throw new Error(
    "seedFromConfig is no longer supported by native compatibility facade packages. Pass seed data to createEmulateHandler or createEmulator instead.",
  );
}

export function createAppKeyResolver(): undefined {
  return undefined;
}

export default plugin;
