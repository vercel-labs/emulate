export const serviceName = "vercel";
export const serviceLabel = "Vercel API";
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

export interface VercelUser extends CompatEntity {
  [key: string]: unknown;
}
export interface VercelTeam extends CompatEntity {
  [key: string]: unknown;
}
export interface VercelTeamMember extends CompatEntity {
  [key: string]: unknown;
}
export interface VercelProject extends CompatEntity {
  [key: string]: unknown;
}
export interface VercelDeployment extends CompatEntity {
  [key: string]: unknown;
}
export interface VercelDeploymentAlias extends CompatEntity {
  [key: string]: unknown;
}
export interface VercelBuild extends CompatEntity {
  [key: string]: unknown;
}
export interface VercelDeploymentEvent extends CompatEntity {
  [key: string]: unknown;
}
export interface VercelFile extends CompatEntity {
  [key: string]: unknown;
}
export interface VercelDeploymentFile extends CompatEntity {
  [key: string]: unknown;
}
export interface VercelDomain extends CompatEntity {
  [key: string]: unknown;
}
export interface VercelEnvVar extends CompatEntity {
  [key: string]: unknown;
}
export interface VercelProtectionBypass extends CompatEntity {
  [key: string]: unknown;
}
export interface VercelApiKey extends CompatEntity {
  [key: string]: unknown;
}
export interface VercelIntegration extends CompatEntity {
  [key: string]: unknown;
}

export interface VercelSeedConfig {
  [key: string]: unknown;
}

export interface VercelStore {
  users: CompatCollection<VercelUser>;
  teams: CompatCollection<VercelTeam>;
  teamMembers: CompatCollection<VercelTeamMember>;
  projects: CompatCollection<VercelProject>;
  deployments: CompatCollection<VercelDeployment>;
  deploymentAliases: CompatCollection<VercelDeploymentAlias>;
  builds: CompatCollection<VercelBuild>;
  deploymentEvents: CompatCollection<VercelDeploymentEvent>;
  files: CompatCollection<VercelFile>;
  deploymentFiles: CompatCollection<VercelDeploymentFile>;
  domains: CompatCollection<VercelDomain>;
  envVars: CompatCollection<VercelEnvVar>;
  protectionBypasses: CompatCollection<VercelProtectionBypass>;
  apiKeys: CompatCollection<VercelApiKey>;
  integrations: CompatCollection<VercelIntegration>;
}

function compatCollection<T extends CompatEntity>(
  store: CompatStoreSource,
  name: string,
  indexFields: string[],
): CompatCollection<T> {
  return store.collection<T>(name, indexFields);
}

export function getVercelStore(store: CompatStoreSource): VercelStore {
  return {
    users: compatCollection<VercelUser>(store, "vercel.users", ["uid", "username"]),
    teams: compatCollection<VercelTeam>(store, "vercel.teams", ["uid", "slug"]),
    teamMembers: compatCollection<VercelTeamMember>(store, "vercel.team_members", ["teamId", "userId"]),
    projects: compatCollection<VercelProject>(store, "vercel.projects", ["uid", "name", "accountId"]),
    deployments: compatCollection<VercelDeployment>(store, "vercel.deployments", ["uid", "projectId", "url"]),
    deploymentAliases: compatCollection<VercelDeploymentAlias>(store, "vercel.deployment_aliases", [
      "deploymentId",
      "projectId",
    ]),
    builds: compatCollection<VercelBuild>(store, "vercel.builds", ["deploymentId"]),
    deploymentEvents: compatCollection<VercelDeploymentEvent>(store, "vercel.deployment_events", ["deploymentId"]),
    files: compatCollection<VercelFile>(store, "vercel.files", ["digest"]),
    deploymentFiles: compatCollection<VercelDeploymentFile>(store, "vercel.deployment_files", ["deploymentId"]),
    domains: compatCollection<VercelDomain>(store, "vercel.domains", ["projectId", "name"]),
    envVars: compatCollection<VercelEnvVar>(store, "vercel.env_vars", ["projectId", "uid"]),
    protectionBypasses: compatCollection<VercelProtectionBypass>(store, "vercel.protection_bypasses", ["projectId"]),
    apiKeys: compatCollection<VercelApiKey>(store, "vercel.api_keys", ["uid", "teamId", "userId"]),
    integrations: compatCollection<VercelIntegration>(store, "vercel.integrations", ["client_id"]),
  };
}

// Legacy public entity type augmentations.
export interface VercelUser extends CompatEntity {
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

export interface VercelTeam extends CompatEntity {
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

export interface VercelTeamMember extends CompatEntity {
  teamId: string;
  userId: string;
  role: "OWNER" | "MEMBER" | "DEVELOPER" | "VIEWER";
  confirmed: boolean;
  joinedFrom: string;
}

export interface VercelProject extends CompatEntity {
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

export interface VercelDeployment extends CompatEntity {
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

export interface VercelDeploymentAlias extends CompatEntity {
  uid: string;
  alias: string;
  deploymentId: string;
  projectId: string;
}

export interface VercelBuild extends CompatEntity {
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

export interface VercelDeploymentEvent extends CompatEntity {
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

export interface VercelFile extends CompatEntity {
  digest: string;
  size: number;
  contentType: string;
}

export interface VercelDeploymentFile extends CompatEntity {
  deploymentId: string;
  name: string;
  type: "file" | "directory" | "symlink" | "lambda" | "middleware";
  uid: string;
  children: string[];
  contentType: string | null;
  mode: number;
  size: number;
}

export interface VercelDomain extends CompatEntity {
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

export interface VercelEnvVar extends CompatEntity {
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

export interface VercelProtectionBypass extends CompatEntity {
  projectId: string;
  secret: string;
  note: string | null;
  scope: string;
  createdBy: string;
}

export interface VercelApiKey extends CompatEntity {
  uid: string;
  name: string;
  teamId: string | null;
  userId: string;
  tokenString: string;
}

export interface VercelIntegration extends CompatEntity {
  client_id: string;
  client_secret: string;
  name: string;
  redirect_uris: string[];
}

// Legacy public seed config type augmentations.
export interface VercelSeedConfig {
  port?: number;
  users?: Array<{
    username: string;
    email?: string;
    name?: string;
  }>;
  teams?: Array<{
    slug: string;
    name?: string;
    description?: string;
  }>;
  projects?: Array<{
    name: string;
    team?: string;
    framework?: string;
    buildCommand?: string;
    outputDirectory?: string;
    rootDirectory?: string;
    nodeVersion?: string;
    envVars?: Array<{
      key: string;
      value: string;
      type?: string;
      target?: string[];
    }>;
  }>;
  integrations?: Array<{
    client_id: string;
    client_secret: string;
    name: string;
    redirect_uris: string[];
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

export const vercelPlugin = plugin;

export function seedFromConfig(_store?: unknown, _baseUrl?: string, _config?: VercelSeedConfig): void {
  throw new Error(
    "seedFromConfig is no longer supported by native compatibility facade packages. Pass seed data to createEmulateHandler or createEmulator instead.",
  );
}

export function createAppKeyResolver(): undefined {
  return undefined;
}

export default plugin;
