import { describe, it, expect } from "vitest";
import { idpUserToScimUser, scimUserToIdpUserInput, idpGroupToScimGroup, scimGroupToIdpGroupInput } from "../scim/schema-mapper.js";
import { SCIM_USER_SCHEMA, SCIM_ENTERPRISE_USER_SCHEMA, SCIM_GROUP_SCHEMA } from "../scim/constants.js";
import type { IdpUser, IdpGroup } from "../entities.js";

const baseUrl = "http://localhost:4003";

const mockUser: IdpUser = {
  id: 1, uid: "idp_abc123", email: "alice@example.com", email_verified: true,
  name: "Alice Example", given_name: "Alice", family_name: "Example",
  picture: "https://example.com/photo.jpg", locale: "en",
  groups: ["engineering"], roles: ["admin"],
  attributes: { department: "Engineering", employee_id: "E-1001" },
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z",
};

const mockGroup: IdpGroup = {
  id: 1, name: "engineering", display_name: "Engineering",
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
};

describe("idpUserToScimUser", () => {
  it("maps all standard fields", () => {
    const scim = idpUserToScimUser(mockUser, baseUrl, [mockGroup]);
    expect(scim.schemas).toContain(SCIM_USER_SCHEMA);
    expect(scim.id).toBe("1");
    expect(scim.externalId).toBe("idp_abc123");
    expect(scim.userName).toBe("alice@example.com");
    expect(scim.name?.givenName).toBe("Alice");
    expect(scim.name?.familyName).toBe("Example");
    expect(scim.displayName).toBe("Alice Example");
    expect(scim.emails?.[0]?.value).toBe("alice@example.com");
    expect(scim.active).toBe(true);
    expect(scim.locale).toBe("en");
    expect(scim.photos?.[0]?.value).toBe("https://example.com/photo.jpg");
    expect(scim.meta?.resourceType).toBe("User");
    expect(scim.meta?.location).toBe("http://localhost:4003/scim/v2/Users/1");
  });

  it("includes enterprise extension when attributes present", () => {
    const scim = idpUserToScimUser(mockUser, baseUrl, []);
    expect(scim.schemas).toContain(SCIM_ENTERPRISE_USER_SCHEMA);
    const ext = scim[SCIM_ENTERPRISE_USER_SCHEMA];
    expect(ext?.department).toBe("Engineering");
    expect(ext?.employeeNumber).toBe("E-1001");
  });

  it("resolves group membership", () => {
    const scim = idpUserToScimUser(mockUser, baseUrl, [mockGroup]);
    expect(scim.groups?.length).toBe(1);
    expect(scim.groups?.[0]?.display).toBe("Engineering");
  });

  it("handles user with no groups or attributes", () => {
    const minimal: IdpUser = {
      ...mockUser, groups: [], roles: [], attributes: {}, picture: null,
    };
    const scim = idpUserToScimUser(minimal, baseUrl, []);
    expect(scim.groups).toEqual([]);
    expect(scim.photos).toBeUndefined();
    expect(scim.schemas).not.toContain(SCIM_ENTERPRISE_USER_SCHEMA);
  });

  it("handles inactive user via __scim_active attribute", () => {
    const inactive: IdpUser = { ...mockUser, attributes: { ...mockUser.attributes, __scim_active: false } };
    const scim = idpUserToScimUser(inactive, baseUrl, []);
    expect(scim.active).toBe(false);
  });

  it("maps manager attribute as object", () => {
    const withManager: IdpUser = {
      ...mockUser,
      attributes: { ...mockUser.attributes, manager: { value: "mgr-1", displayName: "Boss" } },
    };
    const scim = idpUserToScimUser(withManager, baseUrl, []);
    const ext = scim[SCIM_ENTERPRISE_USER_SCHEMA];
    expect(ext?.manager?.displayName).toBe("Boss");
  });

  it("maps manager attribute as string", () => {
    const withManager: IdpUser = {
      ...mockUser,
      attributes: { ...mockUser.attributes, manager: "Jane Doe" },
    };
    const scim = idpUserToScimUser(withManager, baseUrl, []);
    const ext = scim[SCIM_ENTERPRISE_USER_SCHEMA];
    expect(ext?.manager?.displayName).toBe("Jane Doe");
  });
});

describe("scimUserToIdpUserInput", () => {
  it("reverse maps standard fields", () => {
    const input = scimUserToIdpUserInput({
      userName: "bob@example.com",
      externalId: "ext-123",
      name: { givenName: "Bob", familyName: "Smith", formatted: "Bob Smith" },
      displayName: "Bob Smith",
      locale: "en-US",
    });
    expect(input.email).toBe("bob@example.com");
    expect(input.uid).toBe("ext-123");
    expect(input.name).toBe("Bob Smith");
    expect(input.given_name).toBe("Bob");
    expect(input.family_name).toBe("Smith");
  });

  it("generates uid if no externalId", () => {
    const input = scimUserToIdpUserInput({ userName: "test@test.com" });
    expect(typeof input.uid).toBe("string");
    expect((input.uid as string).length).toBeGreaterThan(3);
  });

  it("maps enterprise extension to attributes", () => {
    const input = scimUserToIdpUserInput({
      userName: "test@test.com",
      [SCIM_ENTERPRISE_USER_SCHEMA]: { department: "Sales", employeeNumber: "E-99" },
    });
    const attrs = input.attributes as Record<string, unknown>;
    expect(attrs.department).toBe("Sales");
    expect(attrs.employeeNumber).toBe("E-99");
  });
});

describe("idpGroupToScimGroup", () => {
  it("maps group with members", () => {
    const scim = idpGroupToScimGroup(mockGroup, baseUrl, [mockUser]);
    expect(scim.schemas).toContain(SCIM_GROUP_SCHEMA);
    expect(scim.id).toBe("1");
    expect(scim.displayName).toBe("Engineering");
    expect(scim.members?.length).toBe(1);
    expect(scim.members?.[0]?.display).toBe("alice@example.com");
  });

  it("handles group with no members", () => {
    const scim = idpGroupToScimGroup(mockGroup, baseUrl, []);
    expect(scim.members).toEqual([]);
  });
});

describe("scimGroupToIdpGroupInput", () => {
  it("maps displayName to name and display_name", () => {
    const input = scimGroupToIdpGroupInput({ displayName: "Sales Team" });
    expect(input.display_name).toBe("Sales Team");
    expect(input.name).toBe("sales-team");
  });
});
