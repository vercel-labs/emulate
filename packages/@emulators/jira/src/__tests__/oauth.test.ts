import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CLOUD_ID, getJiraStore } from "../index.js";
import { adf, api, createJiraTestApp, jiraTestBaseUrl, type JiraTestApp } from "./helpers.js";

const CLIENT_ID = "jira_example_client_id";
const CLIENT_SECRET = "example_client_secret";
const REDIRECT = "http://localhost:3000/api/auth/callback/atlassian";

describe("Atlassian OAuth 2.0 (3LO) and the API gateway", () => {
  let t: JiraTestApp;

  beforeEach(() => {
    t = createJiraTestApp();
  });

  const authorizeUrl = (params: Record<string, string> = {}) => {
    const search = new URLSearchParams({
      audience: "api.atlassian.com",
      client_id: CLIENT_ID,
      scope: "read:jira-work write:jira-work read:jira-user offline_access",
      redirect_uri: REDIRECT,
      state: "xyz",
      response_type: "code",
      prompt: "consent",
      ...params,
    });
    return `${jiraTestBaseUrl}/authorize?${search}`;
  };

  async function authorize(scope?: string): Promise<string> {
    const admin = getJiraStore(t.store).users.findOneBy("email", "admin@jira.local")!;
    const form = new URLSearchParams({
      account_id: admin.account_id,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      scope: scope ?? "read:jira-work write:jira-work read:jira-user offline_access",
      state: "xyz",
    });
    const res = await t.app.request(`${jiraTestBaseUrl}/authorize/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get("state")).toBe("xyz");
    return location.searchParams.get("code")!;
  }

  async function exchange(body: Record<string, string>) {
    return api(t.app, "/oauth/token", { method: "POST", auth: null, body });
  }

  it("renders the consent page listing users", async () => {
    const res = await t.app.request(authorizeUrl());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("admin@jira.local");
    expect(html).toContain("My Jira App");
    expect(html).toContain("read:jira-work");
  });

  it("rejects unknown clients, bad redirect URIs, and unregistered scopes", async () => {
    expect((await t.app.request(authorizeUrl({ client_id: "nope" }))).status).toBe(400);
    expect((await t.app.request(authorizeUrl({ redirect_uri: "https://evil.test/cb" }))).status).toBe(400);
    expect((await t.app.request(authorizeUrl({ scope: "read:jira-work delete:everything" }))).status).toBe(400);
    expect((await t.app.request(authorizeUrl({ audience: "wrong" }))).status).toBe(400);
  });

  it("exchanges an authorization code for tokens once", async () => {
    const code = await authorize();
    const res = await exchange({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT,
    });
    expect(res.status).toBe(200);
    expect(res.json.token_type).toBe("Bearer");
    expect(res.json.expires_in).toBe(3600);
    expect(res.json.scope).toBe("read:jira-work write:jira-work read:jira-user offline_access");
    expect(res.json.access_token).toBeTruthy();
    expect(res.json.refresh_token).toBeTruthy();

    const reuse = await exchange({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT,
    });
    expect(reuse.status).toBe(403);
    expect(reuse.json.error).toBe("invalid_grant");
  });

  it("rejects a wrong client secret and omits refresh tokens without offline_access", async () => {
    const code = await authorize("read:jira-work");
    const bad = await exchange({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: "wrong",
      code,
      redirect_uri: REDIRECT,
    });
    expect(bad.status).toBe(401);

    const ok = await exchange({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: await authorize("read:jira-work"),
      redirect_uri: REDIRECT,
    });
    expect(ok.json.refresh_token).toBeUndefined();
  });

  it("accepts form encoded token requests", async () => {
    const code = await authorize();
    const res = await t.app.request(`${jiraTestBaseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: REDIRECT,
      }).toString(),
    });
    expect(res.status).toBe(200);
  });

  it("rotates refresh tokens", async () => {
    const tokens = (
      await exchange({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: await authorize(),
        redirect_uri: REDIRECT,
      })
    ).json;
    const refreshed = await exchange({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.json.access_token).not.toBe(tokens.access_token);
    expect(refreshed.json.refresh_token).not.toBe(tokens.refresh_token);

    const replay = await exchange({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
    });
    expect(replay.status).toBe(403);
  });

  it("lists accessible resources, serves /me, and routes the gateway by cloud id", async () => {
    const { access_token } = (
      await exchange({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: await authorize(),
        redirect_uri: REDIRECT,
      })
    ).json;
    const bearer = `Bearer ${access_token}`;

    const resources = await api(t.app, "/oauth/token/accessible-resources", { auth: bearer });
    expect(resources.status).toBe(200);
    expect(resources.json).toEqual([
      expect.objectContaining({
        id: DEFAULT_CLOUD_ID,
        url: jiraTestBaseUrl,
        scopes: expect.arrayContaining(["read:jira-work"]),
      }),
    ]);

    const me = await api(t.app, "/me", { auth: bearer });
    expect(me.json.email).toBe("admin@jira.local");
    expect(me.json.account_status).toBe("active");

    const myself = await api(t.app, `/ex/jira/${DEFAULT_CLOUD_ID}/rest/api/3/myself`, { auth: bearer });
    expect(myself.status).toBe(200);
    expect(myself.json.self).toBe(
      `${jiraTestBaseUrl}/ex/jira/${DEFAULT_CLOUD_ID}/rest/api/3/user?accountId=${myself.json.accountId}`,
    );

    const created = await api(t.app, `/ex/jira/${DEFAULT_CLOUD_ID}/rest/api/3/issue`, {
      method: "POST",
      auth: bearer,
      body: {
        fields: { project: { key: "EMU" }, issuetype: { name: "Task" }, summary: "Via gateway", description: adf("x") },
      },
    });
    expect(created.status).toBe(201);
    expect(created.json.self).toContain(`/ex/jira/${DEFAULT_CLOUD_ID}/rest/api/3/issue/`);

    const wrongSite = await api(t.app, "/ex/jira/not-a-site/rest/api/3/myself", { auth: bearer });
    expect(wrongSite.status).toBe(404);
  });

  it("rejects revoked, expired, and refresh tokens used as access tokens", async () => {
    const tokens = (
      await exchange({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: await authorize(),
        redirect_uri: REDIRECT,
      })
    ).json;
    expect((await api(t.app, "/rest/api/3/myself", { auth: `Bearer ${tokens.refresh_token}` })).status).toBe(401);

    const js = getJiraStore(t.store);
    const record = js.oauthTokens.findOneBy("token", tokens.access_token)!;
    js.oauthTokens.update(record.id, { expires_at: new Date(Date.now() - 1000).toISOString() });
    expect((await api(t.app, "/rest/api/3/myself", { auth: `Bearer ${tokens.access_token}` })).status).toBe(401);
  });

  it("enforces OAuth scopes when strict scopes are enabled", async () => {
    t.store.setData("jira.strict_scopes", true);
    const { access_token } = (
      await exchange({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: await authorize("read:jira-work"),
        redirect_uri: REDIRECT,
      })
    ).json;
    const bearer = `Bearer ${access_token}`;
    expect((await api(t.app, "/rest/api/3/issue/EMU-1", { auth: bearer })).status).toBe(200);
    const write = await api(t.app, "/rest/api/3/issue/EMU-1", {
      method: "PUT",
      auth: bearer,
      body: { fields: { summary: "nope" } },
    });
    expect(write.status).toBe(401);

    // API tokens carry the user's full permissions and are not scope limited.
    expect(
      (await api(t.app, "/rest/api/3/issue/EMU-1", { method: "PUT", body: { fields: { summary: "ok" } } })).status,
    ).toBe(204);
  });
});
