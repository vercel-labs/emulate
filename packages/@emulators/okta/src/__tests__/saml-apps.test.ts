import { describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher, authMiddleware } from "@emulators/core";
import {
  buildAuthnRequest,
  createSelfSignedCertificate,
  encodeRedirectBinding,
  verifySamlResponse,
} from "@emulators/core/saml";
import type { TokenMap } from "@emulators/core";
import { oktaPlugin, seedFromConfig, type OktaSeedConfig } from "../index.js";

const base = "http://localhost:4000";
const acs = "http://localhost:3000/saml/acs";
const audience = "https://sp.example.test";
const admin = { Authorization: "SSWS ssws-token" };
const ssoUrl = `${base}/app/portal_saml/exkportal/sso/saml`;

function createTestApp(extra: Partial<OktaSeedConfig> = {}, signOn: Record<string, unknown> = {}) {
  const tokenMap: TokenMap = new Map([["ssws-token", { login: "admin@okta.local", id: 1, scopes: ["okta.*"] }]]);
  const app = new Hono();
  app.use("*", authMiddleware(tokenMap));
  const store = new Store();
  oktaPlugin.register(app as any, store, new WebhookDispatcher(), base, tokenMap);
  oktaPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [
      { okta_id: "00u_alice", login: "alice@example.com", first_name: "Alice", last_name: "Liddell" },
      { okta_id: "00u_bob", login: "bob@example.com" },
      { okta_id: "00u_carol", login: "carol@example.com", status: "SUSPENDED" },
    ],
    groups: [
      { okta_id: "00g_eng", name: "eng-platform" },
      { okta_id: "00g_ops", name: "ops" },
    ],
    group_memberships: [
      { group_okta_id: "00g_eng", user_okta_id: "00u_alice" },
      { group_okta_id: "00g_ops", user_okta_id: "00u_alice" },
    ],
    apps: [
      {
        okta_id: "0oa_saml",
        name: "portal_saml",
        label: "Portal",
        sign_on_mode: "SAML_2_0",
        external_key: "exkportal",
        settings: {
          signOn: {
            ssoAcsUrl: acs,
            audience,
            subjectNameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
            defaultRelayState: "/home",
            attributeStatements: [
              { type: "EXPRESSION", name: "firstName", values: ["user.firstName"] },
              { type: "EXPRESSION", name: "plan", values: ["enterprise"] },
              { type: "GROUP", name: "groups", filterType: "STARTS_WITH", filterValue: "eng-" },
            ],
            ...signOn,
          },
        },
      },
      { okta_id: "0oa_oidc", name: "oidc_portal", sign_on_mode: "OPENID_CONNECT" },
    ],
    app_assignments: [
      { app_okta_id: "0oa_saml", user_okta_id: "00u_alice" },
      { app_okta_id: "0oa_saml", user_okta_id: "00u_carol" },
    ],
    ...extra,
  });
  return app;
}

async function certificateOf(app: Hono<any>): Promise<string> {
  const xml = await (await app.request(`${base}/app/exkportal/sso/saml/metadata`)).text();
  return /<ds:X509Certificate>([^<]+)<\/ds:X509Certificate>/.exec(xml)![1]!;
}

