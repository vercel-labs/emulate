import type { AppEnv, Hono } from "@emulators/core";
import {
  formatGroup,
  formatInvitation,
  formatOrganization,
  formatRoleAssignment,
  formatRoleDefinition,
  formatUser,
  type Fmt,
} from "../formatters.js";
import {
  api,
  badRequest,
  bool,
  collection,
  conflict,
  emailValid,
  entity,
  guid,
  notFound,
  odataOptions,
  parseJsonBody,
  requirePermission,
  route,
  shortToken,
  str,
  strOrNull,
  stringArray,
  versionOf,
  type Body,
} from "../helpers.js";
import { logEvent, type GStore } from "../store.js";
import { createUser, findUser, tenantDomain, READ_USERS } from "./users.js";

const READ_ROLES = [
  "RoleManagement.Read.Directory",
  "RoleManagement.ReadWrite.Directory",
  "Directory.Read.All",
  "Directory.ReadWrite.All",
];
const WRITE_ROLES = ["RoleManagement.ReadWrite.Directory", "Directory.ReadWrite.All"];
const READ_GROUPS = ["Group.Read.All", "Group.ReadWrite.All", "Directory.Read.All", "Directory.ReadWrite.All"];
const WRITE_GROUPS = ["Group.ReadWrite.All", "Directory.ReadWrite.All"];

export interface InviteInput {
  tenantId: string;
  email: string;
  displayName: string | null;
  inviteRedirectUrl: string;
  sendInvitationMessage: boolean;
  userType?: "Guest" | "Member";
  messageLanguage?: string | null;
  customMessage?: string | null;
  ccRecipients?: string[];
  resetRedemption?: boolean;
}

export function inviteUser(gs: GStore, fmt: Fmt, input: InviteInput) {
  const email = input.email.trim().toLowerCase();
  if (!email || !emailValid(email)) throw badRequest("The invited user email address is not a valid email address.");
  const domain = tenantDomain(gs, input.tenantId);
  const existing = gs.users
    .findBy("tenant_id", input.tenantId)
    .find(
      (candidate) =>
        !candidate.deleted &&
        (candidate.mail?.toLowerCase() === email ||
          candidate.otherMails.map((other) => other.toLowerCase()).includes(email)),
    );
  const user =
    input.resetRedemption && existing
      ? gs.users.update(existing.id, {
          externalUserState: "PendingAcceptance",
          externalUserStateChangeDateTime: new Date().toISOString(),
        })!
      : (existing ??
        createUser(gs, {
          tenantId: input.tenantId,
          displayName: input.displayName ?? email,
          userPrincipalName: `${email.replace("@", "_")}#EXT#@${domain}`,
          mailNickname: `${email.replace("@", "_")}#EXT#`,
          mail: email,
          userType: input.userType ?? "Guest",
          externalUserState: "PendingAcceptance",
          otherMails: [email],
        }));
  const invitation = gs.invitations.insert({
    tenant_id: input.tenantId,
    invitation_id: guid(),
    invitedUserEmailAddress: email,
    invitedUserDisplayName: input.displayName,
    invitedUserType: input.userType ?? "Guest",
    inviteRedirectUrl: input.inviteRedirectUrl,
    inviteRedeemUrl: `${fmt.baseUrl}/_graph/redeem/${shortToken(16)}`,
    sendInvitationMessage: input.sendInvitationMessage,
    resetRedemption: input.resetRedemption ?? false,
    status: "PendingAcceptance",
    invited_user_id: user.object_id,
    message_language: input.messageLanguage ?? null,
    custom_message: input.customMessage ?? null,
    cc_recipients: input.ccRecipients ?? [],
  });
  logEvent(gs, input.tenantId, "invitation.created", invitation.invitation_id, {
    email,
    userId: user.object_id,
    sendInvitationMessage: input.sendInvitationMessage,
    existing: !!existing,
  });
  return invitation;
}

