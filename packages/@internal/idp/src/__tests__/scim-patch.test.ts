import { describe, it, expect } from "vitest";
import { applyPatchOps } from "../scim/patch-handler.js";

describe("SCIM PATCH Handler", () => {
  describe("replace", () => {
    it("replaces scalar attribute", () => {
      const result = applyPatchOps(
        { active: true, displayName: "Old" },
        [{ op: "replace", path: "active", value: false }]
      );
      expect(result.active).toBe(false);
      expect(result.displayName).toBe("Old");
    });

    it("replaces nested attribute", () => {
      const result = applyPatchOps(
        { name: { givenName: "Old", familyName: "Smith" } },
        [{ op: "replace", path: "name.givenName", value: "New" }]
      );
      expect((result.name as any).givenName).toBe("New");
      expect((result.name as any).familyName).toBe("Smith");
    });

    it("merges top-level when no path", () => {
      const result = applyPatchOps(
        { active: true, displayName: "Old" },
        [{ op: "replace", value: { displayName: "New", locale: "en" } }]
      );
      expect(result.displayName).toBe("New");
      expect(result.locale).toBe("en");
      expect(result.active).toBe(true);
    });
  });

  describe("add", () => {
    it("adds new attribute", () => {
      const result = applyPatchOps(
        { displayName: "Alice" },
        [{ op: "add", path: "locale", value: "en" }]
      );
      expect(result.locale).toBe("en");
    });

    it("appends to array", () => {
      const result = applyPatchOps(
        { emails: [{ value: "old@test.com", type: "work" }] },
        [{ op: "add", path: "emails", value: [{ value: "new@test.com", type: "home" }] }]
      );
      expect((result.emails as any[]).length).toBe(2);
    });

    it("merges top-level when no path", () => {
      const result = applyPatchOps(
        { displayName: "Old" },
        [{ op: "add", value: { locale: "en", timezone: "UTC" } }]
      );
      expect(result.locale).toBe("en");
      expect(result.timezone).toBe("UTC");
    });
  });

  describe("remove", () => {
    it("removes attribute", () => {
      const result = applyPatchOps(
        { displayName: "Alice", locale: "en" },
        [{ op: "remove", path: "locale" }]
      );
      expect(result.locale).toBeUndefined();
      expect(result.displayName).toBe("Alice");
    });

    it("removes array element with value filter", () => {
      const result = applyPatchOps(
        { members: [
          { value: "1", display: "Alice" },
          { value: "2", display: "Bob" },
        ]},
        [{ op: "remove", path: 'members[value eq "1"]' }]
      );
      expect((result.members as any[]).length).toBe(1);
      expect((result.members as any[])[0].display).toBe("Bob");
    });
  });

  describe("multiple operations", () => {
    it("applies operations in sequence", () => {
      const result = applyPatchOps(
        { active: true, displayName: "Old" },
        [
          { op: "replace", path: "displayName", value: "New" },
          { op: "replace", path: "active", value: false },
        ]
      );
      expect(result.displayName).toBe("New");
      expect(result.active).toBe(false);
    });
  });

  describe("enterprise extension paths", () => {
    it("handles URN-prefixed paths", () => {
      const result = applyPatchOps(
        { "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User": { department: "Old" } },
        [{ op: "replace", path: "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department", value: "New" }]
      );
      const ext = result["urn:ietf:params:scim:schemas:extension:enterprise:2.0:User"] as any;
      expect(ext.department).toBe("New");
    });
  });

  describe("errors", () => {
    it("throws on invalid op", () => {
      expect(() => applyPatchOps({}, [{ op: "invalid" as any, path: "x", value: 1 }])).toThrow();
    });

    it("throws on remove without path", () => {
      expect(() => applyPatchOps({}, [{ op: "remove" }])).toThrow();
    });
  });
});
