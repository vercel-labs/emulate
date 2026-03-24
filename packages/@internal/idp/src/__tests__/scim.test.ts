import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { Store, WebhookDispatcher, type TokenMap } from "@internal/core";
import { idpPlugin, seedFromConfig, type IdpSeedConfig } from "../index.js";
import { getIdpStore } from "../store.js";
import { SCIM_USER_SCHEMA, SCIM_GROUP_SCHEMA, SCIM_ENTERPRISE_USER_SCHEMA } from "../scim/constants.js";

// Note: SCIM uses its own bearer token auth middleware at the route level,
// not the shared authMiddleware. This matches the real app stack.
function createScimTestApp(config?: IdpSeedConfig) {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  const app = new Hono();
  idpPlugin.register(app as any, store, webhooks, "http://localhost:4003", tokenMap);
  idpPlugin.seed!(store, "http://localhost:4003");
  if (config) seedFromConfig(store, "http://localhost:4003", config);
  return { app, store, tokenMap };
}

const defaultConfig: IdpSeedConfig = {
  users: [
    {
      email: "alice@example.com",
      name: "Alice Smith",
      given_name: "Alice",
      family_name: "Smith",
      groups: ["engineering"],
      roles: ["admin"],
      attributes: { department: "Engineering", employee_id: "E-1001" },
    },
    {
      email: "bob@example.com",
      name: "Bob Jones",
      given_name: "Bob",
      family_name: "Jones",
      groups: ["sales"],
      attributes: { department: "Sales" },
    },
  ],
  groups: [
    { name: "engineering", display_name: "Engineering" },
    { name: "sales", display_name: "Sales" },
  ],
  scim: { bearer_token: "test-scim-token" },
};

function authHeaders(token = "test-scim-token") {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/scim+json" };
}

describe("SCIM Discovery", () => {
  it("GET /scim/v2/ServiceProviderConfig", async () => {
    const { app } = createScimTestApp(defaultConfig);
    const res = await app.request("/scim/v2/ServiceProviderConfig");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.patch.supported).toBe(true);
    expect(body.filter.supported).toBe(true);
  });

  it("GET /scim/v2/ResourceTypes", async () => {
    const { app } = createScimTestApp(defaultConfig);
    const res = await app.request("/scim/v2/ResourceTypes");
    expect(res.status).toBe(200);
  });

  it("GET /scim/v2/Schemas", async () => {
    const { app } = createScimTestApp(defaultConfig);
    const res = await app.request("/scim/v2/Schemas");
    expect(res.status).toBe(200);
  });
});

