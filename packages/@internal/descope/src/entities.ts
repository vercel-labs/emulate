import type { Entity } from "@internal/core";

export interface DescopeUser extends Entity {
  uid: string;
  email: string;
  name: string;
  given_name: string;
  family_name: string;
  picture: string | null;
  email_verified: boolean;
  locale: string;
  // Extensible for future: roles, permissions, tenants
  permissions?: string[];
  roles?: string[];
  tenants?: Array<{
    tenantId: string;
    tenantName?: string;
  }>;
}

export interface DescopeOAuthClient extends Entity {
  client_id: string;
  client_secret: string;
  name: string;
  redirect_uris: string[];
}

// AuthenticationInfo response format for Descope API
export interface DescopeToken {
  jwt: string;
  expiration: number;
}

export interface DescopeUserResponse {
  userId: string;
  loginIds: string[];
  email: string;
  name: string;
  status: string;
  OAuth?: Record<string, boolean>;
  permissions?: string[];
  roleNames?: string[];
  userTenants?: Array<{
    tenantId: string;
    tenantName?: string;
    roleNames?: string[];
  }>;
}

export interface AuthenticationInfo {
  sessionToken: DescopeToken;
  refreshToken: DescopeToken;
  user: DescopeUserResponse;
  firstSeen: boolean;
}

// Request/Response types for proprietary API
export interface OAuthAuthorizeRequest {
  provider: string;
  redirectUrl?: string;
  loginHint?: string;
}

export interface OAuthAuthorizeResponse {
  url: string;
  errorId?: string;
}

export interface OAuthExchangeRequest {
  code: string;
}

// Pending authorization for internal tracking
export interface PendingOAuthAuthorization {
  code: string;
  projectId: string;
  provider: string;
  redirectUrl: string;
  loginHint?: string;
  email: string;
  createdAt: number;
}
