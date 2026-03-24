import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ScimClient } from "../scim/client.js";
import type { ScimUser } from "../scim/types.js";
import { SCIM_USER_SCHEMA } from "../scim/constants.js";

const mockUser: ScimUser = {
  schemas: [SCIM_USER_SCHEMA],
  id: "1",
  userName: "alice@example.com",
  displayName: "Alice",
  active: true,
};

describe("ScimClient", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(mockUser), { status: 201 })
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("createUser sends POST with correct headers", async () => {
    const client = new ScimClient({ target_url: "http://localhost:1769/api/auth/scim/v2", bearer_token: "test-token" });
    await client.createUser(mockUser);

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:1769/api/auth/scim/v2/Users",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
          "Content-Type": "application/scim+json",
        }),
      })
    );
  });

  it("patchUser sends PATCH with PatchOp schema", async () => {
    const client = new ScimClient({ target_url: "http://localhost/scim/v2", bearer_token: "tok" });
    await client.patchUser("1", [{ op: "replace", path: "active", value: false }]);

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost/scim/v2/Users/1",
      expect.objectContaining({ method: "PATCH" })
    );
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.schemas).toContain("urn:ietf:params:scim:api:messages:2.0:PatchOp");
    expect(body.Operations[0].op).toBe("replace");
  });

  it("deleteUser sends DELETE", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));
    const client = new ScimClient({ target_url: "http://localhost/scim/v2", bearer_token: "tok" });
    await client.deleteUser("1");

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost/scim/v2/Users/1",
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("handles fetch errors gracefully", async () => {
    fetchSpy.mockRejectedValue(new Error("Connection refused"));
    const client = new ScimClient({ target_url: "http://localhost/scim/v2", bearer_token: "tok" });

    // Should not throw
    await expect(client.createUser(mockUser)).resolves.toBeUndefined();
  });

  it("createGroup sends POST to /Groups", async () => {
    const client = new ScimClient({ target_url: "http://localhost/scim/v2", bearer_token: "tok" });
    await client.createGroup({ schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], id: "1", displayName: "Eng" });

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost/scim/v2/Groups",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("updateUser sends PUT", async () => {
    const client = new ScimClient({ target_url: "http://localhost/scim/v2", bearer_token: "tok" });
    await client.updateUser("1", mockUser);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost/scim/v2/Users/1",
      expect.objectContaining({ method: "PUT" })
    );
  });

  it("deleteGroup sends DELETE to /Groups", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));
    const client = new ScimClient({ target_url: "http://localhost/scim/v2", bearer_token: "tok" });
    await client.deleteGroup("5");
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost/scim/v2/Groups/5",
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("strips trailing slash from target_url", async () => {
    const client = new ScimClient({ target_url: "http://localhost/scim/v2/", bearer_token: "tok" });
    await client.createUser(mockUser);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost/scim/v2/Users",
      expect.anything()
    );
  });
});
