import type { GGroup, GInvitation, GRoleAssignment, GRoleDefinition, GTenant, GUser } from "./entities.js";
import type { Json } from "./helpers.js";
import type { GStore } from "./store.js";

export interface Fmt {
  gs: GStore;
  baseUrl: string;
}

export function formatUser(u: GUser): Json {
  return {
    id: u.object_id,
    displayName: u.displayName,
    givenName: u.givenName,
    surname: u.surname,
    mail: u.mail,
    userPrincipalName: u.userPrincipalName,
    mailNickname: u.mailNickname,
    jobTitle: u.jobTitle,
    mobilePhone: u.mobilePhone,
    officeLocation: u.officeLocation,
    preferredLanguage: u.preferredLanguage,
    businessPhones: u.businessPhones,
    accountEnabled: u.accountEnabled,
    userType: u.userType,
    externalUserState: u.externalUserState,
    externalUserStateChangeDateTime: u.externalUserStateChangeDateTime,
    department: u.department,
    companyName: u.companyName,
    usageLocation: u.usageLocation,
    otherMails: u.otherMails,
    proxyAddresses: u.proxyAddresses,
    createdDateTime: u.createdDateTime,
    deletedDateTime: u.deletedDateTime,
    identities: [
      {
        signInType: u.userType === "Guest" ? "federated" : "userPrincipalName",
        issuer: u.userType === "Guest" ? "ExternalAzureAD" : u.userPrincipalName.split("@")[1],
        issuerAssignedId: u.userType === "Guest" ? u.mail : u.userPrincipalName,
      },
    ],
    onPremisesSyncEnabled: null,
    passwordPolicies: u.userType === "Guest" ? null : "None",
  };
}

export function formatGroup(g: GGroup): Json {
  return {
    id: g.object_id,
    displayName: g.displayName,
    description: g.description,
    mail: g.mail,
    mailNickname: g.mailNickname,
    mailEnabled: g.mailEnabled,
    securityEnabled: g.securityEnabled,
    groupTypes: g.groupTypes,
    visibility: g.visibility,
    createdDateTime: g.created_at,
    renewedDateTime: g.created_at,
    deletedDateTime: null,
    membershipRule: null,
    membershipRuleProcessingState: null,
    onPremisesSyncEnabled: null,
    proxyAddresses: g.mail ? [`SMTP:${g.mail}`] : [],
  };
}

export function formatRoleDefinition(r: GRoleDefinition): Json {
  return {
    id: r.role_id,
    templateId: r.templateId,
    displayName: r.displayName,
    description: r.description,
    isBuiltIn: r.isBuiltIn,
    isEnabled: r.isEnabled,
    resourceScopes: r.resourceScopes,
    version: "1",
    rolePermissions: [{ allowedResourceActions: r.allowedActions, condition: null }],
    inheritsPermissionsFrom: [],
  };
}

export function formatRoleAssignment(a: GRoleAssignment): Json {
  return {
    id: a.assignment_id,
    principalId: a.principalId,
    roleDefinitionId: a.roleDefinitionId,
    directoryScopeId: a.directoryScopeId,
    appScopeId: a.appScopeId,
  };
}

export function formatInvitation(f: Fmt, i: GInvitation): Json {
  const user = f.gs.users.findOneBy("object_id", i.invited_user_id);
  return {
    id: i.invitation_id,
    inviteRedeemUrl: i.inviteRedeemUrl,
    invitedUserDisplayName: i.invitedUserDisplayName,
    invitedUserType: i.invitedUserType,
    invitedUserEmailAddress: i.invitedUserEmailAddress,
    sendInvitationMessage: i.sendInvitationMessage,
    resetRedemption: i.resetRedemption,
    inviteRedirectUrl: i.inviteRedirectUrl,
    status: i.status,
    invitedUserMessageInfo: {
      messageLanguage: i.message_language,
      customizedMessageBody: i.custom_message,
      ccRecipients: i.cc_recipients.map((address) => ({ emailAddress: { address, name: null } })),
    },
    invitedUser: user ? { id: user.object_id, userPrincipalName: user.userPrincipalName } : { id: i.invited_user_id },
  };
}

export function formatOrganization(t: GTenant): Json {
  return {
    id: t.tenant_id,
    displayName: t.display_name,
    verifiedDomains: t.verified_domains.map((name, index) => ({
      name,
      isDefault: index === 0,
      isInitial: name.endsWith(".onmicrosoft.com"),
      type: "Managed",
      capabilities: "Email, OfficeCommunicationsOnline",
    })),
    countryLetterCode: t.country,
    tenantType: "AAD",
    createdDateTime: t.created_at,
    assignedPlans: [],
    provisionedPlans: [],
    businessPhones: [],
    technicalNotificationMails: [],
    onPremisesSyncEnabled: null,
  };
}
