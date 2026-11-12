import { X509Certificate } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { DOMParser, type Document, type Element } from "@xmldom/xmldom";
import { createServer } from "@emulators/core";
import { SignedXml } from "xml-crypto";
import { describe, expect, it } from "vitest";
import { getOktaStore, oktaPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";
const EXTERNAL_KEY = "exkSAMLTEST1234567";
const SSO_PATH = `/app/example_saml/${EXTERNAL_KEY}/sso/saml`;
const ACS = "https://sp.example.com/saml/acs";
const SP_ENTITY_ID = "https://sp.example.com/metadata";

const NS = {
  protocol: "urn:oasis:names:tc:SAML:2.0:protocol",
  assertion: "urn:oasis:names:tc:SAML:2.0:assertion",
  metadata: "urn:oasis:names:tc:SAML:2.0:metadata",
  dsig: "http://www.w3.org/2000/09/xmldsig#",
};

function setup(signOn: Record<string, unknown> = { ssoAcsUrl: ACS, audience: SP_ENTITY_ID }) {
  const server = createServer(oktaPlugin, {
    tokens: { "ssws-token": { login: "admin@okta.local", id: 1, scopes: ["okta.*"] } },
    fallbackUser: { login: "testuser@okta.local", id: 1, scopes: ["openid", "profile", "email", "groups"] },
  });
  oktaPlugin.seed?.(server.store, base);
  seedFromConfig(server.store, base, {
    users: [
      { okta_id: "00ualice", login: "alice@example.com", first_name: "Alice", last_name: "Example" },
      { okta_id: "00ubob", login: "bob@example.com", status: "SUSPENDED" },
      { okta_id: "00ucarol", login: "carol@example.com" },
    ],
    apps: [
      {
        okta_id: "0oasaml",
        name: "example_saml",
        label: "Example SP",
        sign_on_mode: "SAML_2_0",
        external_key: EXTERNAL_KEY,
        settings: { signOn },
      },
    ],
    app_assignments: [
      { app_okta_id: "0oasaml", user_okta_id: "00ualice" },
      { app_okta_id: "0oasaml", user_okta_id: "00ubob" },
    ],
  });
  return server;
}

type Server = ReturnType<typeof setup>;

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseForms(html: string): Array<{ action: string; fields: Record<string, string> }> {
  const forms = [...html.matchAll(/<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/gi)];
  return forms.map(([, action, inner]) => {
    const fields: Record<string, string> = {};
    for (const [, name, value] of inner.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"\/>/g)) {
      fields[decodeEntities(name)] = decodeEntities(value);
    }
    return { action: decodeEntities(action), fields };
  });
}

function authnRequest(id: string): string {
  return `<samlp:AuthnRequest xmlns:samlp="${NS.protocol}" xmlns:saml="${NS.assertion}" ID="${id}" Version="2.0" IssueInstant="${new Date().toISOString()}" AssertionConsumerServiceURL="${ACS}" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"><saml:Issuer>${SP_ENTITY_ID}</saml:Issuer></samlp:AuthnRequest>`;
}

async function openSso(
  server: Server,
  options: { binding?: "redirect" | "post"; requestId?: string; relayState?: string } = {},
): Promise<Response> {
  const params = new URLSearchParams();
  if (options.requestId) {
    const xml = Buffer.from(authnRequest(options.requestId));
    params.set("SAMLRequest", (options.binding === "post" ? xml : deflateRawSync(xml)).toString("base64"));
  }
  if (options.relayState) params.set("RelayState", options.relayState);

  if (options.binding === "post") {
    return server.app.request(`${base}${SSO_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
  }
  const query = params.toString();
  return server.app.request(`${base}${SSO_PATH}${query ? `?${query}` : ""}`);
}

async function signIn(
  server: Server,
  userOktaId: string,
  options: { binding?: "redirect" | "post"; requestId?: string; relayState?: string } = {},
): Promise<Response> {
  const picker = await openSso(server, options);
  expect(picker.status).toBe(200);
  const form = parseForms(await picker.text()).find((entry) => entry.fields.user_ref === userOktaId);
  expect(form).toBeDefined();
  return server.app.request(`${base}${form!.action}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form!.fields).toString(),
  });
}

