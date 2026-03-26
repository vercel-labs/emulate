import type { Entity } from "@emulators/core";

export interface VercelUser extends Entity {
  uid: string;
  email: string;
  username: string;
  name: string | null;
  avatar: string | null;
  defaultTeamId: string | null;
  softBlock: null;
  billing: {
    plan: string;
    period: null;
    trial: null;
    cancelation: null;
    addons: null;
  };
  resourceConfig: {
    nodeType: string;
    concurrentBuilds: number;
  };
  stagingPrefix: string;
  version: string | null;
}

export interface VercelTeam extends Entity {
  uid: string;
  slug: string;
  name: string;
  avatar: string | null;
  description: string | null;
  creatorId: string;
  membership: {
    confirmed: boolean;
    role: "OWNER" | "MEMBER" | "DEVELOPER" | "VIEWER";
  };
  billing: {
    plan: string;
    period: null;
    trial: null;
    cancelation: null;
    addons: null;
  };
  resourceConfig: {
    nodeType: string;
    concurrentBuilds: number;
  };
  stagingPrefix: string;
}

export interface VercelTeamMember extends Entity {
  teamId: string;
  userId: string;
  role: "OWNER" | "MEMBER" | "DEVELOPER" | "VIEWER";
  confirmed: boolean;
  joinedFrom: string;
}

export interface VercelProject extends Entity {
  uid: string;
  name: string;
  accountId: string;
  framework: string | null;
  buildCommand: string | null;
  devCommand: string | null;
  installCommand: string | null;
  outputDirectory: string | null;
  rootDirectory: string | null;
  commandForIgnoringBuildStep: string | null;
  nodeVersion: string;
  serverlessFunctionRegion: string | null;
  publicSource: boolean;
  autoAssignCustomDomains: boolean;
  autoAssignCustomDomainsUpdatedBy: string | null;
  gitForkProtection: boolean;
  sourceFilesOutsideRootDirectory: boolean;
  live: boolean;
  link: {
    type: string;
    repo: string;
    repoId: number;
    org: string;
    gitCredentialId: string;
    productionBranch: string;
    createdAt: number;
    updatedAt: number;
    deployHooks: Array<{ id: string; name: string; ref: string; url: string }>;
  } | null;
  latestDeployments: Array<{ id: string; url: string; state: string; createdAt: number }>;
  targets: Record<string, { id: string; url: string; state: string; createdAt: number }>;
  protectionBypass: Record<string, { createdAt: number; createdBy: string; scope: string }>;
  passwordProtection: null;
  ssoProtection: null;
  trustedIps: null;
  connectConfigurationId: string | null;
  gitComments: { onPullRequest: boolean; onCommit: boolean };
  webAnalytics: { id: string } | null;
  speedInsights: { id: string } | null;
  oidcTokenConfig: { enabled: boolean } | null;
  tier: string;
}

export interface VercelDeployment extends Entity {
  uid: string;
  name: string;
  url: string;
  projectId: string;
  source: string;
  target: "production" | "preview" | "staging" | null;
  readyState: "QUEUED" | "BUILDING" | "INITIALIZING" | "READY" | "ERROR" | "CANCELED";
  readySubstate: "STAGED" | "ROLLING" | "PROMOTED" | null;
  state: "QUEUED" | "BUILDING" | "INITIALIZING" | "READY" | "ERROR" | "CANCELED";
  creatorId: string;
  inspectorUrl: string;
  meta: Record<string, string>;
  gitSource: {
    type: string;
    ref: string;
    sha: string;
    repoId: string;
    org: string;
    repo: string;
    message: string;
    authorName: string;
    commitAuthorName: string;
  } | null;
  buildingAt: number | null;
  readyAt: number | null;
  canceledAt: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  regions: string[];
  functions: Record<string, unknown> | null;
  routes: unknown[] | null;
  plan: string;
  aliasAssigned: boolean;
  aliasError: null;
  bootedAt: number | null;
}

export interface VercelDeploymentAlias extends Entity {
  uid: string;
  alias: string;
  deploymentId: string;
  projectId: string;
}

export interface VercelBuild extends Entity {
  uid: string;
  deploymentId: string;
  entrypoint: string;
  readyState: "QUEUED" | "BUILDING" | "READY" | "ERROR";
  output: Array<{
    path: string;
    functionName: string;
    type: string;
    size: number;
  }>;
  readyStateAt: number;
  fingerprint: string;
}

export interface VercelDeploymentEvent extends Entity {
  deploymentId: string;
  type: string;
  payload: {
    text: string;
    statusCode?: number;
    deploymentId?: string;
  };
  date: number;
  serial: string;
}

export interface VercelFile extends Entity {
  digest: string;
  size: number;
  contentType: string;
}

export interface VercelDeploymentFile extends Entity {
  deploymentId: string;
  name: string;
  type: "file" | "directory" | "symlink" | "lambda" | "middleware";
  uid: string;
  children: string[];
  contentType: string | null;
  mode: number;
  size: number;
}

export interface VercelDomain extends Entity {
  uid: string;
  projectId: string;
  name: string;
  apexName: string;
  redirect: string | null;
  redirectStatusCode: 301 | 302 | 307 | 308 | null;
  gitBranch: string | null;
  customEnvironmentId: string | null;
  verified: boolean;
  verification: Array<{
    type: string;
    domain: string;
    value: string;
    reason: string;
  }>;
}

export interface VercelEnvVar extends Entity {
  uid: string;
  projectId: string;
  key: string;
  value: string;
  type: "system" | "encrypted" | "plain" | "secret" | "sensitive";
  target: Array<"production" | "preview" | "development">;
  gitBranch: string | null;
  customEnvironmentIds: string[];
  comment: string | null;
  decrypted: boolean;
}

export interface VercelProtectionBypass extends Entity {
  projectId: string;
  secret: string;
  note: string | null;
  scope: string;
  createdBy: string;
}

export interface VercelApiKey extends Entity {
  uid: string;
  name: string;
  teamId: string | null;
  userId: string;
  tokenString: string;
}

export interface VercelIntegration extends Entity {
  client_id: string;
  client_secret: string;
  name: string;
  redirect_uris: string[];
}
