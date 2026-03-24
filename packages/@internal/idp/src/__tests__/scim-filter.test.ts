import { describe, it, expect } from "vitest";
import { parseFilter } from "../scim/filter-parser.js";

describe("SCIM Filter Parser", () => {
  describe("simple comparisons", () => {
    it("eq string", () => {
      const fn = parseFilter('userName eq "alice@example.com"');
      expect(fn({ userName: "alice@example.com" })).toBe(true);
      expect(fn({ userName: "bob@example.com" })).toBe(false);
    });

    it("eq is case-insensitive for strings", () => {
      const fn = parseFilter('userName eq "ALICE@example.com"');
      expect(fn({ userName: "alice@example.com" })).toBe(true);
    });

    it("ne string", () => {
      const fn = parseFilter('userName ne "alice@example.com"');
      expect(fn({ userName: "bob@example.com" })).toBe(true);
      expect(fn({ userName: "alice@example.com" })).toBe(false);
    });

    it("co (contains)", () => {
      const fn = parseFilter('displayName co "Smith"');
      expect(fn({ displayName: "John Smith" })).toBe(true);
      expect(fn({ displayName: "John Doe" })).toBe(false);
    });

    it("sw (starts with)", () => {
      const fn = parseFilter('userName sw "alice"');
      expect(fn({ userName: "alice@example.com" })).toBe(true);
      expect(fn({ userName: "bob@example.com" })).toBe(false);
    });

    it("ew (ends with)", () => {
      const fn = parseFilter('userName ew "example.com"');
      expect(fn({ userName: "alice@example.com" })).toBe(true);
      expect(fn({ userName: "alice@other.com" })).toBe(false);
    });

    it("gt (greater than)", () => {
      const fn = parseFilter('meta.created gt "2026-01-01"');
      expect(fn({ meta: { created: "2026-06-01" } })).toBe(true);
      expect(fn({ meta: { created: "2025-06-01" } })).toBe(false);
    });

    it("ge (greater or equal)", () => {
      const fn = parseFilter('meta.created ge "2026-01-01"');
      expect(fn({ meta: { created: "2026-01-01" } })).toBe(true);
    });

    it("lt (less than)", () => {
      const fn = parseFilter('meta.created lt "2026-06-01"');
      expect(fn({ meta: { created: "2026-01-01" } })).toBe(true);
    });

    it("le (less or equal)", () => {
      const fn = parseFilter('meta.created le "2026-01-01"');
      expect(fn({ meta: { created: "2026-01-01" } })).toBe(true);
    });

    it("eq boolean", () => {
      const fn = parseFilter("active eq true");
      expect(fn({ active: true })).toBe(true);
      expect(fn({ active: false })).toBe(false);
    });

    it("eq number", () => {
      const fn = parseFilter("age eq 30");
      expect(fn({ age: 30 })).toBe(true);
      expect(fn({ age: 25 })).toBe(false);
    });

    it("eq null", () => {
      const fn = parseFilter("timezone eq null");
      expect(fn({ timezone: null })).toBe(true);
      expect(fn({ timezone: "UTC" })).toBe(false);
    });
  });

  describe("dot-path attributes", () => {
    it("resolves nested paths", () => {
      const fn = parseFilter('name.familyName eq "Smith"');
      expect(fn({ name: { familyName: "Smith" } })).toBe(true);
      expect(fn({ name: { familyName: "Doe" } })).toBe(false);
    });
  });

  describe("presence (pr)", () => {
    it("checks attribute exists and is not null", () => {
      const fn = parseFilter("displayName pr");
      expect(fn({ displayName: "Alice" })).toBe(true);
      expect(fn({ displayName: null })).toBe(false);
      expect(fn({})).toBe(false);
    });
  });

  describe("logical operators", () => {
    it("and", () => {
      const fn = parseFilter('active eq true and name.givenName sw "A"');
      expect(fn({ active: true, name: { givenName: "Alice" } })).toBe(true);
      expect(fn({ active: false, name: { givenName: "Alice" } })).toBe(false);
      expect(fn({ active: true, name: { givenName: "Bob" } })).toBe(false);
    });

    it("or", () => {
      const fn = parseFilter(
        'name.givenName eq "Alice" or name.givenName eq "Bob"'
      );
      expect(fn({ name: { givenName: "Alice" } })).toBe(true);
      expect(fn({ name: { givenName: "Bob" } })).toBe(true);
      expect(fn({ name: { givenName: "Charlie" } })).toBe(false);
    });

    it("not", () => {
      const fn = parseFilter("not (active eq true)");
      expect(fn({ active: false })).toBe(true);
      expect(fn({ active: true })).toBe(false);
    });
  });

  describe("nested parentheses", () => {
    it("groups expressions", () => {
      const fn = parseFilter(
        '(name.givenName eq "A" or name.givenName eq "B") and active eq true'
      );
      expect(fn({ name: { givenName: "A" }, active: true })).toBe(true);
      expect(fn({ name: { givenName: "A" }, active: false })).toBe(false);
      expect(fn({ name: { givenName: "C" }, active: true })).toBe(false);
    });
  });

  describe("value path filters", () => {
    it("filters multi-valued attributes", () => {
      const fn = parseFilter(
        'emails[type eq "work"].value eq "alice@work.com"'
      );
      expect(
        fn({
          emails: [
            { value: "alice@home.com", type: "home" },
            { value: "alice@work.com", type: "work" },
          ],
        })
      ).toBe(true);
      expect(
        fn({
          emails: [{ value: "alice@home.com", type: "home" }],
        })
      ).toBe(false);
    });
  });

  describe("enterprise extension URN paths", () => {
    it("handles URN-prefixed attributes", () => {
      const fn = parseFilter(
        'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department eq "Engineering"'
      );
      expect(
        fn({
          "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User": {
            department: "Engineering",
          },
        })
      ).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("throws on empty filter", () => {
      expect(() => parseFilter("")).toThrow();
    });

    it("throws on malformed filter", () => {
      expect(() => parseFilter("userName eq")).toThrow();
    });

    it("throws on unbalanced parens", () => {
      expect(() => parseFilter("(active eq true")).toThrow();
    });
  });
});