function formField(html: string, name: string): string | undefined {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  return match?.[1]
    ?.replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

async function choose(app: Hono<any>, userRef: string, inResponseTo = "", relayState = "", path = ssoUrl) {
  return app.request(`${path}/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ user_ref: userRef, in_response_to: inResponseTo, relay_state: relayState }),
  });
}

async function verify(app: Hono<any>, html: string, requestId: string | null) {
  return verifySamlResponse(formField(html, "SAMLResponse") ?? "", {
    certificates: [await certificateOf(app)],
    acsUrl: acs,
    audience,
    issuer: "http://www.okta.com/exkportal",
    requestId,
    allowUnsolicited: true,
  });
}

describe("Okta SAML 2.0 apps", () => {
  it("serves IdP metadata at the app URL and on the Apps API", async () => {
    const app = createTestApp();
    const res = await app.request(`${base}/app/exkportal/sso/saml/metadata`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    const xml = await res.text();
    expect(xml).toContain('entityID="http://www.okta.com/exkportal"');
    expect(xml).toContain(`Location="${ssoUrl}"`);

    const api = await app.request(`${base}/api/v1/apps/0oa_saml/sso/saml/metadata`, { headers: admin });
    expect(api.status).toBe(200);
    expect(await api.text()).toBe(xml);

    expect((await app.request(`${base}/api/v1/apps/0oa_saml/sso/saml/metadata`)).status).toBe(401);
    const oidc = await app.request(`${base}/api/v1/apps/0oa_oidc/sso/saml/metadata`, { headers: admin });
    expect(oidc.status).toBe(404);
    expect(((await oidc.json()) as any).errorCode).toBe("E0000007");
  });

  it("links the metadata from the app object", async () => {
    const res = await createTestApp().request(`${base}/api/v1/apps/0oa_saml`, { headers: admin });
    const body = (await res.json()) as any;
    expect(body._links.metadata).toEqual({
      href: `${base}/api/v1/apps/0oa_saml/sso/saml/metadata`,
      type: "application/xml",
    });
  });

  it("answers an SP-initiated HTTP-Redirect AuthnRequest with a signed assertion", async () => {
    const app = createTestApp();
    const request = buildAuthnRequest({ issuer: audience, destination: ssoUrl, acsUrl: acs });
    const page = await app.request(
      `${ssoUrl}?SAMLRequest=${encodeURIComponent(encodeRedirectBinding(request.xml))}&RelayState=%2Fdocs`,
    );
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(formField(html, "in_response_to")).toBe(request.id);
    expect(formField(html, "relay_state")).toBe("/docs");

    const res = await choose(app, "00u_alice", request.id, "/docs");
    expect(res.status).toBe(200);
    const post = await res.text();
    expect(post).toContain(`action="${acs}"`);
    expect(formField(post, "RelayState")).toBe("/docs");

    const result = await verify(app, post, request.id);
    expect(result).toEqual({
      ok: true,
      assertion: expect.objectContaining({
        nameId: "alice@example.com",
        nameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
        inResponseTo: request.id,
        attributes: { firstName: ["Alice"], plan: ["enterprise"], groups: ["eng-platform"] },
      }),
    });
  });

  it("accepts the HTTP-POST binding", async () => {
    const app = createTestApp();
    const request = buildAuthnRequest({ issuer: audience, destination: ssoUrl, acsUrl: acs });
    const page = await app.request(ssoUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ SAMLRequest: Buffer.from(request.xml).toString("base64") }),
    });
    expect(formField(await page.text(), "in_response_to")).toBe(request.id);
  });

  it("rejects a SAMLRequest it cannot decode", async () => {
    expect((await createTestApp().request(`${ssoUrl}?SAMLRequest=bm9wZQ`)).status).toBe(400);
  });

  it("starts IdP-initiated sign-in at the default relay state", async () => {
    const app = createTestApp();
    const html = await (await app.request(ssoUrl)).text();
    expect(formField(html, "in_response_to")).toBe("");
    expect(formField(html, "relay_state")).toBe("/home");

    const post = await (await choose(app, "00u_alice", "", "/home")).text();
    expect(formField(post, "RelayState")).toBe("/home");
    expect(await verify(app, post, null)).toMatchObject({ ok: true, assertion: { inResponseTo: "" } });
  });

  it("signs the response, the assertion or both as settings.signOn says", async () => {
    for (const signOn of [
      { responseSigned: true, assertionSigned: false },
      { responseSigned: true, assertionSigned: true },
      { responseSigned: false, assertionSigned: true, signatureAlgorithm: "RSA_SHA1", digestAlgorithm: "SHA1" },
    ]) {
      const app = createTestApp({}, signOn);
      const xml = Buffer.from(
        formField(await (await choose(app, "00u_alice")).text(), "SAMLResponse")!,
        "base64",
      ).toString();
      const responseSignature = /<saml2p:Response[^>]*><saml2:Issuer[^>]*>[^<]*<\/saml2:Issuer><ds:Signature/.test(xml);
      const assertionSignature = /<saml2:Assertion[^>]*><saml2:Issuer[^>]*>[^<]*<\/saml2:Issuer><ds:Signature/.test(
        xml,
      );
      expect([responseSignature, assertionSignature]).toEqual([signOn.responseSigned, signOn.assertionSigned]);
      if (signOn.signatureAlgorithm === "RSA_SHA1") expect(xml).toContain("xmldsig#rsa-sha1");
      expect((await verify(app, await (await choose(app, "00u_alice")).text(), null)).ok).toBe(true);
    }
  });

  it("shows the App Not Assigned page to a user who is not assigned to the app", async () => {
    const res = await choose(createTestApp(), "00u_bob");
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("App Not Assigned");
  });

  it("refuses a user who is not ACTIVE", async () => {
    const res = await choose(createTestApp(), "00u_carol");
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("SAMLResponse");
  });

  it("refuses sign-in through a deactivated app or an SSO URL with another app name", async () => {
    const app = createTestApp();
    expect((await app.request(`${base}/app/other_name/exkportal/sso/saml`)).status).toBe(404);
    await app.request(`${base}/api/v1/apps/0oa_saml/lifecycle/deactivate`, { method: "POST", headers: admin });
    expect((await app.request(ssoUrl)).status).toBe(404);
    expect((await choose(app, "00u_alice")).status).toBe(404);
  });

  it("refuses an app that signs neither the response nor the assertion with E0000001", async () => {
    const app = createTestApp();
    const settings = { signOn: { ssoAcsUrl: acs, responseSigned: false, assertionSigned: false } };
    const created = await app.request(`${base}/api/v1/apps`, {
      method: "POST",
      headers: { ...admin, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "unsigned", label: "Unsigned", signOnMode: "SAML_2_0", settings }),
    });
    expect(created.status).toBe(400);
    expect(((await created.json()) as any).errorCode).toBe("E0000001");

    const updated = await app.request(`${base}/api/v1/apps/0oa_saml`, {
      method: "PUT",
      headers: { ...admin, "Content-Type": "application/json" },
      body: JSON.stringify({ settings }),
    });
    expect(updated.status).toBe(400);
    expect(() =>
      seedFromConfig(new Store(), base, { apps: [{ name: "bad", sign_on_mode: "SAML_2_0", settings }] }),
    ).toThrow(/responseSigned or assertionSigned/);
  });

  it("gives an app created through the API an external key and working SSO URL", async () => {
    const app = createTestApp();
    const created = await app.request(`${base}/api/v1/apps`, {
      method: "POST",
      headers: { ...admin, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "wiki",
        label: "Wiki",
        signOnMode: "SAML_2_0",
        settings: { signOn: { ssoAcsUrl: acs } },
      }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as any;
    const metadata = await (await app.request(body._links.metadata.href, { headers: admin })).text();
    const location = /Location="([^"]+)"/.exec(metadata)![1]!;
    expect(location).toMatch(new RegExp(`^${base}/app/wiki/exk[A-Za-z0-9]+/sso/saml$`));
    expect((await app.request(location)).status).toBe(200);
  });

  it("signs with a pinned key from seed config", async () => {
    const pinned = createSelfSignedCertificate("pinned");
    const app = createTestApp({
      saml_signing_key: { private_key: pinned.privateKeyPem, certificate: pinned.certificate },
    });
    expect(await certificateOf(app)).toBe(pinned.certificate);
    expect(() =>
      seedFromConfig(new Store(), base, {
        saml_signing_key: {
          private_key: createSelfSignedCertificate("other").privateKeyPem,
          certificate: pinned.certificate,
        },
      }),
    ).toThrow(/does not match/);
  });
});
