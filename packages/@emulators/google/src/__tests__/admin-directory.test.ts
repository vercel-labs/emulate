import { describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher, authMiddleware, type AppEnv, type TokenMap } from "@emulators/core";
import { googlePlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";
const directory = "/admin/directory/v1";
const scope = (name: string) => `https://www.googleapis.com/auth/${name}`;
const adminScopes = [scope("admin.directory.user"), scope("admin.directory.group")].join(" ");
const client = { client_id: "directory-client", client_secret: "directory-secret" };
const redirectUri = "http://127.0.0.1:8080/";
const admin = "admin@example.com";
const staff = "staff@example.com";

function fixture(strict = true) {
  const app = new Hono<AppEnv>();
  const store = new Store();
  const tokens: TokenMap = new Map();
  const fallback = { login: admin, id: 1, scopes: [] };
  app.use("*", authMiddleware(tokens, undefined, fallback));
  googlePlugin.register(app, store, new WebhookDispatcher(), base, tokens);
  googlePlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    strict_scopes: strict,
    customer_id: "C0example",
    users: [
      { email: admin, name: "Ada Admin", is_admin: true },
      { email: staff, name: "Sam Staff" },
    ],
    oauth_clients: [{ ...client, redirect_uris: [redirectUri] }],
  });

  function request(path: string, token?: string, method = "GET", body?: unknown) {
    return app.request(`${base}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  function signIn(email: string, scopes: string) {
    return app.request(`${base}/o/oauth2/v2/auth/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email, redirect_uri: redirectUri, scope: scopes, client_id: client.client_id }),
    });
  }

  async function token(email = admin, scopes = adminScopes): Promise<string> {
    const authorize = await signIn(email, scopes);
    expect(authorize.status).toBe(302);
    const code = new URL(authorize.headers.get("Location")!).searchParams.get("code")!;
    const exchange = await app.request(`${base}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...client, grant_type: "authorization_code", code, redirect_uri: redirectUri }),
    });
    expect(exchange.status).toBe(200);
    return ((await exchange.json()) as { access_token: string }).access_token;
  }

  return { app, store, request, signIn, token };
}

const newUser = (email: string, extra: Record<string, unknown> = {}) => ({
  primaryEmail: email,
  name: { givenName: "Nina", familyName: "Nurse" },
  password: "correct-horse-battery",
  ...extra,
});

describe("Google Admin SDK Directory API", () => {
  it("serves its discovery document at the v1 and v2 discovery URLs, rooted at the emulator", async () => {
    const { request } = fixture();
    for (const path of ["/discovery/v1/apis/admin/directory_v1/rest", "/$discovery/rest?version=directory_v1"]) {
      const response = await request(path);
      expect(response.status).toBe(200);
      const doc = (await response.json()) as Record<string, any>;
      expect(doc).toMatchObject({ id: "admin:directory_v1", rootUrl: `${base}/`, servicePath: "" });
      expect(doc.resources.users.methods.insert).toMatchObject({
        httpMethod: "POST",
        path: "admin/directory/v1/users",
      });
      expect(Object.keys(doc.resources.members.methods)).toContain("hasMember");
    }
    expect((await request("/$discovery/rest?version=v1")).status).toBe(404);
  });

  it("creates, reads, lists and updates users", async () => {
    const { request, token } = fixture();
    const auth = await token();

    const created = await request(`${directory}/users`, auth, "POST", newUser("nina@example.com"));
    expect(created.status).toBe(200);
    const user = (await created.json()) as Record<string, any>;
    expect(user).toMatchObject({
      kind: "admin#directory#user",
      primaryEmail: "nina@example.com",
      name: { givenName: "Nina", familyName: "Nurse", fullName: "Nina Nurse" },
      isAdmin: false,
      suspended: false,
      orgUnitPath: "/",
      customerId: "C0example",
    });
    expect(user.id).toMatch(/^1\d{20}$/);
    expect(user).toMatchObject({
      lastLoginTime: "1970-01-01T00:00:00.000Z",
      agreedToTerms: false,
      isMailboxSetup: true,
      nonEditableAliases: ["nina@example.com.test-google-a.com"],
      emails: [{ address: "nina@example.com", primary: true }, { address: "nina@example.com.test-google-a.com" }],
    });
    expect(user.etag).toMatch(/^"[\w-]{43}\/[\w-]{27}"$/);
    expect(user).not.toHaveProperty("password");

    for (const key of ["nina@example.com", "NINA@example.com", user.id]) {
      const got = await request(`${directory}/users/${encodeURIComponent(key)}`, auth);
      expect(got.status).toBe(200);
      expect(await got.json()).toMatchObject({ id: user.id });
    }

    const updated = await request(`${directory}/users/${user.id}`, auth, "PUT", {
      name: { givenName: "Nina", familyName: "Martin" },
      isAdmin: true,
    });
    expect(await updated.json()).toMatchObject({ name: { familyName: "Martin" }, isAdmin: false, suspended: false });

    const listed = await request(`${directory}/users?customer=my_customer&maxResults=2`, auth);
    const first = (await listed.json()) as Record<string, any>;
    expect(first.users.map((u: { primaryEmail: string }) => u.primaryEmail)).toEqual([admin, "nina@example.com"]);
    const second = await request(
      `${directory}/users?customer=C0example&maxResults=2&pageToken=${first.nextPageToken}`,
      auth,
    );
    const rest = (await second.json()) as Record<string, any>;
    expect(rest.users.map((u: { primaryEmail: string }) => u.primaryEmail)).toEqual([staff]);
    expect(rest).not.toHaveProperty("nextPageToken");
  });

  it("returns partial responses for the fields parameter", async () => {
    const { request, token } = fixture();
    const auth = await token();
    const response = await request(
      `${directory}/users?domain=example.com&fields=nextPageToken,users(primaryEmail,name/givenName,suspended)`,
      auth,
    );
    expect(await response.json()).toEqual({
      users: [
        { primaryEmail: admin, name: { givenName: "Ada" }, suspended: false },
        { primaryEmail: staff, name: { givenName: "Sam" }, suspended: false },
      ],
    });
  });

  it("refuses invalid users with Google's error reasons", async () => {
    const { request, token } = fixture();
    const auth = await token();
    const cases: Array<[unknown, number, string]> = [
      [{ ...newUser("a@example.com"), primaryEmail: undefined }, 400, "required"],
      [{ ...newUser("a@example.com"), name: { givenName: "A" } }, 400, "required"],
      [{ ...newUser("a@example.com"), password: undefined }, 400, "required"],
      [newUser("a@example.com", { password: "short" }), 400, "invalid"],
      [newUser("a@example.com", { password: "abc", hashFunction: "SHA-1" }), 400, "invalid"],
      [newUser("a@example.com", { name: { givenName: "A".repeat(61), familyName: "B" } }), 400, "invalid"],
      [newUser(staff), 409, "duplicate"],
    ];
    for (const [body, status, reason] of cases) {
      const response = await request(`${directory}/users`, auth, "POST", body);
      expect(response.status, JSON.stringify(body)).toBe(status);
      expect(await response.json()).toMatchObject({ error: { code: status, errors: [{ reason, domain: "global" }] } });
    }
    const accepted = await request(
      `${directory}/users`,
      auth,
      "POST",
      newUser("b@example.com", { password: "a94a8fe5ccb19ba61c4c0873d391e987982fbbd3", hashFunction: "SHA-1" }),
    );
    expect(accepted.status).toBe(200);

    const missing = await request(`${directory}/users/nobody@example.com`, auth);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: { message: "Resource Not Found: userKey", errors: [{ reason: "notFound" }] },
    });
    const taken = await request(`${directory}/users`, auth, "POST", newUser(staff));
    expect(await taken.json()).toMatchObject({ error: { code: 409, message: "Entity already exists." } });
    expect((await request(`${directory}/users`, auth)).status).toBe(400);
    expect((await request(`${directory}/users?customer=my_customer&showDeleted=false`, auth)).status).toBe(200);
    for (const unsupported of ["showDeleted=true", "query=isSuspended%3Dtrue", "event=add", "customFieldMask=hr"]) {
      const response = await request(`${directory}/users?customer=my_customer&${unsupported}`, auth);
      expect(response.status, unsupported).toBe(400);
    }
    expect((await request(`${directory}/users?customer=C0other`, auth)).status).toBe(400);
    const unknownDomain = await request(`${directory}/users?domain=other.example`, auth);
    expect(unknownDomain.status).toBe(404);
    expect(await unknownDomain.json()).toMatchObject({
      error: { message: "Domain not found.", errors: [{ reason: "notFound" }] },
    });
  });

  it("suspends a user, who then cannot sign in, and restores them", async () => {
    const { request, signIn, token } = fixture();
    const auth = await token();
    const suspended = await request(`${directory}/users/${staff}`, auth, "PATCH", { suspended: true });
    expect(await suspended.json()).toMatchObject({ suspended: true, suspensionReason: "ADMIN" });
    const customer = (await (await request(`${directory}/users/${staff}`, auth)).json()) as { customerId: string };
    expect(customer.customerId).toBe("C0example");

    const refused = await signIn(staff, "openid email");
    expect(refused.status).toBe(403);
    expect(refused.headers.get("Location")).toBeNull();

    const restored = await request(`${directory}/users/${staff}`, auth, "PUT", { suspended: false });
    const body = (await restored.json()) as Record<string, unknown>;
    expect(body.suspended).toBe(false);
    expect(body).not.toHaveProperty("suspensionReason");
    expect((await signIn(staff, "openid email")).status).toBe(302);
  });

  it("makes a user a super administrator and back with users.makeAdmin", async () => {
    const { request, token } = fixture();
    const auth = await token();
    const promoted = await request(`${directory}/users/${staff}/makeAdmin`, auth, "POST", { status: true });
    expect(promoted.status).toBe(200);
    expect(await promoted.text()).toBe("");
    expect(await (await request(`${directory}/users/${staff}`, auth)).json()).toMatchObject({ isAdmin: true });
    const staffToken = await token(staff, scope("admin.directory.user"));
    expect((await request(`${directory}/users?customer=my_customer`, staffToken)).status).toBe(200);

    const demoted = await request(`${directory}/users/${staff}/makeAdmin`, auth, "POST", { status: false });
    expect(demoted.status).toBe(200);
    expect(await (await request(`${directory}/users/${staff}`, auth)).json()).toMatchObject({ isAdmin: false });
    expect((await request(`${directory}/users?customer=my_customer`, staffToken)).status).toBe(403);

    const missing = await request(`${directory}/users/${staff}/makeAdmin`, auth, "POST", {});
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: { errors: [{ reason: "required" }] } });
    const unknown = await request(`${directory}/users/nobody@example.com/makeAdmin`, auth, "POST", { status: true });
    expect(unknown.status).toBe(404);
    expect((await request(`${directory}/users/${admin}/makeAdmin`, staffToken, "POST", { status: true })).status).toBe(
      403,
    );
  });

  it("deletes a user, their memberships and their sign-in", async () => {
    const { app, request, signIn, token } = fixture();
    const auth = await token();
    await request(`${directory}/groups`, auth, "POST", { email: "nurses@example.com" });
    await request(`${directory}/groups/nurses@example.com/members`, auth, "POST", { email: staff });
    const staffToken = await token(staff, "openid email");

    const deleted = await request(`${directory}/users/${staff}`, auth, "DELETE");
    expect(deleted.status).toBe(200);
    expect(await deleted.text()).toBe("");
    expect((await request(`${directory}/users/${staff}`, auth)).status).toBe(404);
    const members = await request(`${directory}/groups/nurses@example.com/members`, auth);
    expect(await members.json()).toMatchObject({ members: [] });

    const authorize = await signIn(staff, "openid email");
    const code = new URL(authorize.headers.get("Location")!).searchParams.get("code")!;
    const exchange = await app.request(`${base}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...client, grant_type: "authorization_code", code, redirect_uri: redirectUri }),
    });
    expect(exchange.status).toBe(400);
    expect((await request("/oauth2/v2/userinfo", staffToken)).status).toBe(401);
  });

  it("manages groups and their members", async () => {
    const { request, token } = fixture();
    const auth = await token();
    const created = await request(`${directory}/groups`, auth, "POST", {
      email: "nurses@example.com",
      name: "Nurses",
      description: "Care staff",
    });
    const group = (await created.json()) as Record<string, any>;
    expect(group.id).toMatch(/^0[0-9a-z]{14}$/);
    expect(group).toMatchObject({
      kind: "admin#directory#group",
      nonEditableAliases: ["nurses@example.com.test-google-a.com"],
      email: "nurses@example.com",
      name: "Nurses",
      directMembersCount: "0",
      adminCreated: true,
    });
    expect((await request(`${directory}/groups`, auth, "POST", { email: "nurses@example.com" })).status).toBe(409);
    expect((await request(`${directory}/groups`, auth, "POST", { email: staff })).status).toBe(409);
    expect((await request(`${directory}/groups`, auth, "POST", { name: "No email" })).status).toBe(400);

    const added = await request(`${directory}/groups/${group.id}/members`, auth, "POST", { email: staff });
    expect(await added.json()).toMatchObject({
      kind: "admin#directory#member",
      email: staff,
      role: "MEMBER",
      type: "USER",
    });
    const again = await request(`${directory}/groups/${group.id}/members`, auth, "POST", { email: staff });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({
      error: { message: "Member already exists.", errors: [{ reason: "duplicate" }] },
    });
    const notMember = await request(`${directory}/groups/${group.id}/members/${admin}`, auth);
    expect(notMember.status).toBe(404);
    expect(await notMember.json()).toMatchObject({ error: { message: "Resource Not Found: memberKey" } });
    const noAccount = await request(`${directory}/groups/${group.id}/members/nobody@example.com`, auth);
    expect(noAccount.status).toBe(400);
    expect(await noAccount.json()).toMatchObject({
      error: { message: "Missing required field: memberKey", errors: [{ reason: "required" }] },
    });
    const unknownId = await request(`${directory}/groups/${group.id}/members`, auth, "POST", { id: "123" });
    expect(await unknownId.json()).toMatchObject({ error: { code: 400, message: "Invalid Input: memberKey" } });

    await request(`${directory}/groups`, auth, "POST", { email: "care@example.com" });
    const nested = await request(`${directory}/groups/care@example.com/members`, auth, "POST", {
      email: "nurses@example.com",
    });
    expect(await nested.json()).toMatchObject({ type: "GROUP" });
    const cycle = await request(`${directory}/groups/nurses@example.com/members`, auth, "POST", {
      email: "care@example.com",
    });
    expect(cycle.status).toBe(412);
    expect(await cycle.json()).toMatchObject({
      error: { message: "Cyclic memberships not allowed", errors: [{ reason: "conditionNotMet" }] },
    });

    const hasMember = await request(`${directory}/groups/care@example.com/hasMember/${staff}`, auth);
    expect(await hasMember.json()).toEqual({ isMember: true });
    const derived = await request(`${directory}/groups/care@example.com/members?includeDerivedMembership=true`, auth);
    expect(await derived.json()).toMatchObject({ members: [{ email: staff }] });

    const promoted = await request(`${directory}/groups/${group.id}/members/${staff}`, auth, "PATCH", {
      role: "MANAGER",
    });
    expect(await promoted.json()).toMatchObject({ role: "MANAGER" });
    const managers = await request(`${directory}/groups/${group.id}/members?roles=MANAGER,OWNER`, auth);
    expect(await managers.json()).toMatchObject({ members: [{ email: staff, role: "MANAGER" }] });

    const ofUser = await request(`${directory}/groups?userKey=${staff}`, auth);
    expect(await ofUser.json()).toMatchObject({
      groups: [{ email: "nurses@example.com", directMembersCount: "1" }],
    });

    expect((await request(`${directory}/groups/${group.id}/members/${staff}`, auth, "DELETE")).status).toBe(200);
    expect((await request(`${directory}/groups/${group.id}/members/${staff}`, auth, "DELETE")).status).toBe(404);
    const patched = await request(`${directory}/groups/${group.id}`, auth, "PATCH", { description: "Nursing staff" });
    expect(await patched.json()).toMatchObject({ name: "Nurses", description: "Nursing staff" });
    expect((await request(`${directory}/groups/care@example.com`, auth, "DELETE")).status).toBe(200);
    const listed = await request(`${directory}/groups?customer=my_customer`, auth);
    expect(await listed.json()).toMatchObject({ groups: [{ email: "nurses@example.com" }] });
  });

  it("requires a super administrator and the Directory scopes in strict mode", async () => {
    const { request, token } = fixture();
    const anonymous = await request(`${directory}/users?customer=my_customer`);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({
      error: {
        code: 401,
        status: "UNAUTHENTICATED",
        errors: [{ message: "Login Required.", reason: "required", location: "Authorization" }],
      },
    });
    const madeUp = await request(`${directory}/users?customer=my_customer`, "made-up");
    expect(madeUp.status).toBe(401);
    expect(await madeUp.json()).toMatchObject({
      error: { errors: [{ message: "Invalid Credentials", reason: "authError", locationType: "header" }] },
    });

    const staffToken = await token(staff, scope("admin.directory.user"));
    const forbidden = await request(`${directory}/users?customer=my_customer`, staffToken);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({
      error: { message: "Not Authorized to access this resource/api", errors: [{ reason: "forbidden" }] },
    });

    const readOnly = await token(admin, scope("admin.directory.user.readonly"));
    expect((await request(`${directory}/users?customer=my_customer`, readOnly)).status).toBe(200);
    const write = await request(`${directory}/users`, readOnly, "POST", newUser("c@example.com"));
    expect(write.status).toBe(403);
    expect(await write.json()).toMatchObject({ error: { errors: [{ reason: "insufficientPermissions" }] } });
    expect((await request(`${directory}/groups?customer=my_customer`, readOnly)).status).toBe(403);

    const memberScope = await token(admin, scope("admin.directory.group.member"));
    expect((await request(`${directory}/groups`, memberScope, "POST", { email: "x@example.com" })).status).toBe(403);
  });

  it("uses Google's identifier formats and records the last sign-in", async () => {
    const app = new Hono<AppEnv>();
    const store = new Store();
    const tokens: TokenMap = new Map();
    app.use("*", authMiddleware(tokens, undefined, { login: admin, id: 1, scopes: [] }));
    googlePlugin.register(app, store, new WebhookDispatcher(), base, tokens);
    seedFromConfig(store, base, { users: [{ email: admin, name: "Ada Admin", is_admin: true }] });
    const response = await app.request(`${base}${directory}/users/${admin}`, {
      headers: { Authorization: "Bearer x" },
    });
    const user = (await response.json()) as { customerId: string; lastLoginTime: string };
    expect(user.customerId).toMatch(/^C0[0-9a-z]{7}$/);
    expect(user.lastLoginTime).toBe("1970-01-01T00:00:00.000Z");

    const { request, token } = fixture();
    const auth = await token();
    const signedIn = (await (await request(`${directory}/users/${admin}`, auth)).json()) as Record<string, unknown>;
    expect(signedIn.lastLoginTime).not.toBe("1970-01-01T00:00:00.000Z");
    expect(signedIn.agreedToTerms).toBe(true);
  });

  it("keeps the default permissive mode", async () => {
    const { request } = fixture(false);
    const response = await request(`${directory}/users`, "any-token", "POST", newUser("d@example.com"));
    expect(response.status).toBe(200);
    expect((await request(`${directory}/users/d@example.com`, "any-token")).status).toBe(200);
  });
});
