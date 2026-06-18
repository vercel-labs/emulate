import { Store, type Collection } from "@emulators/core";
import type {
  LinearAgentActivity,
  LinearAgentSession,
  LinearComment,
  LinearCycle,
  LinearIssue,
  LinearIssueLabel,
  LinearOAuthApp,
  LinearOrganization,
  LinearProject,
  LinearTeam,
  LinearToken,
  LinearUser,
  LinearWebhook,
  LinearWebhookDelivery,
  LinearWorkflowState,
} from "./entities.js";

export interface LinearStore {
  organizations: Collection<LinearOrganization>;
  users: Collection<LinearUser>;
  teams: Collection<LinearTeam>;
  workflowStates: Collection<LinearWorkflowState>;
  issueLabels: Collection<LinearIssueLabel>;
  projects: Collection<LinearProject>;
  cycles: Collection<LinearCycle>;
  issues: Collection<LinearIssue>;
  comments: Collection<LinearComment>;
  oauthApps: Collection<LinearOAuthApp>;
  tokens: Collection<LinearToken>;
  webhooks: Collection<LinearWebhook>;
  webhookDeliveries: Collection<LinearWebhookDelivery>;
  agentSessions: Collection<LinearAgentSession>;
  agentActivities: Collection<LinearAgentActivity>;
}

export function getLinearStore(store: Store): LinearStore {
  return {
    organizations: store.collection<LinearOrganization>("linear.organizations", ["linear_id", "url_key"]),
    users: store.collection<LinearUser>("linear.users", ["linear_id", "email"]),
    teams: store.collection<LinearTeam>("linear.teams", ["linear_id", "key"]),
    workflowStates: store.collection<LinearWorkflowState>("linear.workflow_states", ["linear_id", "team_id", "name"]),
    issueLabels: store.collection<LinearIssueLabel>("linear.issue_labels", ["linear_id", "team_id", "name"]),
    projects: store.collection<LinearProject>("linear.projects", ["linear_id", "team_id", "name"]),
    cycles: store.collection<LinearCycle>("linear.cycles", ["linear_id", "team_id"]),
    issues: store.collection<LinearIssue>("linear.issues", ["linear_id", "identifier", "team_id", "state_id"]),
    comments: store.collection<LinearComment>("linear.comments", ["linear_id", "issue_id"]),
    oauthApps: store.collection<LinearOAuthApp>("linear.oauth_apps", ["linear_id", "client_id"]),
    tokens: store.collection<LinearToken>("linear.tokens", ["token", "user_id", "app_id"]),
    webhooks: store.collection<LinearWebhook>("linear.webhooks", ["linear_id", "team_id"]),
    webhookDeliveries: store.collection<LinearWebhookDelivery>("linear.webhook_deliveries", [
      "linear_id",
      "webhook_id",
    ]),
    agentSessions: store.collection<LinearAgentSession>("linear.agent_sessions", [
      "linear_id",
      "issue_id",
      "comment_id",
    ]),
    agentActivities: store.collection<LinearAgentActivity>("linear.agent_activities", ["linear_id", "session_id"]),
  };
}
