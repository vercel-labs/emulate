import type { AppEnv, Hono, ServicePlugin, Store, TokenMap, WebhookDispatcher } from "@emulators/core";
import type { UserType } from "./entities.js";
import type { Fmt } from "./formatters.js";
import { guid, shortToken } from "./helpers.js";
import { authRoutes } from "./routes/auth.js";
import { batchRoutes } from "./routes/batch.js";
import { directoryRoutes, inviteUser } from "./routes/directory.js";
import { inspectorRoutes } from "./routes/inspector.js";
import { miscRoutes } from "./routes/misc.js";
import { createUser, userRoutes } from "./routes/users.js";
import { getGStore, logEvent, type GStore } from "./store.js";

export { getGStore, type GStore } from "./store.js";
export * from "./entities.js";
export { parseFilter } from "./odata.js";

export interface GraphSeedUser {
  id?: string;
  displayName: string;
  userPrincipalName?: string;
  mail?: string | null;
  givenName?: string;
  surname?: string;
  jobTitle?: string;
  department?: string;
  accountEnabled?: boolean;
  userType?: UserType;
  externalUserState?: "PendingAcceptance" | "Accepted";
  preferredLanguage?: string;
  mobilePhone?: string;
  officeLocation?: string;
  businessPhones?: string[];
  roles?: string[];
  groups?: string[];
}

export interface GraphSeedTenant {
  id?: string;
  displayName: string;
  domain?: string;
  verifiedDomains?: string[];
  country?: string;
  users?: GraphSeedUser[];
  groups?: Array<{
    id?: string;
    displayName: string;
    mailNickname?: string;
    description?: string;
    securityEnabled?: boolean;
    mailEnabled?: boolean;
  }>;
  invitations?: Array<{
    email: string;
    displayName?: string;
    inviteRedirectUrl?: string;
    status?: "PendingAcceptance" | "Completed";
  }>;
}

export interface GraphSeedConfig {
  port?: number;
  baseUrl?: string;
  apps?: Array<{
    client_id: string;
    client_secret: string;
    name?: string;
    tenant_ids?: string[];
    permissions?: string[];
  }>;
  role_definitions?: Array<{ id?: string; templateId?: string; displayName: string; description?: string }>;
  tenants?: GraphSeedTenant[];
}

export const DEFAULT_CLIENT_ID = "00000000-0000-4000-8000-0000000000a9";
export const DEFAULT_CLIENT_SECRET = "test_emulate_graph_client_secret";
export const DEFAULT_TENANT_ID = "00000000-0000-4000-8000-00000000c0de";
export const DEFAULT_TENANT_NAME = "Contoso";
export const DEFAULT_TENANT_DOMAIN = "contoso.onmicrosoft.com";
export const DEFAULT_SECOND_TENANT_ID = "00000000-0000-4000-8000-00000000fab1";
export const DEFAULT_ADMIN_USER_ID = "10000000-0000-4000-8000-000000000001";
export const DEFAULT_ANALYST_USER_ID = "10000000-0000-4000-8000-000000000002";
export const DEFAULT_GUEST_USER_ID = "10000000-0000-4000-8000-000000000003";
export const DEFAULT_DISABLED_USER_ID = "10000000-0000-4000-8000-000000000004";

export const ROLE_TEMPLATES = {
  globalAdministrator: "62e90394-69f5-4237-9190-012177145e10",
  globalReader: "f2ef992c-3afb-46b9-b7cf-a126ee74c451",
  securityAdministrator: "194ae4cb-b126-40b2-bd5b-6091b380977d",
  securityReader: "5d6b6bb7-de71-4623-b4af-96380a352509",
  securityOperator: "5f2222b1-57c3-48ba-8ad5-d4759f1fde6f",
  privilegedAuthenticationAdministrator: "7be44c8a-adaf-4e2a-84d6-ab2649e08a13",
  privilegedRoleAdministrator: "e8611ab8-c189-46e8-94e1-60213ab1f814",
  userAdministrator: "fe930be7-5e62-47db-91af-98c3a49a38b1",
  helpdeskAdministrator: "729827e3-9c14-49f7-bb1b-9608f156bbb8",
  applicationAdministrator: "9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3",
  exchangeAdministrator: "29232cdf-9323-42fd-ade2-1d097af3e4de",
  directoryReaders: "88d8e3e3-8f55-4a1e-953a-9b9898b8876b",
} as const;

