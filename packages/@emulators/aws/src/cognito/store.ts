import { type Entity, type Store } from "@emulators/core";

export interface CognitoUserPool extends Entity {
  pool_id: string;
  name: string;
  confirmation_code: string;
}

export interface CognitoClient extends Entity {
  client_id: string;
  pool_id: string;
  client_secret?: string;
  redirect_uris: string[];
  scopes: string[];
}

export interface CognitoUser extends Entity {
  pool_id: string;
  username: string;
  sub: string;
  password_hash: string;
  attributes: Record<string, string>;
  status: "UNCONFIRMED" | "CONFIRMED" | "FORCE_CHANGE_PASSWORD";
  enabled: boolean;
  confirmation_code?: string;
  code_expires_at?: number;
  code_kind?: "signup" | "reset";
}

export interface CognitoSession extends Entity {
  session_id: string;
  refresh_token: string;
  pool_id: string;
  client_id: string;
  username: string;
  scope: string;
  auth_time: number;
  expires_at: number;
}

export interface CognitoChallenge extends Entity {
  token: string;
  pool_id: string;
  client_id: string;
  username: string;
  expires_at: number;
}

export interface CognitoCode extends CognitoChallenge {
  redirect_uri: string;
  scope: string;
  nonce?: string;
  code_challenge?: string;
}

export interface CognitoIdentityPool extends Entity {
  pool_id: string;
  name: string;
  allow_unauthenticated_identities: boolean;
  providers: Array<{ user_pool_id: string; client_id: string }>;
}

export interface CognitoIdentity extends Entity {
  identity_id: string;
  pool_id: string;
  principal?: string;
}

export function getCognitoStore(store: Store) {
  return {
    pools: store.collection<CognitoUserPool>("aws.cognito.user_pools", ["pool_id"]),
    clients: store.collection<CognitoClient>("aws.cognito.clients", ["client_id", "pool_id"]),
    users: store.collection<CognitoUser>("aws.cognito.users", ["pool_id", "username", "sub"]),
    sessions: store.collection<CognitoSession>("aws.cognito.sessions", ["session_id", "refresh_token", "pool_id"]),
    challenges: store.collection<CognitoChallenge>("aws.cognito.challenges", ["token"]),
    codes: store.collection<CognitoCode>("aws.cognito.codes", ["token"]),
    identityPools: store.collection<CognitoIdentityPool>("aws.cognito.identity_pools", ["pool_id"]),
    identities: store.collection<CognitoIdentity>("aws.cognito.identities", ["identity_id", "pool_id"]),
  };
}
