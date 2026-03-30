import { Store, type Collection } from "@emulators/core";
import type {
  VercelUser, VercelTeam, VercelTeamMember, VercelProject, VercelDeployment,
  VercelDeploymentAlias, VercelBuild, VercelDeploymentEvent, VercelFile,
  VercelDeploymentFile, VercelDomain, VercelEnvVar, VercelProtectionBypass, VercelIntegration, VercelApiKey,
  VercelBlob, VercelBlobMultipartUpload, VercelBlobMultipartPart,
} from "./entities.js";

export interface VercelStore {
  users: Collection<VercelUser>;
  teams: Collection<VercelTeam>;
  teamMembers: Collection<VercelTeamMember>;
  projects: Collection<VercelProject>;
  deployments: Collection<VercelDeployment>;
  deploymentAliases: Collection<VercelDeploymentAlias>;
  builds: Collection<VercelBuild>;
  deploymentEvents: Collection<VercelDeploymentEvent>;
  files: Collection<VercelFile>;
  deploymentFiles: Collection<VercelDeploymentFile>;
  domains: Collection<VercelDomain>;
  envVars: Collection<VercelEnvVar>;
  protectionBypasses: Collection<VercelProtectionBypass>;
  apiKeys: Collection<VercelApiKey>;
  integrations: Collection<VercelIntegration>;
  blobs: Collection<VercelBlob>;
  blobMultipartUploads: Collection<VercelBlobMultipartUpload>;
  blobMultipartParts: Collection<VercelBlobMultipartPart>;
}

export function getVercelStore(store: Store): VercelStore {
  return {
    users: store.collection<VercelUser>("vercel.users", ["uid", "username"]),
    teams: store.collection<VercelTeam>("vercel.teams", ["uid", "slug"]),
    teamMembers: store.collection<VercelTeamMember>("vercel.team_members", ["teamId", "userId"]),
    projects: store.collection<VercelProject>("vercel.projects", ["uid", "name", "accountId"]),
    deployments: store.collection<VercelDeployment>("vercel.deployments", ["uid", "projectId", "url"]),
    deploymentAliases: store.collection<VercelDeploymentAlias>("vercel.deployment_aliases", ["deploymentId", "projectId"]),
    builds: store.collection<VercelBuild>("vercel.builds", ["deploymentId"]),
    deploymentEvents: store.collection<VercelDeploymentEvent>("vercel.deployment_events", ["deploymentId"]),
    files: store.collection<VercelFile>("vercel.files", ["digest"]),
    deploymentFiles: store.collection<VercelDeploymentFile>("vercel.deployment_files", ["deploymentId"]),
    domains: store.collection<VercelDomain>("vercel.domains", ["projectId", "name"]),
    envVars: store.collection<VercelEnvVar>("vercel.env_vars", ["projectId", "uid"]),
    protectionBypasses: store.collection<VercelProtectionBypass>("vercel.protection_bypasses", ["projectId"]),
    apiKeys: store.collection<VercelApiKey>("vercel.api_keys", ["uid", "teamId", "userId"]),
    integrations: store.collection<VercelIntegration>("vercel.integrations", ["client_id"]),
    blobs: store.collection<VercelBlob>("vercel.blobs", ["storeId", "pathname", "url"]),
    blobMultipartUploads: store.collection<VercelBlobMultipartUpload>("vercel.blob_mpu", ["uploadId", "storeId"]),
    blobMultipartParts: store.collection<VercelBlobMultipartPart>("vercel.blob_mpu_parts", ["uploadId", "partNumber"]),
  };
}