const DEFAULT_ROLE_DEFINITIONS = [
  {
    templateId: ROLE_TEMPLATES.globalAdministrator,
    displayName: "Global Administrator",
    description:
      "Can manage all aspects of Microsoft Entra ID and Microsoft services that use Microsoft Entra identities.",
  },
  {
    templateId: ROLE_TEMPLATES.globalReader,
    displayName: "Global Reader",
    description: "Can read everything that a Global Administrator can, but not update anything.",
  },
  {
    templateId: ROLE_TEMPLATES.securityAdministrator,
    displayName: "Security Administrator",
    description:
      "Can read security information and reports, and manage configuration in Microsoft Entra ID and Office 365.",
  },
  {
    templateId: ROLE_TEMPLATES.securityReader,
    displayName: "Security Reader",
    description: "Can read security information and reports in Microsoft Entra ID and Office 365.",
  },
  {
    templateId: ROLE_TEMPLATES.securityOperator,
    displayName: "Security Operator",
    description: "Creates and manages security events.",
  },
  {
    templateId: ROLE_TEMPLATES.privilegedAuthenticationAdministrator,
    displayName: "Privileged Authentication Administrator",
    description:
      "Can access to view, set and reset authentication method information for any user (admin or non-admin).",
  },
  {
    templateId: ROLE_TEMPLATES.privilegedRoleAdministrator,
    displayName: "Privileged Role Administrator",
    description:
      "Can manage role assignments in Microsoft Entra ID, and all aspects of Privileged Identity Management.",
  },
  {
    templateId: ROLE_TEMPLATES.userAdministrator,
    displayName: "User Administrator",
    description: "Can manage all aspects of users and groups, including resetting passwords for limited admins.",
  },
  {
    templateId: ROLE_TEMPLATES.helpdeskAdministrator,
    displayName: "Helpdesk Administrator",
    description: "Can reset passwords for non-administrators and Helpdesk Administrators.",
  },
  {
    templateId: ROLE_TEMPLATES.applicationAdministrator,
    displayName: "Application Administrator",
    description: "Can create and manage all aspects of app registrations and enterprise apps.",
  },
  {
    templateId: ROLE_TEMPLATES.exchangeAdministrator,
    displayName: "Exchange Administrator",
    description: "Can manage all aspects of the Exchange product.",
  },
  {
    templateId: ROLE_TEMPLATES.directoryReaders,
    displayName: "Directory Readers",
    description:
      "Can read basic directory information. Commonly used to grant directory read access to applications and guests.",
  },
];

export const DEFAULT_SEED: GraphSeedConfig = {
  apps: [{ client_id: DEFAULT_CLIENT_ID, client_secret: DEFAULT_CLIENT_SECRET, name: "Emulate Graph app" }],
  role_definitions: DEFAULT_ROLE_DEFINITIONS,
  tenants: [
    {
      id: DEFAULT_TENANT_ID,
      displayName: DEFAULT_TENANT_NAME,
      domain: DEFAULT_TENANT_DOMAIN,
      verifiedDomains: [DEFAULT_TENANT_DOMAIN, "contoso.example"],
      users: [
        {
          id: DEFAULT_ADMIN_USER_ID,
          displayName: "Adele Vance",
          givenName: "Adele",
          surname: "Vance",
          userPrincipalName: "adele.vance@contoso.example",
          mail: "adele.vance@contoso.example",
          jobTitle: "IT Administrator",
          department: "IT",
          roles: ["Global Administrator"],
        },
        {
          id: DEFAULT_ANALYST_USER_ID,
          displayName: "Alex Wilber",
          givenName: "Alex",
          surname: "Wilber",
          userPrincipalName: "alex.wilber@contoso.example",
          mail: "alex.wilber@contoso.example",
          jobTitle: "Security Analyst",
          department: "Security",
          roles: ["Security Administrator", "Privileged Authentication Administrator"],
        },
        {
          id: DEFAULT_GUEST_USER_ID,
          displayName: "Nora Analyst",
          userPrincipalName: "nora.analyst_soc.example#EXT#@contoso.onmicrosoft.com",
          mail: "nora.analyst@soc.example",
          userType: "Guest",
          externalUserState: "Accepted",
          roles: ["Security Administrator"],
        },
        {
          id: DEFAULT_DISABLED_USER_ID,
          displayName: "Former Analyst",
          userPrincipalName: "former.analyst_soc.example#EXT#@contoso.onmicrosoft.com",
          mail: "former.analyst@soc.example",
          userType: "Guest",
          externalUserState: "Accepted",
          accountEnabled: false,
        },
        {
          displayName: "Diego Siciliani",
          givenName: "Diego",
          surname: "Siciliani",
          userPrincipalName: "diego.siciliani@contoso.example",
          mail: "diego.siciliani@contoso.example",
          jobTitle: "Sales",
          department: "Sales",
        },
      ],
      groups: [
        {
          displayName: "Security Team",
          mailNickname: "security-team",
          description: "Security analysts",
          securityEnabled: true,
          mailEnabled: false,
        },
      ],
      invitations: [
        {
          email: "pending.analyst@soc.example",
          displayName: "Pending Analyst",
          inviteRedirectUrl: "https://security.microsoft.com",
          status: "PendingAcceptance",
        },
      ],
    },
    {
      id: DEFAULT_SECOND_TENANT_ID,
      displayName: "Fabrikam",
      domain: "fabrikam.onmicrosoft.com",
      verifiedDomains: ["fabrikam.onmicrosoft.com", "fabrikam.example"],
      users: [
        {
          displayName: "Megan Bowen",
          givenName: "Megan",
          surname: "Bowen",
          userPrincipalName: "megan.bowen@fabrikam.example",
          mail: "megan.bowen@fabrikam.example",
          roles: ["Global Administrator"],
        },
      ],
    },
  ],
};

