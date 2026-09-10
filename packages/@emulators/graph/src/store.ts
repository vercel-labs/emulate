import { Store, type Collection } from "@emulators/core";
import type {
  GApp,
  GEventLog,
  GGroup,
  GInvitation,
  GRoleAssignment,
  GRoleDefinition,
  GTenant,
  GToken,
  GUser,
} from "./entities.js";

export interface GStore {
  raw: Store;
  tenants: Collection<GTenant>;
  apps: Collection<GApp>;
  tokens: Collection<GToken>;
  users: Collection<GUser>;
  groups: Collection<GGroup>;
  roleDefinitions: Collection<GRoleDefinition>;
  roleAssignments: Collection<GRoleAssignment>;
  invitations: Collection<GInvitation>;
  events: Collection<GEventLog>;
}

export function getGStore(store: Store): GStore {
  return {
    raw: store,
    tenants: store.collection<GTenant>("graph.tenants", ["tenant_id", "domain"]),
    apps: store.collection<GApp>("graph.apps", ["client_id"]),
    tokens: store.collection<GToken>("graph.tokens", ["token", "tenant_id"]),
    users: store.collection<GUser>("graph.users", ["tenant_id", "object_id", "userPrincipalName", "mail"]),
    groups: store.collection<GGroup>("graph.groups", ["tenant_id", "object_id"]),
    roleDefinitions: store.collection<GRoleDefinition>("graph.role_definitions", ["role_id", "templateId"]),
    roleAssignments: store.collection<GRoleAssignment>("graph.role_assignments", [
      "tenant_id",
      "assignment_id",
      "principalId",
      "roleDefinitionId",
    ]),
    invitations: store.collection<GInvitation>("graph.invitations", ["tenant_id", "invitation_id", "invited_user_id"]),
    events: store.collection<GEventLog>("graph.events", ["tenant_id", "type"]),
  };
}

export function logEvent(
  gs: GStore,
  tenantId: string,
  type: string,
  subject: string,
  detail: Record<string, unknown>,
): void {
  gs.events.insert({ tenant_id: tenantId, type, subject, detail });
  const all = gs.events.all();
  if (all.length > 1000) for (const stale of all.slice(0, all.length - 1000)) gs.events.delete(stale.id);
}
