import { Store, type Collection } from "@emulators/core";
import type { Auth0User, Auth0Connection, Auth0OAuthClient, Auth0EmailVerificationTicket } from "./entities.js";

export interface Auth0Store {
  users: Collection<Auth0User>;
  connections: Collection<Auth0Connection>;
  oauthClients: Collection<Auth0OAuthClient>;
  emailVerificationTickets: Collection<Auth0EmailVerificationTicket>;
}

export function getAuth0Store(store: Store): Auth0Store {
  return {
    users: store.collection<Auth0User>("auth0.users", ["user_id", "email"]),
    connections: store.collection<Auth0Connection>("auth0.connections", ["name"]),
    oauthClients: store.collection<Auth0OAuthClient>("auth0.oauth_clients", ["client_id"]),
    emailVerificationTickets: store.collection<Auth0EmailVerificationTicket>("auth0.email_verification_tickets", [
      "user_id",
      "ticket_id",
    ]),
  };
}