export function directoryRoutes(app: Hono<AppEnv>, gs: GStore, fmt: Fmt, baseUrl: string): void {
  route(
    app,
    "post",
    "/invitations",
    api(gs, async (c, auth) => {
      requirePermission(auth, "User.Invite.All", "User.ReadWrite.All", "Directory.ReadWrite.All");
      const body = await parseJsonBody(c);
      const email = str(body.invitedUserEmailAddress);
      if (!email) throw badRequest("The invitedUserEmailAddress property is required.");
      const redirect = str(body.inviteRedirectUrl);
      if (!redirect) throw badRequest("The inviteRedirectUrl property is required.");
      const info =
        body.invitedUserMessageInfo && typeof body.invitedUserMessageInfo === "object"
          ? (body.invitedUserMessageInfo as Body)
          : {};
      const invitation = inviteUser(gs, fmt, {
        tenantId: auth.tenantId,
        email,
        displayName: strOrNull(body.invitedUserDisplayName),
        inviteRedirectUrl: redirect,
        sendInvitationMessage: bool(body.sendInvitationMessage) ?? false,
        userType: str(body.invitedUserType) === "Member" ? "Member" : "Guest",
        messageLanguage: strOrNull(info.messageLanguage),
        customMessage: strOrNull(info.customizedMessageBody),
        ccRecipients: Array.isArray(info.ccRecipients)
          ? info.ccRecipients
              .map(
                (recipient) =>
                  str((recipient as Body)?.emailAddress && ((recipient as Body).emailAddress as Body).address) ?? "",
              )
              .filter(Boolean)
          : [],
        resetRedemption: bool(body.resetRedemption) ?? false,
      });
      return entity(c, baseUrl, versionOf(c), "invitations", formatInvitation(fmt, invitation), 201);
    }),
  );

  route(
    app,
    "get",
    "/roleManagement/directory/roleDefinitions",
    api(gs, (c, auth) => {
      requirePermission(auth, ...READ_ROLES);
      return collection(
        c,
        baseUrl,
        versionOf(c),
        "roleManagement/directory/roleDefinitions",
        gs.roleDefinitions.all().map(formatRoleDefinition),
        odataOptions(c),
      );
    }),
  );

  route(
    app,
    "get",
    "/roleManagement/directory/roleDefinitions/:id",
    api(gs, (c, auth) => {
      requirePermission(auth, ...READ_ROLES);
      const role =
        gs.roleDefinitions.findOneBy("role_id", c.req.param("id")) ??
        gs.roleDefinitions.findOneBy("templateId", c.req.param("id"));
      if (!role) throw notFound();
      return entity(c, baseUrl, versionOf(c), "roleManagement/directory/roleDefinitions", formatRoleDefinition(role));
    }),
  );

  route(
    app,
    "get",
    "/roleManagement/directory/roleAssignments",
    api(gs, (c, auth) => {
      requirePermission(auth, ...READ_ROLES);
      const rows = gs.roleAssignments
        .findBy("tenant_id", auth.tenantId)
        .sort((a, b) => a.id - b.id)
        .map(formatRoleAssignment);
      return collection(c, baseUrl, versionOf(c), "roleManagement/directory/roleAssignments", rows, odataOptions(c));
    }),
  );

  route(
    app,
    "post",
    "/roleManagement/directory/roleAssignments",
    api(gs, async (c, auth) => {
      requirePermission(auth, ...WRITE_ROLES);
      const body = await parseJsonBody(c);
      const principalId = str(body.principalId);
      const roleDefinitionId = str(body.roleDefinitionId);
      const directoryScopeId = str(body.directoryScopeId) ?? "/";
      if (!principalId) throw badRequest("The principalId property is required.");
      if (!roleDefinitionId) throw badRequest("The roleDefinitionId property is required.");
      const role =
        gs.roleDefinitions.findOneBy("role_id", roleDefinitionId) ??
        gs.roleDefinitions.findOneBy("templateId", roleDefinitionId);
      if (!role)
        throw notFound(
          `Resource '${roleDefinitionId}' does not exist or one of its queried reference-property objects are not present.`,
        );
      const principal =
        gs.users
          .findBy("tenant_id", auth.tenantId)
          .find((candidate) => !candidate.deleted && candidate.object_id === principalId) ??
        gs.groups.findBy("tenant_id", auth.tenantId).find((candidate) => candidate.object_id === principalId);
      if (!principal)
        throw notFound(
          `Resource '${principalId}' does not exist or one of its queried reference-property objects are not present.`,
        );
      if (
        gs.roleAssignments
          .findBy("principalId", principalId)
          .some(
            (assignment) =>
              assignment.tenant_id === auth.tenantId &&
              assignment.roleDefinitionId === role.role_id &&
              assignment.directoryScopeId === directoryScopeId,
          )
      )
        throw conflict();
      const assignment = gs.roleAssignments.insert({
        tenant_id: auth.tenantId,
        assignment_id: `${shortToken(32)}-1`,
        principalId,
        roleDefinitionId: role.role_id,
        directoryScopeId,
        appScopeId: null,
      });
      logEvent(gs, auth.tenantId, "role_assignment.created", assignment.assignment_id, {
        principalId,
        role: role.displayName,
        roleDefinitionId: role.role_id,
      });
      return entity(
        c,
        baseUrl,
        versionOf(c),
        "roleManagement/directory/roleAssignments",
        formatRoleAssignment(assignment),
        201,
      );
    }),
  );

  route(
    app,
    "get",
    "/roleManagement/directory/roleAssignments/:id",
    api(gs, (c, auth) => {
      requirePermission(auth, ...READ_ROLES);
      const assignment = gs.roleAssignments
        .findBy("assignment_id", c.req.param("id"))
        .find((candidate) => candidate.tenant_id === auth.tenantId);
      if (!assignment) throw notFound();
      return entity(
        c,
        baseUrl,
        versionOf(c),
        "roleManagement/directory/roleAssignments",
        formatRoleAssignment(assignment),
      );
    }),
  );

  route(
    app,
    "delete",
    "/roleManagement/directory/roleAssignments/:id",
    api(gs, (c, auth) => {
      requirePermission(auth, ...WRITE_ROLES);
      const assignment = gs.roleAssignments
        .findBy("assignment_id", c.req.param("id"))
        .find((candidate) => candidate.tenant_id === auth.tenantId);
      if (!assignment) throw notFound();
      gs.roleAssignments.delete(assignment.id);
      logEvent(gs, auth.tenantId, "role_assignment.deleted", assignment.assignment_id, {
        principalId: assignment.principalId,
      });
      return c.body(null, 204);
    }),
  );

  route(
    app,
    "get",
    "/directoryRoles",
    api(gs, (c, auth) => {
      requirePermission(auth, ...READ_ROLES);
      const activated = new Set(
        gs.roleAssignments.findBy("tenant_id", auth.tenantId).map((assignment) => assignment.roleDefinitionId),
      );
      const rows = gs.roleDefinitions
        .all()
        .filter((role) => activated.has(role.role_id) || role.templateId === "62e90394-69f5-4237-9190-012177145e10")
        .map((role) => ({
          id: role.role_id,
          deletedDateTime: null,
          description: role.description,
          displayName: role.displayName,
          roleTemplateId: role.templateId,
        }));
      return collection(c, baseUrl, versionOf(c), "directoryRoles", rows, odataOptions(c));
    }),
  );

  route(
    app,
    "get",
    "/directoryRoles/:id/members",
    api(gs, (c, auth) => {
      requirePermission(auth, ...READ_ROLES);
      const role =
        gs.roleDefinitions.findOneBy("role_id", c.req.param("id")) ??
        gs.roleDefinitions.findOneBy("templateId", c.req.param("id"));
      if (!role) throw notFound();
      const members = gs.roleAssignments
        .findBy("roleDefinitionId", role.role_id)
        .filter((assignment) => assignment.tenant_id === auth.tenantId)
        .map((assignment) => gs.users.findOneBy("object_id", assignment.principalId))
        .filter((user): user is NonNullable<typeof user> => !!user && !user.deleted)
        .map((user) => ({ "@odata.type": "#microsoft.graph.user", ...formatUser(user) }));
      return collection(c, baseUrl, versionOf(c), "directoryObjects", members, odataOptions(c));
    }),
  );

  route(
    app,
    "get",
    "/groups",
    api(gs, (c, auth) => {
      requirePermission(auth, ...READ_GROUPS);
      return collection(
        c,
        baseUrl,
        versionOf(c),
        "groups",
        gs.groups.findBy("tenant_id", auth.tenantId).map(formatGroup),
        odataOptions(c),
      );
    }),
  );

  route(
    app,
    "post",
    "/groups",
    api(gs, async (c, auth) => {
      requirePermission(auth, ...WRITE_GROUPS);
      const body = await parseJsonBody(c);
      const displayName = str(body.displayName)?.trim();
      const nickname = str(body.mailNickname)?.trim();
      if (!displayName) throw badRequest("Property displayName is required.");
      if (!nickname) throw badRequest("Property mailNickname is required.");
      if (body.mailEnabled === undefined || body.securityEnabled === undefined)
        throw badRequest("Properties mailEnabled and securityEnabled are required.");
      const mailEnabled = bool(body.mailEnabled) ?? false;
      const group = gs.groups.insert({
        tenant_id: auth.tenantId,
        object_id: guid(),
        displayName,
        description: strOrNull(body.description),
        mail: mailEnabled ? `${nickname}@${tenantDomain(gs, auth.tenantId)}` : null,
        mailNickname: nickname,
        mailEnabled,
        securityEnabled: bool(body.securityEnabled) ?? true,
        groupTypes: stringArray(body.groupTypes) ?? [],
        visibility: strOrNull(body.visibility),
        member_ids: [],
        owner_ids: [],
      });
      logEvent(gs, auth.tenantId, "group.created", group.object_id, { displayName });
      return entity(c, baseUrl, versionOf(c), "groups", formatGroup(group), 201);
    }),
  );

  const findGroup = (tenantId: string, id: string) => {
    const group = gs.groups.findBy("tenant_id", tenantId).find((candidate) => candidate.object_id === id);
    if (!group) throw notFound();
    return group;
  };

  route(
    app,
    "get",
    "/groups/:id",
    api(gs, (c, auth) => {
      requirePermission(auth, ...READ_GROUPS);
      return entity(c, baseUrl, versionOf(c), "groups", formatGroup(findGroup(auth.tenantId, c.req.param("id"))));
    }),
  );

  route(
    app,
    "patch",
    "/groups/:id",
    api(gs, async (c, auth) => {
      requirePermission(auth, ...WRITE_GROUPS);
      const group = findGroup(auth.tenantId, c.req.param("id"));
      const body = await parseJsonBody(c);
      gs.groups.update(group.id, {
        displayName: str(body.displayName) ?? group.displayName,
        description: body.description !== undefined ? strOrNull(body.description) : group.description,
        visibility: body.visibility !== undefined ? strOrNull(body.visibility) : group.visibility,
      });
      return c.body(null, 204);
    }),
  );

  route(
    app,
    "delete",
    "/groups/:id",
    api(gs, (c, auth) => {
      requirePermission(auth, ...WRITE_GROUPS);
      const group = findGroup(auth.tenantId, c.req.param("id"));
      gs.groups.delete(group.id);
      return c.body(null, 204);
    }),
  );

  route(
    app,
    "get",
    "/groups/:id/members",
    api(gs, (c, auth) => {
      requirePermission(auth, ...READ_GROUPS);
      const group = findGroup(auth.tenantId, c.req.param("id"));
      const rows = group.member_ids
        .map((id) => gs.users.findOneBy("object_id", id))
        .filter((user): user is NonNullable<typeof user> => !!user && !user.deleted)
        .map((user) => ({ "@odata.type": "#microsoft.graph.user", ...formatUser(user) }));
      return collection(c, baseUrl, versionOf(c), "directoryObjects", rows, odataOptions(c));
    }),
  );

  route(
    app,
    "post",
    "/groups/:id/members/$ref",
    api(gs, async (c, auth) => {
      requirePermission(auth, ...WRITE_GROUPS);
      const group = findGroup(auth.tenantId, c.req.param("id"));
      const body = await parseJsonBody(c);
      const reference = str(body["@odata.id"]);
      if (!reference) throw badRequest("The @odata.id property is required.");
      const memberId = reference.split("/").pop() ?? "";
      const user = findUser(gs, auth.tenantId, memberId);
      if (group.member_ids.includes(user.object_id))
        throw conflict(
          "One or more added object references already exist for the following modified properties: 'members'.",
        );
      gs.groups.update(group.id, { member_ids: [...group.member_ids, user.object_id] });
      return c.body(null, 204);
    }),
  );

  route(
    app,
    "delete",
    "/groups/:id/members/:memberId/$ref",
    api(gs, (c, auth) => {
      requirePermission(auth, ...WRITE_GROUPS);
      const group = findGroup(auth.tenantId, c.req.param("id"));
      if (!group.member_ids.includes(c.req.param("memberId"))) throw notFound();
      gs.groups.update(group.id, { member_ids: group.member_ids.filter((id) => id !== c.req.param("memberId")) });
      return c.body(null, 204);
    }),
  );

  route(
    app,
    "get",
    "/organization",
    api(gs, (c, auth) => {
      requirePermission(auth, "Organization.Read.All", ...READ_USERS);
      const tenant = gs.tenants.findOneBy("tenant_id", auth.tenantId);
      return collection(
        c,
        baseUrl,
        versionOf(c),
        "organization",
        tenant ? [formatOrganization(tenant)] : [],
        odataOptions(c),
      );
    }),
  );

  route(
    app,
    "get",
    "/me",
    api(gs, (c) =>
      c.json(
        {
          error: {
            code: "BadRequest",
            message: "/me request is only valid with delegated authentication flow.",
            innerError: { date: new Date().toISOString(), "request-id": guid(), "client-request-id": guid() },
          },
        },
        400,
      ),
    ),
  );

  route(
    app,
    "get",
    "/servicePrincipals",
    api(gs, (c, auth) => {
      requirePermission(auth, "Directory.Read.All", "Directory.ReadWrite.All", ...READ_USERS);
      const rows = gs.apps.all().map((app_) => ({
        id: guid(),
        appId: app_.client_id,
        displayName: app_.name,
        servicePrincipalType: "Application",
        accountEnabled: true,
        appRoles: [],
        oauth2PermissionScopes: [],
      }));
      return collection(c, baseUrl, versionOf(c), "servicePrincipals", rows, odataOptions(c));
    }),
  );
}