describe("SCIM Users", () => {
  it("lists all users", async () => {
    const { app } = createScimTestApp(defaultConfig);
    const res = await app.request("/scim/v2/Users", { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalResults).toBe(3); // 1 default + 2 seeded
    expect(body.Resources.map((r: any) => r.userName)).toContain("alice@example.com");
  });

  it("gets user by id", async () => {
    const { app, store } = createScimTestApp(defaultConfig);
    const idp = getIdpStore(store);
    const user = idp.users.findOneBy("email", "alice@example.com");
    const res = await app.request(`/scim/v2/Users/${user!.id}`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userName).toBe("alice@example.com");
    expect(body.name.givenName).toBe("Alice");
    expect(body[SCIM_ENTERPRISE_USER_SCHEMA]?.department).toBe("Engineering");
  });

  it("returns 404 for unknown user id", async () => {
    const { app } = createScimTestApp(defaultConfig);
    const res = await app.request("/scim/v2/Users/99999", { headers: authHeaders() });
    expect(res.status).toBe(404);
  });

  it("creates user via POST", async () => {
    const { app } = createScimTestApp(defaultConfig);
    const res = await app.request("/scim/v2/Users", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        schemas: [SCIM_USER_SCHEMA],
        userName: "charlie@example.com",
        name: { givenName: "Charlie", familyName: "Brown" },
        displayName: "Charlie Brown",
        active: true,
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.userName).toBe("charlie@example.com");
    expect(typeof body.id).toBe("string");
    expect(res.headers.get("Location")).toContain("/scim/v2/Users/");
  });

  it("rejects duplicate userName with SCIM error format", async () => {
    const { app } = createScimTestApp(defaultConfig);
    const res = await app.request("/scim/v2/Users", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ schemas: [SCIM_USER_SCHEMA], userName: "alice@example.com", name: { givenName: "Dupe" } }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.schemas).toContain("urn:ietf:params:scim:api:messages:2.0:Error");
    expect(body.status).toBe("409");
    expect(body.scimType).toBe("uniqueness");
    expect(body.detail).toBeDefined();
  });

  it("rejects POST with missing userName", async () => {
    const { app } = createScimTestApp(defaultConfig);
    const res = await app.request("/scim/v2/Users", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        schemas: [SCIM_USER_SCHEMA],
        name: { givenName: "No", familyName: "Email" },
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain("userName");
  });

  it("replaces user via PUT", async () => {
    const { app, store } = createScimTestApp(defaultConfig);
    const idp = getIdpStore(store);
    const user = idp.users.findOneBy("email", "alice@example.com");
    const res = await app.request(`/scim/v2/Users/${user!.id}`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({
        schemas: [SCIM_USER_SCHEMA],
        userName: "alice@example.com",
        name: { givenName: "Alice", familyName: "Updated" },
        displayName: "Alice Updated",
        active: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name.familyName).toBe("Updated");
  });

  it("patches user via PATCH", async () => {
    const { app, store } = createScimTestApp(defaultConfig);
    const idp = getIdpStore(store);
    const user = idp.users.findOneBy("email", "alice@example.com");
    const res = await app.request(`/scim/v2/Users/${user!.id}`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", path: "active", value: false }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.active).toBe(false);
  });

  it("deletes user via DELETE", async () => {
    const { app, store } = createScimTestApp(defaultConfig);
    const idp = getIdpStore(store);
    const user = idp.users.findOneBy("email", "bob@example.com");
    const res = await app.request(`/scim/v2/Users/${user!.id}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(res.status).toBe(204);

    const getRes = await app.request(`/scim/v2/Users/${user!.id}`, { headers: authHeaders() });
    expect(getRes.status).toBe(404);
  });

  it("filters users by userName", async () => {
    const { app } = createScimTestApp(defaultConfig);
    const res = await app.request('/scim/v2/Users?filter=userName eq "alice@example.com"', { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalResults).toBe(1);
    expect(body.Resources[0].userName).toBe("alice@example.com");
  });

  it("paginates users", async () => {
    const { app } = createScimTestApp(defaultConfig);
    const res = await app.request("/scim/v2/Users?startIndex=1&count=1", { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.itemsPerPage).toBe(1);
    expect(body.Resources.length).toBe(1);
    expect(body.startIndex).toBe(1);
  });

  it("returns 401 with wrong token", async () => {
    const { app } = createScimTestApp(defaultConfig);
    const res = await app.request("/scim/v2/Users", { headers: authHeaders("wrong-token") });
    expect(res.status).toBe(401);
  });

  it("returns application/scim+json content type", async () => {
    const { app } = createScimTestApp(defaultConfig);
    const res = await app.request("/scim/v2/Users", { headers: authHeaders() });
    expect(res.headers.get("Content-Type")).toContain("application/scim+json");
  });

  it("allows access when no SCIM token configured", async () => {
    const { app } = createScimTestApp({ users: [{ email: "test@test.com" }] });
    const res = await app.request("/scim/v2/Users");
    expect(res.status).toBe(200);
  });

  it("returns 401 with missing Authorization header", async () => {
    const { app } = createScimTestApp(defaultConfig);
    const res = await app.request("/scim/v2/Users");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.status).toBe("401");
  });
});

describe("SCIM Groups", () => {
  it("lists all groups", async () => {
    const { app } = createScimTestApp(defaultConfig);
    const res = await app.request("/scim/v2/Groups", { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalResults).toBe(2);
  });

  it("creates group via POST", async () => {
    const { app } = createScimTestApp(defaultConfig);
    const res = await app.request("/scim/v2/Groups", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        schemas: [SCIM_GROUP_SCHEMA],
        displayName: "Marketing",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.displayName).toBe("Marketing");
  });

  it("patches group to add member", async () => {
    const { app, store } = createScimTestApp(defaultConfig);
    const idp = getIdpStore(store);
    const group = idp.groups.findOneBy("name", "engineering");
    const bob = idp.users.findOneBy("email", "bob@example.com");

    // Bob is not in engineering initially
    expect(bob!.groups).not.toContain("engineering");

    const res = await app.request(`/scim/v2/Groups/${group!.id}`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "add", path: "members", value: [{ value: String(bob!.id) }] }],
      }),
    });
    expect(res.status).toBe(200);

    // Verify bob's groups[] was updated
    const updatedBob = idp.users.get(bob!.id);
    expect(updatedBob!.groups).toContain("engineering");
  });

  it("patches group to remove member", async () => {
    const { app, store } = createScimTestApp(defaultConfig);
    const idp = getIdpStore(store);
    const group = idp.groups.findOneBy("name", "engineering");
    const alice = idp.users.findOneBy("email", "alice@example.com");

    // Alice is in engineering
    expect(alice!.groups).toContain("engineering");

    const res = await app.request(`/scim/v2/Groups/${group!.id}`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "remove", path: `members[value eq "${alice!.id}"]` }],
      }),
    });
    expect(res.status).toBe(200);

    // Verify alice's groups[] was updated
    const updatedAlice = idp.users.get(alice!.id);
    expect(updatedAlice!.groups).not.toContain("engineering");
  });

  it("gets group by id", async () => {
    const { app, store } = createScimTestApp(defaultConfig);
    const idp = getIdpStore(store);
    const group = idp.groups.findOneBy("name", "engineering");
    const res = await app.request(`/scim/v2/Groups/${group!.id}`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.displayName).toBe("Engineering");
    expect(body.id).toBe(String(group!.id));
  });

  it("returns 404 for unknown group id", async () => {
    const { app } = createScimTestApp(defaultConfig);
    const res = await app.request("/scim/v2/Groups/99999", { headers: authHeaders() });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.detail).toBeDefined();
    expect(body.status).toBe("404");
  });

  it("replaces group via PUT", async () => {
    const { app, store } = createScimTestApp(defaultConfig);
    const idp = getIdpStore(store);
    const group = idp.groups.findOneBy("name", "engineering");
    const res = await app.request(`/scim/v2/Groups/${group!.id}`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({
        schemas: [SCIM_GROUP_SCHEMA],
        displayName: "Engineering Team",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.displayName).toBe("Engineering Team");
  });

  it("deletes group and removes from user groups", async () => {
    const { app, store } = createScimTestApp(defaultConfig);
    const idp = getIdpStore(store);
    const group = idp.groups.findOneBy("name", "sales");
    const bob = idp.users.findOneBy("email", "bob@example.com");
    expect(bob!.groups).toContain("sales");

    const res = await app.request(`/scim/v2/Groups/${group!.id}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(res.status).toBe(204);

    // Verify group removed from user
    const updatedBob = idp.users.get(bob!.id);
    expect(updatedBob!.groups).not.toContain("sales");

    // Verify group is gone
    const getRes = await app.request(`/scim/v2/Groups/${group!.id}`, { headers: authHeaders() });
    expect(getRes.status).toBe(404);
  });
});
