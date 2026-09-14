import { describe, it, expect, beforeEach } from "vitest";
import { Hono, type AppEnv } from "@emulators/core";
import { createTestApp, testAuthHeaders as authHeaders, testBaseUrl as base } from "./helpers.js";

describe("AWS plugin - STS AssumeRoleWithWebIdentity", () => {
  let app: Hono<AppEnv>;

  beforeEach(() => {
    app = createTestApp().app;
  });

  function assumeWithWebIdentity(target: Hono<AppEnv>, body: string, path = "/sts/") {
    return target.request(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  }

  it("returns credentials for a role that was never seeded", async () => {
    const roleArn = "arn:aws:iam::123456789012:role/test-app";
    const res = await assumeWithWebIdentity(
      app,
      `Action=AssumeRoleWithWebIdentity&RoleArn=${encodeURIComponent(roleArn)}` +
        "&RoleSessionName=test-session&WebIdentityToken=an-opaque-token",
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("AssumeRoleWithWebIdentityResponse");
    expect(text).toContain("<AccessKeyId>ASIA");
    expect(text).toContain("SecretAccessKey");
    expect(text).toContain("SessionToken");
    expect(text).toContain("<Expiration>");
    expect(text).toContain("arn:aws:sts::123456789012:assumed-role/test-app/test-session");
    expect(text).toContain("SubjectFromWebIdentityToken");
  });

  it("derives the subject from the sub claim when the token looks like a JWT", async () => {
    const claims = Buffer.from(JSON.stringify({ sub: "system:serviceaccount:test:app" })).toString("base64url");
    const token = `header.${claims}.signature`;
    const res = await assumeWithWebIdentity(
      app,
      "Action=AssumeRoleWithWebIdentity&RoleArn=arn%3Aaws%3Aiam%3A%3A123456789012%3Arole%2Ftest-app" +
        `&RoleSessionName=jwt-session&WebIdentityToken=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("<SubjectFromWebIdentityToken>system:serviceaccount:test:app</SubjectFromWebIdentityToken>");
  });

  it("derives a stable subject from a token that is not a JWT", async () => {
    const body =
      "Action=AssumeRoleWithWebIdentity&RoleArn=arn%3Aaws%3Aiam%3A%3A123456789012%3Arole%2Ftest-app" +
      "&RoleSessionName=opaque&WebIdentityToken=an-opaque-token";
    const first = await assumeWithWebIdentity(app, body);
    const second = await assumeWithWebIdentity(createTestApp().app, body);

    const subject = (text: string) => text.match(/<SubjectFromWebIdentityToken>(.*?)</)?.[1] ?? "";
    const firstSubject = subject(await first.text());
    expect(firstSubject).toMatch(/^emulate:[0-9a-f]{32}$/);
    expect(subject(await second.text())).toBe(firstSubject);
  });

  it("uses the seeded role id when the role does exist", async () => {
    await app.request(`${base}/iam/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: "Action=CreateRole&RoleName=web-identity-role",
    });
    const getRoleRes = await app.request(`${base}/iam/`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: "Action=GetRole&RoleName=web-identity-role",
    });
    const roleText = await getRoleRes.text();
    const roleArn = roleText.match(/<Arn>(.*?)<\/Arn>/)?.[1] ?? "";
    const roleId = roleText.match(/<RoleId>(.*?)<\/RoleId>/)?.[1] ?? "";

    const res = await assumeWithWebIdentity(
      app,
      `Action=AssumeRoleWithWebIdentity&RoleArn=${encodeURIComponent(roleArn)}` +
        "&RoleSessionName=seeded&WebIdentityToken=token",
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`${roleId}:seeded`);
  });

  it("rejects an empty web identity token", async () => {
    const res = await assumeWithWebIdentity(
      app,
      "Action=AssumeRoleWithWebIdentity&RoleArn=arn%3Aaws%3Aiam%3A%3A123456789012%3Arole%2Ftest-app" +
        "&RoleSessionName=test-session&WebIdentityToken=",
    );
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("ValidationError");
    expect(text).toContain("WebIdentityToken");
  });

  it("rejects a missing role arn", async () => {
    const res = await assumeWithWebIdentity(
      app,
      "Action=AssumeRoleWithWebIdentity&RoleSessionName=test-session&WebIdentityToken=token",
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("RoleArn");
  });

  it("serves the path without a trailing slash, as the AWS SDKs send it", async () => {
    const res = await assumeWithWebIdentity(
      app,
      "Action=AssumeRoleWithWebIdentity&RoleArn=arn%3Aaws%3Aiam%3A%3A123456789012%3Arole%2Ftest-app" +
        "&RoleSessionName=no-slash&WebIdentityToken=token",
      "/sts",
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("AssumeRoleWithWebIdentityResponse");
  });
  it("requires a valid session name and role ARN", async () => {
    const invalidRequests: Record<string, string>[] = [
      { RoleArn: "arn:aws:iam::123456789012:role/test" },
      { RoleArn: "arn:aws:iam::123456789012:role/test", RoleSessionName: "invalid session" },
      { RoleArn: "not-an-arn", RoleSessionName: "session" },
    ];
    for (const fields of invalidRequests) {
      const res = await assumeWithWebIdentity(
        app,
        new URLSearchParams({
          Action: "AssumeRoleWithWebIdentity",
          WebIdentityToken: "token",
          ...fields,
        }).toString(),
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("ValidationError");
    }
  });

  it("honors DurationSeconds and rejects values outside the supported range", async () => {
    const params = {
      Action: "AssumeRoleWithWebIdentity",
      RoleArn: "arn:aws:iam::123456789012:role/test",
      RoleSessionName: "session",
      WebIdentityToken: "token",
    };
    const before = Date.now();
    const res = await assumeWithWebIdentity(app, new URLSearchParams({ ...params, DurationSeconds: "900" }).toString());
    const expiration = (await res.text()).match(/<Expiration>(.*?)<\/Expiration>/)?.[1] ?? "";
    expect(Date.parse(expiration)).toBeGreaterThanOrEqual(before + 900_000);
    expect(Date.parse(expiration)).toBeLessThanOrEqual(Date.now() + 900_000);
    for (const duration of ["899", "43201", "nonsense", "900.5"]) {
      const invalid = await assumeWithWebIdentity(
        app,
        new URLSearchParams({ ...params, DurationSeconds: duration }).toString(),
      );
      expect(invalid.status).toBe(400);
      expect(await invalid.text()).toContain("DurationSeconds");
    }
  });

  it("escapes unverified JWT claims and returns audience and issuer", async () => {
    const claims = Buffer.from(
      JSON.stringify({ sub: "subject<&", aud: "client&app", iss: "https://issuer.example.test" }),
    ).toString("base64url");
    const res = await assumeWithWebIdentity(
      app,
      new URLSearchParams({
        Action: "AssumeRoleWithWebIdentity",
        RoleArn: "arn:aws:iam::123456789012:role/path/test",
        RoleSessionName: "session",
        WebIdentityToken: `header.${claims}.signature`,
      }).toString(),
    );
    const xml = await res.text();
    expect(xml).toContain("<SubjectFromWebIdentityToken>subject&lt;&amp;</SubjectFromWebIdentityToken>");
    expect(xml).toContain("<Audience>client&amp;app</Audience>");
    expect(xml).toContain("<Provider>https://issuer.example.test</Provider>");
    expect(xml).toContain("arn:aws:sts::123456789012:assumed-role/test/session");
  });
});
