import { Store, type Collection } from "@emulators/core";
import type {
  Auth0Api,
  Auth0Application,
  Auth0Connection,
  Auth0Organization,
  Auth0OrganizationMembership,
  Auth0Role,
  Auth0RoleAssignment,
  Auth0User,
} from "./entities.js";

export interface Auth0Store {
  users: Collection<Auth0User>;
  roles: Collection<Auth0Role>;
  organizations: Collection<Auth0Organization>;
  applications: Collection<Auth0Application>;
  connections: Collection<Auth0Connection>;
  apis: Collection<Auth0Api>;
  roleAssignments: Collection<Auth0RoleAssignment>;
  organizationMemberships: Collection<Auth0OrganizationMembership>;
}

export function getAuth0Store(store: Store): Auth0Store {
  return {
    users: store.collection<Auth0User>("auth0.users", ["auth0_id", "email"]),
    roles: store.collection<Auth0Role>("auth0.roles", ["role_id", "name"]),
    organizations: store.collection<Auth0Organization>("auth0.organizations", ["org_id", "name"]),
    applications: store.collection<Auth0Application>("auth0.applications", ["client_id", "name"]),
    connections: store.collection<Auth0Connection>("auth0.connections", ["connection_id", "name"]),
    apis: store.collection<Auth0Api>("auth0.apis", ["audience", "name"]),
    roleAssignments: store.collection<Auth0RoleAssignment>("auth0.role_assignments", ["user_auth0_id", "role_id"]),
    organizationMemberships: store.collection<Auth0OrganizationMembership>("auth0.organization_memberships", [
      "org_id",
      "user_auth0_id",
    ]),
  };
}
