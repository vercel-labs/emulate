import type { Entity } from "@emulators/core";

export interface GTenant extends Entity {
  tenant_id: string;
  display_name: string;
  domain: string;
  verified_domains: string[];
  country: string;
}

export interface GApp extends Entity {
  client_id: string;
  client_secret: string;
  name: string;
  tenant_ids: string[] | null;
  permissions: string[];
}

export interface GToken extends Entity {
  token: string;
  tenant_id: string;
  client_id: string;
  roles: string[];
  expires_at: string;
}

export type UserType = "Member" | "Guest";
export type ExternalUserState = "PendingAcceptance" | "Accepted" | null;

export interface GUser extends Entity {
  tenant_id: string;
  object_id: string;
  displayName: string;
  givenName: string | null;
  surname: string | null;
  mail: string | null;
  userPrincipalName: string;
  mailNickname: string;
  jobTitle: string | null;
  mobilePhone: string | null;
  officeLocation: string | null;
  preferredLanguage: string | null;
  businessPhones: string[];
  accountEnabled: boolean;
  userType: UserType;
  externalUserState: ExternalUserState;
  externalUserStateChangeDateTime: string | null;
  department: string | null;
  companyName: string | null;
  usageLocation: string | null;
  otherMails: string[];
  proxyAddresses: string[];
  createdDateTime: string;
  deleted: boolean;
  deletedDateTime: string | null;
  password_profile: { forceChangePasswordNextSignIn: boolean } | null;
}

export interface GGroup extends Entity {
  tenant_id: string;
  object_id: string;
  displayName: string;
  description: string | null;
  mail: string | null;
  mailNickname: string;
  mailEnabled: boolean;
  securityEnabled: boolean;
  groupTypes: string[];
  visibility: string | null;
  member_ids: string[];
  owner_ids: string[];
}

export interface GRoleDefinition extends Entity {
  role_id: string;
  templateId: string;
  displayName: string;
  description: string;
  isBuiltIn: boolean;
  isEnabled: boolean;
  resourceScopes: string[];
  allowedActions: string[];
}

export interface GRoleAssignment extends Entity {
  tenant_id: string;
  assignment_id: string;
  principalId: string;
  roleDefinitionId: string;
  directoryScopeId: string;
  appScopeId: string | null;
}

export interface GInvitation extends Entity {
  tenant_id: string;
  invitation_id: string;
  invitedUserEmailAddress: string;
  invitedUserDisplayName: string | null;
  invitedUserType: UserType;
  inviteRedirectUrl: string;
  inviteRedeemUrl: string;
  sendInvitationMessage: boolean;
  resetRedemption: boolean;
  status: "PendingAcceptance" | "Completed" | "InProgress" | "Error";
  invited_user_id: string;
  message_language: string | null;
  custom_message: string | null;
  cc_recipients: string[];
}

export interface GEventLog extends Entity {
  tenant_id: string;
  type: string;
  subject: string;
  detail: Record<string, unknown>;
}