export function seedFromConfig(
  store: Store,
  _baseUrl: string,
  config: GraphSeedConfig,
  _webhooks?: WebhookDispatcher,
): void {
  const gs = getGStore(store);
  const fmt: Fmt = { gs, baseUrl: _baseUrl };
  for (const entry of config.apps ?? []) {
    if (!entry.client_id || gs.apps.findOneBy("client_id", entry.client_id)) continue;
    gs.apps.insert({
      client_id: entry.client_id,
      client_secret: entry.client_secret,
      name: entry.name ?? entry.client_id,
      tenant_ids: entry.tenant_ids ?? null,
      permissions: entry.permissions ?? [],
    });
  }
  if (gs.apps.count() === 0)
    gs.apps.insert({
      client_id: DEFAULT_CLIENT_ID,
      client_secret: DEFAULT_CLIENT_SECRET,
      name: "Emulate Graph app",
      tenant_ids: null,
      permissions: [],
    });

  const roleEntries: NonNullable<GraphSeedConfig["role_definitions"]> = [
    ...(gs.roleDefinitions.count() === 0 && !config.role_definitions ? DEFAULT_ROLE_DEFINITIONS : []),
    ...(config.role_definitions ?? []),
  ];
  for (const entry of roleEntries) {
    const templateId = entry.templateId ?? entry.id ?? guid();
    if (
      gs.roleDefinitions.findOneBy("templateId", templateId) ||
      gs.roleDefinitions.all().some((role) => role.displayName.toLowerCase() === entry.displayName.toLowerCase())
    )
      continue;
    gs.roleDefinitions.insert({
      role_id: entry.id ?? templateId,
      templateId,
      displayName: entry.displayName,
      description: entry.description ?? "",
      isBuiltIn: true,
      isEnabled: true,
      resourceScopes: ["/"],
      allowedActions: ["microsoft.directory/users/allProperties/read"],
    });
  }
  const roleByName = (name: string) =>
    gs.roleDefinitions.findOneBy("role_id", name) ??
    gs.roleDefinitions.findOneBy("templateId", name) ??
    gs.roleDefinitions.all().find((role) => role.displayName.toLowerCase() === name.toLowerCase());

  for (const entry of config.tenants ?? []) {
    const domain = (
      entry.domain ?? `${entry.displayName.toLowerCase().replace(/[^a-z0-9]/g, "")}.onmicrosoft.com`
    ).toLowerCase();
    const tenant =
      (entry.id && gs.tenants.findOneBy("tenant_id", entry.id)) ||
      gs.tenants.findOneBy("domain", domain) ||
      gs.tenants.insert({
        tenant_id: entry.id ?? guid(),
        display_name: entry.displayName,
        domain,
        verified_domains: entry.verifiedDomains ?? [domain],
        country: entry.country ?? "FR",
      });
    for (const groupEntry of entry.groups ?? []) {
      if (
        gs.groups
          .findBy("tenant_id", tenant.tenant_id)
          .some((group) => group.displayName.toLowerCase() === groupEntry.displayName.toLowerCase())
      )
        continue;
      const nickname = groupEntry.mailNickname ?? groupEntry.displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      gs.groups.insert({
        tenant_id: tenant.tenant_id,
        object_id: groupEntry.id ?? guid(),
        displayName: groupEntry.displayName,
        description: groupEntry.description ?? null,
        mail: groupEntry.mailEnabled ? `${nickname}@${tenant.domain}` : null,
        mailNickname: nickname,
        mailEnabled: groupEntry.mailEnabled ?? false,
        securityEnabled: groupEntry.securityEnabled ?? true,
        groupTypes: [],
        visibility: null,
        member_ids: [],
        owner_ids: [],
      });
    }
    for (const userEntry of entry.users ?? []) {
      if (
        (userEntry.id && gs.users.findOneBy("object_id", userEntry.id)) ||
        (userEntry.userPrincipalName &&
          gs.users
            .findBy("tenant_id", tenant.tenant_id)
            .some((user) => user.userPrincipalName.toLowerCase() === userEntry.userPrincipalName!.toLowerCase()))
      )
        continue;
      const user = createUser(gs, {
        tenantId: tenant.tenant_id,
        id: userEntry.id,
        displayName: userEntry.displayName,
        userPrincipalName: userEntry.userPrincipalName,
        mail: userEntry.mail,
        givenName: userEntry.givenName,
        surname: userEntry.surname,
        jobTitle: userEntry.jobTitle,
        department: userEntry.department,
        accountEnabled: userEntry.accountEnabled,
        userType: userEntry.userType,
        externalUserState: userEntry.externalUserState ?? (userEntry.userType === "Guest" ? "Accepted" : null),
        preferredLanguage: userEntry.preferredLanguage ?? "en-US",
        mobilePhone: userEntry.mobilePhone,
        officeLocation: userEntry.officeLocation,
        businessPhones: userEntry.businessPhones,
      });
      for (const roleName of userEntry.roles ?? []) {
        const role = roleByName(roleName);
        if (
          !role ||
          gs.roleAssignments
            .findBy("principalId", user.object_id)
            .some((assignment) => assignment.roleDefinitionId === role.role_id)
        )
          continue;
        gs.roleAssignments.insert({
          tenant_id: tenant.tenant_id,
          assignment_id: `${shortToken(32)}-1`,
          principalId: user.object_id,
          roleDefinitionId: role.role_id,
          directoryScopeId: "/",
          appScopeId: null,
        });
      }
      for (const groupName of userEntry.groups ?? []) {
        const group = gs.groups
          .findBy("tenant_id", tenant.tenant_id)
          .find(
            (candidate) =>
              candidate.displayName.toLowerCase() === groupName.toLowerCase() || candidate.object_id === groupName,
          );
        if (group && !group.member_ids.includes(user.object_id))
          gs.groups.update(group.id, { member_ids: [...group.member_ids, user.object_id] });
      }
    }
    for (const invitationEntry of entry.invitations ?? []) {
      if (
        gs.invitations
          .findBy("tenant_id", tenant.tenant_id)
          .some((invitation) => invitation.invitedUserEmailAddress === invitationEntry.email.toLowerCase())
      )
        continue;
      const invitation = inviteUser(gs, fmt, {
        tenantId: tenant.tenant_id,
        email: invitationEntry.email,
        displayName: invitationEntry.displayName ?? null,
        inviteRedirectUrl: invitationEntry.inviteRedirectUrl ?? "https://myapps.microsoft.com",
        sendInvitationMessage: false,
      });
      if (invitationEntry.status === "Completed") {
        gs.invitations.update(invitation.id, { status: "Completed" });
        const user = gs.users.findOneBy("object_id", invitation.invited_user_id);
        if (user)
          gs.users.update(user.id, {
            externalUserState: "Accepted",
            externalUserStateChangeDateTime: new Date().toISOString(),
          });
      }
    }
  }
  if (gs.tenants.count() === 0)
    gs.tenants.insert({
      tenant_id: DEFAULT_TENANT_ID,
      display_name: DEFAULT_TENANT_NAME,
      domain: DEFAULT_TENANT_DOMAIN,
      verified_domains: [DEFAULT_TENANT_DOMAIN],
      country: "FR",
    });
  logEvent(gs, gs.tenants.all()[0].tenant_id, "seed.applied", "config", {
    tenants: gs.tenants.count(),
    users: gs.users.count(),
    roleAssignments: gs.roleAssignments.count(),
  });
}

export const graphPlugin: ServicePlugin = {
  name: "graph",
  register(app: Hono<AppEnv>, store: Store, _webhooks: WebhookDispatcher, baseUrl: string, _tokenMap?: TokenMap): void {
    const gs: GStore = getGStore(store);
    const fmt: Fmt = { gs, baseUrl };
    authRoutes(app, gs, baseUrl);
    batchRoutes(app, gs, baseUrl);
    userRoutes(app, gs, baseUrl);
    directoryRoutes(app, gs, fmt, baseUrl);
    miscRoutes(app, gs, fmt);
    inspectorRoutes(app, gs, baseUrl);
  },
  seed(store: Store, baseUrl: string): void {
    seedFromConfig(store, baseUrl, DEFAULT_SEED);
  },
};

export default graphPlugin;