async function postedSamlResponse(response: Response): Promise<{ action: string; fields: Record<string, string> }> {
  expect(response.status).toBe(200);
  const forms = parseForms(await response.text());
  expect(forms).toHaveLength(1);
  return forms[0];
}

async function metadataCertificate(server: Server): Promise<string> {
  const res = await server.app.request(`${base}/app/${EXTERNAL_KEY}/sso/saml/metadata`);
  const xml = await res.text();
  return xml.match(/<ds:X509Certificate>([^<]+)<\/ds:X509Certificate>/)![1];
}

function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, "text/xml");
}

function child(parent: Element | Document, ns: string, name: string): Element {
  const found = parent.getElementsByTagNameNS(ns, name)[0];
  expect(found, name).toBeDefined();
  return found;
}

function signatureOf(element: Element): Element | undefined {
  for (let node = element.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 1 && (node as Element).localName === "Signature" && node.namespaceURI === NS.dsig) {
      return node as Element;
    }
  }
  return undefined;
}

function verify(xml: string, signature: Element, certBase64: string): boolean {
  const sig = new SignedXml({ publicCert: `-----BEGIN CERTIFICATE-----\n${certBase64}\n-----END CERTIFICATE-----` });
  sig.loadSignature(signature.toString());
  return sig.checkSignature(xml);
}

