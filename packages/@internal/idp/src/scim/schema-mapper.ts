import type { IdpUser, IdpGroup } from "../entities.js";
import type { ScimUser, ScimGroup, ScimEnterpriseUser } from "./types.js";
import { SCIM_USER_SCHEMA, SCIM_ENTERPRISE_USER_SCHEMA, SCIM_GROUP_SCHEMA } from "./constants.js";
import { generateUid } from "../helpers.js";

export function idpUserToScimUser(user: IdpUser, baseUrl: string, allGroups: IdpGroup[]): ScimUser {
  const userGroups = allGroups.filter(g => user.groups.includes(g.name));

  const enterpriseExt: ScimEnterpriseUser = {};
  if (user.attributes.department != null) enterpriseExt.department = String(user.attributes.department);
  if (user.attributes.employeeNumber != null || user.attributes.employee_id != null) {
    enterpriseExt.employeeNumber = String(user.attributes.employeeNumber ?? user.attributes.employee_id);
  }
  if (user.attributes.manager != null) {
    const mgr = user.attributes.manager;
    if (typeof mgr === "object" && mgr !== null) {
      enterpriseExt.manager = mgr as { value?: string; displayName?: string };
    } else {
      enterpriseExt.manager = { displayName: String(mgr) };
    }
  }

  const hasEnterprise = Object.keys(enterpriseExt).length > 0;
  const schemas = [SCIM_USER_SCHEMA];
  if (hasEnterprise) schemas.push(SCIM_ENTERPRISE_USER_SCHEMA);

  const active = user.attributes.__scim_active !== false;

  const result: ScimUser = {
    schemas,
    id: String(user.id),
    externalId: user.uid,
    userName: user.email,
    name: {
      formatted: user.name,
      familyName: user.family_name,
      givenName: user.given_name,
    },
    displayName: user.name,
    emails: [{ value: user.email, type: "work", primary: true }],
    active,
    locale: user.locale,
    groups: userGroups.map(g => ({
      value: String(g.id),
      display: g.display_name,
      $ref: `${baseUrl}/scim/v2/Groups/${g.id}`,
    })),
    meta: {
      resourceType: "User",
      created: user.created_at,
      lastModified: user.updated_at,
      location: `${baseUrl}/scim/v2/Users/${user.id}`,
    },
  };

  if (user.picture) {
    result.photos = [{ value: user.picture, type: "photo" }];
  }

  if (hasEnterprise) {
    result[SCIM_ENTERPRISE_USER_SCHEMA] = enterpriseExt;
  }

  return result;
}

export function scimUserToIdpUserInput(scim: Partial<ScimUser>): Record<string, unknown> {
  const input: Record<string, unknown> = {};

  if (scim.userName !== undefined) input.email = scim.userName;
  if (scim.externalId !== undefined) input.uid = scim.externalId;
  else if (!input.uid) input.uid = generateUid("idp");

  if (scim.name) {
    if (scim.name.formatted) input.name = scim.name.formatted;
    if (scim.name.givenName) input.given_name = scim.name.givenName;
    if (scim.name.familyName) input.family_name = scim.name.familyName;
  }

  if (scim.displayName && !input.name) input.name = scim.displayName;
  if (scim.locale !== undefined) input.locale = scim.locale;
  if (scim.photos?.[0]?.value) input.picture = scim.photos[0].value;
  if (scim.active !== undefined) {
    if (!input.attributes) input.attributes = {};
    (input.attributes as Record<string, unknown>).__scim_active = scim.active;
  }

  if (scim.emails?.[0]?.value && !input.email) input.email = scim.emails[0].value;

  // Enterprise extension
  const enterprise = scim[SCIM_ENTERPRISE_USER_SCHEMA];
  if (enterprise) {
    if (!input.attributes) input.attributes = {};
    const attrs = input.attributes as Record<string, unknown>;
    if (enterprise.department) attrs.department = enterprise.department;
    if (enterprise.employeeNumber) attrs.employeeNumber = enterprise.employeeNumber;
    if (enterprise.manager) attrs.manager = enterprise.manager;
  }

  return input;
}

export function idpGroupToScimGroup(group: IdpGroup, baseUrl: string, allUsers: IdpUser[]): ScimGroup {
  const members = allUsers
    .filter(u => u.groups.includes(group.name))
    .map(u => ({
      value: String(u.id),
      display: u.email,
      $ref: `${baseUrl}/scim/v2/Users/${u.id}`,
    }));

  return {
    schemas: [SCIM_GROUP_SCHEMA],
    id: String(group.id),
    displayName: group.display_name,
    members,
    meta: {
      resourceType: "Group",
      created: group.created_at,
      lastModified: group.updated_at,
      location: `${baseUrl}/scim/v2/Groups/${group.id}`,
    },
  };
}

export function scimGroupToIdpGroupInput(scim: Partial<ScimGroup>): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (scim.displayName) {
    input.display_name = scim.displayName;
    input.name = scim.displayName.toLowerCase().replace(/\s+/g, "-");
  }
  return input;
}
