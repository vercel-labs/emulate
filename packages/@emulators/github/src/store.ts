import { Store, type Collection } from "@emulators/core";
import type {
  GitHubUser, GitHubOrg, GitHubTeam, GitHubTeamMember, GitHubTeamRepo, GitHubRepo, GitHubCollaborator,
  GitHubIssue, GitHubPullRequest, GitHubLabel, GitHubMilestone, GitHubComment,
  GitHubReview, GitHubIssueEvent, GitHubBranch, GitHubBranchProtection, GitHubRef,
  GitHubCommit, GitHubTree, GitHubBlob, GitHubTag, GitHubRelease, GitHubReleaseAsset,
  GitHubWebhook, GitHubWorkflow, GitHubWorkflowRun, GitHubJob, GitHubArtifact,
  GitHubSecret, GitHubCheckRun, GitHubCheckSuite,
  GitHubOAuthApp, GitHubApp, GitHubAppInstallation, GitHubOAuthGrant,
} from "./entities.js";

export interface GitHubStore {
  users: Collection<GitHubUser>;
  orgs: Collection<GitHubOrg>;
  teams: Collection<GitHubTeam>;
  teamMembers: Collection<GitHubTeamMember>;
  teamRepos: Collection<GitHubTeamRepo>;
  repos: Collection<GitHubRepo>;
  collaborators: Collection<GitHubCollaborator>;
  issues: Collection<GitHubIssue>;
  pullRequests: Collection<GitHubPullRequest>;
  labels: Collection<GitHubLabel>;
  milestones: Collection<GitHubMilestone>;
  comments: Collection<GitHubComment>;
  reviews: Collection<GitHubReview>;
  issueEvents: Collection<GitHubIssueEvent>;
  branches: Collection<GitHubBranch>;
  branchProtections: Collection<GitHubBranchProtection>;
  refs: Collection<GitHubRef>;
  commits: Collection<GitHubCommit>;
  trees: Collection<GitHubTree>;
  blobs: Collection<GitHubBlob>;
  tags: Collection<GitHubTag>;
  releases: Collection<GitHubRelease>;
  releaseAssets: Collection<GitHubReleaseAsset>;
  webhooks: Collection<GitHubWebhook>;
  workflows: Collection<GitHubWorkflow>;
  workflowRuns: Collection<GitHubWorkflowRun>;
  jobs: Collection<GitHubJob>;
  artifacts: Collection<GitHubArtifact>;
  secrets: Collection<GitHubSecret>;
  checkRuns: Collection<GitHubCheckRun>;
  checkSuites: Collection<GitHubCheckSuite>;
  oauthApps: Collection<GitHubOAuthApp>;
  apps: Collection<GitHubApp>;
  appInstallations: Collection<GitHubAppInstallation>;
  oauthGrants: Collection<GitHubOAuthGrant>;
}

export function getGitHubStore(store: Store): GitHubStore {
  return {
    users: store.collection<GitHubUser>("github.users", ["login"]),
    orgs: store.collection<GitHubOrg>("github.orgs", ["login"]),
    teams: store.collection<GitHubTeam>("github.teams", ["org_id", "slug"]),
    teamMembers: store.collection<GitHubTeamMember>("github.team_members", ["team_id", "user_id"]),
    teamRepos: store.collection<GitHubTeamRepo>("github.team_repos", ["team_id", "repo_id"]),
    repos: store.collection<GitHubRepo>("github.repos", ["owner_id", "full_name"]),
    collaborators: store.collection<GitHubCollaborator>("github.collaborators", ["repo_id", "user_id"]),
    issues: store.collection<GitHubIssue>("github.issues", ["repo_id", "number"]),
    pullRequests: store.collection<GitHubPullRequest>("github.pull_requests", ["repo_id", "number"]),
    labels: store.collection<GitHubLabel>("github.labels", ["repo_id"]),
    milestones: store.collection<GitHubMilestone>("github.milestones", ["repo_id", "number"]),
    comments: store.collection<GitHubComment>("github.comments", ["repo_id"]),
    reviews: store.collection<GitHubReview>("github.reviews", ["repo_id", "pull_number"]),
    issueEvents: store.collection<GitHubIssueEvent>("github.issue_events", ["repo_id", "issue_number"]),
    branches: store.collection<GitHubBranch>("github.branches", ["repo_id"]),
    branchProtections: store.collection<GitHubBranchProtection>("github.branch_protections", ["repo_id"]),
    refs: store.collection<GitHubRef>("github.refs", ["repo_id"]),
    commits: store.collection<GitHubCommit>("github.commits", ["repo_id", "sha"]),
    trees: store.collection<GitHubTree>("github.trees", ["repo_id", "sha"]),
    blobs: store.collection<GitHubBlob>("github.blobs", ["repo_id", "sha"]),
    tags: store.collection<GitHubTag>("github.tags", ["repo_id"]),
    releases: store.collection<GitHubRelease>("github.releases", ["repo_id"]),
    releaseAssets: store.collection<GitHubReleaseAsset>("github.release_assets", ["release_id", "repo_id"]),
    webhooks: store.collection<GitHubWebhook>("github.webhooks", ["repo_id", "org_id"]),
    workflows: store.collection<GitHubWorkflow>("github.workflows", ["repo_id"]),
    workflowRuns: store.collection<GitHubWorkflowRun>("github.workflow_runs", ["repo_id", "workflow_id"]),
    jobs: store.collection<GitHubJob>("github.jobs", ["run_id"]),
    artifacts: store.collection<GitHubArtifact>("github.artifacts", ["run_id", "repo_id"]),
    secrets: store.collection<GitHubSecret>("github.secrets", ["repo_id", "org_id"]),
    checkRuns: store.collection<GitHubCheckRun>("github.check_runs", ["repo_id", "head_sha"]),
    checkSuites: store.collection<GitHubCheckSuite>("github.check_suites", ["repo_id", "head_sha"]),
    oauthApps: store.collection<GitHubOAuthApp>("github.oauth_apps", ["client_id"]),
    apps: store.collection<GitHubApp>("github.apps", ["slug"]),
    appInstallations: store.collection<GitHubAppInstallation>("github.app_installations", ["app_id", "installation_id"]),
    oauthGrants: store.collection<GitHubOAuthGrant>("github.oauth_grants", ["user_id", "client_id"]),
  };
}