describe("Okta SAML 2.0 identity provider", () => {
  it("publishes metadata with the signing certificate, both bindings and the NameID formats", async () => {
    const server = setup();
    const res = await server.app.request(`${base}/app/${EXTERNAL_KEY}/sso/saml/metadata`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    const xml = await res.text();
    const doc = parseXml(xml);

    expect(doc.documentElement!.getAttribute("entityID")).toBe(`http://www.okta.com/${EXTERNAL_KEY}`);
    const services = [...doc.getElementsByTagNameNS(NS.metadata, "SingleSignOnService")].map((node) => [
      node.getAttribute("Binding"),
      node.getAttribute("Location"),
    ]);
    expect(services).toEqual([
      ["urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST", `${base}${SSO_PATH}`],
      ["urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect", `${base}${SSO_PATH}`],
    ]);
    const formats = [...doc.getElementsByTagNameNS(NS.metadata, "NameIDFormat")].map((node) => node.textContent);
    expect(formats).toEqual([
      "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
      "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
    ]);
    expect(child(doc, NS.metadata, "KeyDescriptor").getAttribute("use")).toBe("signing");
    const cert = new X509Certificate(Buffer.from(await metadataCertificate(server), "base64"));
    expect(cert.publicKey.asymmetricKeyType).toBe("rsa");

    const unknown = await server.app.request(`${base}/app/exkUNKNOWN/sso/saml/metadata`);
    expect(unknown.status).toBe(404);
  });

  it("serves the same metadata on the management API, which requires authentication", async () => {
    const server = setup();
    const unauthenticated = await server.app.request(`${base}/api/v1/apps/0oasaml/sso/saml/metadata`);
    expect(unauthenticated.status).toBe(401);

    const res = await server.app.request(`${base}/api/v1/apps/0oasaml/sso/saml/metadata`, {
      headers: { Authorization: "SSWS ssws-token" },
    });
    expect(res.status).toBe(200);
    const publicMetadata = await server.app.request(`${base}/app/${EXTERNAL_KEY}/sso/saml/metadata`);
    expect(await res.text()).toBe(await publicMetadata.text());

    const appRes = await server.app.request(`${base}/api/v1/apps/0oasaml`, {
      headers: { Authorization: "SSWS ssws-token" },
    });
    const app = (await appRes.json()) as { signOnMode: string; _links: { metadata: { href: string } } };
    expect(app.signOnMode).toBe("SAML_2_0");
    expect(app._links.metadata.href).toBe(`${base}/api/v1/apps/0oasaml/sso/saml/metadata`);
  });

  it("refuses a SAML app that signs neither the response nor the assertion", async () => {
    const server = setup();
    const unsigned = { ssoAcsUrl: ACS, audience: SP_ENTITY_ID, responseSigned: false, assertionSigned: false };
    const created = await server.app.request(`${base}/api/v1/apps`, {
      method: "POST",
      headers: { Authorization: "SSWS ssws-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "unsigned",
        label: "Unsigned",
        signOnMode: "SAML_2_0",
        settings: { signOn: unsigned },
      }),
    });
    expect(created.status).toBe(400);
    expect(((await created.json()) as { errorCode: string }).errorCode).toBe("E0000001");

    const updated = await server.app.request(`${base}/api/v1/apps/0oasaml`, {
      method: "PUT",
      headers: { Authorization: "SSWS ssws-token", "Content-Type": "application/json" },
      body: JSON.stringify({ signOnMode: "SAML_2_0", settings: { signOn: unsigned } }),
    });
    expect(updated.status).toBe(400);
  });

  it("gives an app created through the Apps API an external key and metadata", async () => {
    const server = setup();
    const created = await server.app.request(`${base}/api/v1/apps`, {
      method: "POST",
      headers: { Authorization: "SSWS ssws-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "api_saml",
        label: "API SAML",
        signOnMode: "SAML_2_0",
        settings: { signOn: { ssoAcsUrl: ACS, audience: SP_ENTITY_ID } },
      }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const externalKey = getOktaStore(server.store).apps.findOneBy("okta_id", id)!.external_key!;
    expect(externalKey).toMatch(/^exk/);

    const res = await server.app.request(`${base}/api/v1/apps/${id}/sso/saml/metadata`, {
      headers: { Authorization: "SSWS ssws-token" },
    });
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain(`entityID="http://www.okta.com/${externalKey}"`);
    expect(xml).toContain(`Location="${base}/app/api_saml/${externalKey}/sso/saml"`);
  });

  it("answers an HTTP-Redirect AuthnRequest with a signed assertion posted to the ACS URL", async () => {
    const server = setup({
      ssoAcsUrl: ACS,
      recipient: "https://sp.example.com/saml/recipient",
      destination: "https://sp.example.com/saml/destination",
      audience: SP_ENTITY_ID,
      subjectNameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
    });
    const before = Date.now();
    const posted = await postedSamlResponse(
      await signIn(server, "00ualice", {
        requestId: "_req-redirect",
        relayState: "https://sp.example.com/home?a=1&b=2",
      }),
    );
    const after = Date.now();

    expect(posted.action).toBe(ACS);
    expect(posted.fields.RelayState).toBe("https://sp.example.com/home?a=1&b=2");
    const xml = Buffer.from(posted.fields.SAMLResponse, "base64").toString("utf-8");
    const doc = parseXml(xml);
    const response = doc.documentElement!;
    const assertion = child(doc, NS.assertion, "Assertion");

    expect(response.localName).toBe("Response");
    expect(response.getAttribute("Destination")).toBe("https://sp.example.com/saml/destination");
    expect(response.getAttribute("InResponseTo")).toBe("_req-redirect");
    expect(child(doc, NS.protocol, "StatusCode").getAttribute("Value")).toBe(
      "urn:oasis:names:tc:SAML:2.0:status:Success",
    );
    for (const issuer of [...doc.getElementsByTagNameNS(NS.assertion, "Issuer")]) {
      expect(issuer.textContent).toBe(`http://www.okta.com/${EXTERNAL_KEY}`);
    }

    const nameId = child(assertion, NS.assertion, "NameID");
    expect(nameId.textContent).toBe("alice@example.com");
    expect(nameId.getAttribute("Format")).toBe("urn:oasis:names:tc:SAML:2.0:nameid-format:persistent");
    const confirmation = child(assertion, NS.assertion, "SubjectConfirmationData");
    expect(confirmation.getAttribute("Recipient")).toBe("https://sp.example.com/saml/recipient");
    expect(confirmation.getAttribute("InResponseTo")).toBe("_req-redirect");
    expect(child(assertion, NS.assertion, "Audience").textContent).toBe(SP_ENTITY_ID);

    const conditions = child(assertion, NS.assertion, "Conditions");
    const notBefore = Date.parse(conditions.getAttribute("NotBefore")!);
    const notOnOrAfter = Date.parse(conditions.getAttribute("NotOnOrAfter")!);
    expect(notBefore).toBeGreaterThanOrEqual(before - 5 * 60 * 1000 - 1000);
    expect(notBefore).toBeLessThanOrEqual(after - 5 * 60 * 1000);
    expect(notOnOrAfter).toBeGreaterThanOrEqual(before + 5 * 60 * 1000 - 1000);
    expect(notOnOrAfter).toBeLessThanOrEqual(after + 5 * 60 * 1000);
    const authnStatement = child(assertion, NS.assertion, "AuthnStatement");
    expect(authnStatement.hasAttribute("SessionNotOnOrAfter")).toBe(false);
    expect(child(assertion, NS.assertion, "AuthnContextClassRef").textContent).toBe(
      "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport",
    );

    const cert = await metadataCertificate(server);
    expect(signatureOf(response)).toBeUndefined();
    const assertionSignature = signatureOf(assertion);
    expect(assertionSignature).toBeDefined();
    expect(verify(xml, assertionSignature!, cert)).toBe(true);
    expect(child(assertionSignature!, NS.dsig, "Reference").getAttribute("URI")).toBe(
      `#${assertion.getAttribute("ID")}`,
    );
    expect(child(assertionSignature!, NS.dsig, "SignatureMethod").getAttribute("Algorithm")).toBe(
      "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    );
    expect(child(assertionSignature!, NS.dsig, "DigestMethod").getAttribute("Algorithm")).toBe(
      "http://www.w3.org/2001/04/xmlenc#sha256",
    );

    const tampered = xml.replace("alice@example.com", "mallory@example.com");
    const tamperedAssertion = child(parseXml(tampered), NS.assertion, "Assertion");
    expect(verify(tampered, signatureOf(tamperedAssertion)!, cert)).toBe(false);
  });

  it("answers an HTTP-POST AuthnRequest and uses the ACS URL as Destination and Recipient by default", async () => {
    const server = setup();
    const posted = await postedSamlResponse(
      await signIn(server, "00ualice", { binding: "post", requestId: "_req-post", relayState: "state-post" }),
    );
    expect(posted.action).toBe(ACS);
    expect(posted.fields.RelayState).toBe("state-post");

    const xml = Buffer.from(posted.fields.SAMLResponse, "base64").toString("utf-8");
    const doc = parseXml(xml);
    expect(doc.documentElement!.getAttribute("Destination")).toBe(ACS);
    expect(doc.documentElement!.getAttribute("InResponseTo")).toBe("_req-post");
    expect(child(doc, NS.assertion, "SubjectConfirmationData").getAttribute("Recipient")).toBe(ACS);
    expect(child(doc, NS.assertion, "NameID").getAttribute("Format")).toBe(
      "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
    );
    const assertion = child(doc, NS.assertion, "Assertion");
    expect(verify(xml, signatureOf(assertion)!, await metadataCertificate(server))).toBe(true);
  });

  it("issues an assertion without InResponseTo for an IdP-initiated sign-in", async () => {
    const server = setup();
    const posted = await postedSamlResponse(await signIn(server, "00ualice"));
    expect(posted.action).toBe(ACS);
    expect(posted.fields.RelayState).toBeUndefined();

    const xml = Buffer.from(posted.fields.SAMLResponse, "base64").toString("utf-8");
    const doc = parseXml(xml);
    expect(doc.documentElement!.hasAttribute("InResponseTo")).toBe(false);
    expect(child(doc, NS.assertion, "SubjectConfirmationData").hasAttribute("InResponseTo")).toBe(false);
    expect(verify(xml, signatureOf(child(doc, NS.assertion, "Assertion"))!, await metadataCertificate(server))).toBe(
      true,
    );
  });

  it("signs only the response, with the configured algorithms, when assertionSigned is false", async () => {
    const server = setup({
      ssoAcsUrl: ACS,
      audience: SP_ENTITY_ID,
      responseSigned: true,
      assertionSigned: false,
      signatureAlgorithm: "RSA_SHA1",
      digestAlgorithm: "SHA1",
    });
    const posted = await postedSamlResponse(await signIn(server, "00ualice", { requestId: "_req-rs" }));
    const xml = Buffer.from(posted.fields.SAMLResponse, "base64").toString("utf-8");
    const doc = parseXml(xml);

    expect(signatureOf(child(doc, NS.assertion, "Assertion"))).toBeUndefined();
    const responseSignature = signatureOf(doc.documentElement!);
    expect(responseSignature).toBeDefined();
    expect(verify(xml, responseSignature!, await metadataCertificate(server))).toBe(true);
    expect(child(responseSignature!, NS.dsig, "Reference").getAttribute("URI")).toBe(
      `#${doc.documentElement!.getAttribute("ID")}`,
    );
    expect(child(responseSignature!, NS.dsig, "SignatureMethod").getAttribute("Algorithm")).toBe(
      "http://www.w3.org/2000/09/xmldsig#rsa-sha1",
    );
    expect(child(responseSignature!, NS.dsig, "DigestMethod").getAttribute("Algorithm")).toBe(
      "http://www.w3.org/2000/09/xmldsig#sha1",
    );
  });

  it("signs both the assertion and the response when both are enabled", async () => {
    const server = setup({ ssoAcsUrl: ACS, audience: SP_ENTITY_ID, responseSigned: true, assertionSigned: true });
    const posted = await postedSamlResponse(await signIn(server, "00ualice", { requestId: "_req-both" }));
    const xml = Buffer.from(posted.fields.SAMLResponse, "base64").toString("utf-8");
    const doc = parseXml(xml);
    const cert = await metadataCertificate(server);

    const assertionSignature = signatureOf(child(doc, NS.assertion, "Assertion"));
    const responseSignature = signatureOf(doc.documentElement!);
    expect(assertionSignature).toBeDefined();
    expect(responseSignature).toBeDefined();
    expect(verify(xml, assertionSignature!, cert)).toBe(true);
    expect(verify(xml, responseSignature!, cert)).toBe(true);
  });

  it("shows the App Not Assigned page with status 403 to an unassigned user", async () => {
    const server = setup();
    const res = await signIn(server, "00ucarol", { requestId: "_req-unassigned" });
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain("<title>App Not Assigned");
    expect(html).toContain("Sorry, you cannot access Example SP because you are not assigned this app in Okta.");
    expect(html).not.toContain("SAMLResponse");
  });

  it("refuses a suspended user without a SAML response", async () => {
    const server = setup();
    const res = await signIn(server, "00ubob", { requestId: "_req-suspended" });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("SUSPENDED");
    expect(html).not.toContain("SAMLResponse");
  });

  it("refuses sign-in through a deactivated SAML app", async () => {
    const server = setup();
    const picker = await openSso(server, { requestId: "_req-inactive" });
    const form = parseForms(await picker.text()).find((entry) => entry.fields.user_ref === "00ualice");
    expect(form).toBeDefined();

    const deactivated = await server.app.request(`${base}/api/v1/apps/0oasaml/lifecycle/deactivate`, {
      method: "POST",
      headers: { Authorization: "SSWS ssws-token" },
    });
    expect(deactivated.status).toBe(200);

    expect((await openSso(server, { requestId: "_req-inactive-2" })).status).toBe(404);
    const callback = await server.app.request(`${base}${form!.action}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form!.fields).toString(),
    });
    expect(callback.status).toBe(404);
    expect(await callback.text()).not.toContain("SAMLResponse");
  });

  it("rejects an undecodable SAMLRequest and an unknown external key", async () => {
    const server = setup();
    const invalid = await server.app.request(`${base}${SSO_PATH}?SAMLRequest=not-a-request`);
    expect(invalid.status).toBe(400);
    const unknown = await server.app.request(`${base}/app/example_saml/exkUNKNOWN/sso/saml`);
    expect(unknown.status).toBe(404);
  });
});
