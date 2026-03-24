import { Store, type Collection } from "@internal/core";
import type { GoogleUser, GoogleOAuthClient, GoogleMessage, GoogleLabel } from "./entities.js";

export interface GoogleStore {
  users: Collection<GoogleUser>;
  oauthClients: Collection<GoogleOAuthClient>;
  messages: Collection<GoogleMessage>;
  labels: Collection<GoogleLabel>;
}

export function getGoogleStore(store: Store): GoogleStore {
  return {
    users: store.collection<GoogleUser>("google.users", ["uid", "email"]),
    oauthClients: store.collection<GoogleOAuthClient>("google.oauth_clients", ["client_id"]),
    messages: store.collection<GoogleMessage>("google.messages", ["gmail_id", "thread_id", "user_email"]),
    labels: store.collection<GoogleLabel>("google.labels", ["gmail_id", "user_email", "name"]),
  };
}
