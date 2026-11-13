import { X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildAuthnRequest,
  buildIdpMetadata,
  buildSamlResponse,
  encodeRedirectBinding,
  parseAuthnRequest,
  signSamlResponse,
  verifySamlResponse,
  type SamlResponseInput,
  type VerifySamlResponseOptions,
} from "../saml.js";
import { certificateMatchesKey, certificateToPem, createSelfSignedCertificate } from "../x509.js";

const idp = createSelfSignedCertificate("emulate-test-idp");
const other = createSelfSignedCertificate("someone-else");

const ACS = "http://localhost:4000/sso/saml";
const AUDIENCE = "https://sp.example.test";
const ISSUER = "http://www.okta.com/exk123";

function issue(
  overrides: Partial<SamlResponseInput> = {},
  signing: { signAssertion?: boolean; signResponse?: boolean } = { signAssertion: true },
) {
  const built = buildSamlResponse({
    issuer: ISSUER,
    destination: ACS,
    audience: AUDIENCE,
    nameId: "ada@example.test",
    nameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    inResponseTo: "_req1",
    attributes: [{ name: "email", values: ["ada@example.test"] }],
    ...overrides,
  });
  return signSamlResponse(built.xml, {
    privateKeyPem: idp.privateKeyPem,
    certificate: idp.certificate,
    signAssertion: signing.signAssertion ?? false,
    signResponse: signing.signResponse ?? false,
  });
}

const b64 = (xml: string) => Buffer.from(xml, "utf-8").toString("base64");

function verify(xml: string, overrides: Partial<VerifySamlResponseOptions> = {}) {
  return verifySamlResponse(b64(xml), {
    certificates: [idp.certificate],
    acsUrl: ACS,
    audience: AUDIENCE,
    issuer: ISSUER,
    requestId: "_req1",
    ...overrides,
  });
}

describe("createSelfSignedCertificate", () => {
  it("creates a certificate Node can parse, signed by its own key", () => {
    const cert = new X509Certificate(certificateToPem(idp.certificate));
    expect(cert.subject).toBe("CN=emulate-test-idp");
    expect(cert.issuer).toBe("CN=emulate-test-idp");
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(new Date(cert.validTo).getTime()).toBeGreaterThan(Date.now() + 365 * 24 * 3600 * 1000);
    expect(certificateMatchesKey(idp.certificate, idp.privateKeyPem)).toBe(true);
    expect(certificateMatchesKey(idp.certificate, other.privateKeyPem)).toBe(false);
  });
});

describe("buildIdpMetadata", () => {
  it("lists the signing certificate and both SSO bindings", () => {
    const xml = buildIdpMetadata({ entityId: ISSUER, ssoUrl: "http://idp.test/sso", certificate: idp.certificate });
    expect(xml).toContain(`entityID="${ISSUER}"`);
    expect(xml).toContain(`<ds:X509Certificate>${idp.certificate}</ds:X509Certificate>`);
    expect(xml).toContain('Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="http://idp.test/sso"');
    expect(xml).toContain(
      'Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="http://idp.test/sso"',
    );
  });
});

describe("AuthnRequest", () => {
  it("round-trips through the HTTP-Redirect and HTTP-POST bindings", () => {
    const { id, xml } = buildAuthnRequest({ issuer: AUDIENCE, destination: "http://idp.test/sso", acsUrl: ACS });
    expect(id).toMatch(/^_/);
    for (const [encoded, binding] of [
      [encodeRedirectBinding(xml), "redirect"],
      [b64(xml), "post"],
    ] as const) {
      expect(parseAuthnRequest(encoded, binding)).toEqual({
        id,
        issuer: AUDIENCE,
        acsUrl: ACS,
        destination: "http://idp.test/sso",
        forceAuthn: false,
      });
    }
  });

  it("returns null for something that is not an AuthnRequest", () => {
    expect(parseAuthnRequest(b64("<foo/>"), "post")).toBeNull();
    expect(parseAuthnRequest("not base64 deflate", "redirect")).toBeNull();
  });
});

describe("verifySamlResponse", () => {
  it("accepts a signed assertion and returns the subject and attributes", () => {
    const result = verify(issue());
    expect(result).toEqual({
      ok: true,
      assertion: expect.objectContaining({
        issuer: ISSUER,
        nameId: "ada@example.test",
        nameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
        inResponseTo: "_req1",
        attributes: { email: ["ada@example.test"] },
      }),
    });
  });

  it("accepts a signed response, with or without a signed assertion", () => {
    expect(verify(issue({}, { signResponse: true })).ok).toBe(true);
    expect(verify(issue({}, { signResponse: true, signAssertion: true })).ok).toBe(true);
  });

  it("refuses an unsigned response", () => {
    expect(verify(issue({}, {}))).toEqual({
      ok: false,
      error: "Neither the SAML response nor its assertion is signed.",
    });
  });

  it("refuses a signature from an untrusted key", () => {
    expect(verify(issue(), { certificates: [other.certificate] })).toMatchObject({ ok: false });
  });

  it("refuses an assertion edited after signing", () => {
    const tampered = issue().replace(">ada@example.test</saml2:NameID>", ">admin@example.test</saml2:NameID>");
    expect(verify(tampered)).toEqual({ ok: false, error: "The SAML assertion signature is invalid." });
  });

  it("refuses an unsigned assertion added next to the signed one", () => {
    const signed = issue();
    const extra = signed.slice(signed.indexOf("<saml2:Assertion"), signed.indexOf("</saml2:Assertion>") + 18);
    const unsigned = extra.replace(/<ds:Signature[\s\S]*<\/ds:Signature>/, "").replace(/ID="[^"]+"/, 'ID="evil"');
    const wrapped = signed.replace("</saml2p:Response>", `${unsigned}</saml2p:Response>`);
    expect(verify(wrapped)).toEqual({ ok: false, error: "The SAML response must contain exactly one assertion." });
  });

  it("refuses a response for another audience, recipient or destination", () => {
    expect(verify(issue({ audience: "https://other.test" }))).toMatchObject({
      error: "The SAML assertion is not intended for this service provider.",
    });
    expect(verify(issue({ recipient: "http://other.test/acs" }))).toMatchObject({
      error: "The SAML assertion was issued for another recipient.",
    });
    expect(verify(issue({ destination: "http://other.test/acs", recipient: ACS }))).toMatchObject({
      error: "The SAML response was sent to another destination.",
    });
  });

  it("refuses an unexpected issuer", () => {
    expect(verify(issue({ issuer: "http://www.okta.com/other" }))).toMatchObject({
      error: "The SAML assertion comes from an unexpected issuer.",
    });
  });

  it("refuses an expired or not yet valid assertion", () => {
    const xml = issue({ lifetimeSeconds: 60 });
    expect(verify(xml, { now: Date.now() + 5 * 60 * 1000 })).toMatchObject({
      error: "The SAML assertion has expired.",
    });
    expect(verify(xml, { now: Date.now() - 5 * 60 * 1000 })).toMatchObject({
      error: "The SAML assertion is not yet valid.",
    });
  });

  it("binds the response to the AuthnRequest it answers", () => {
    expect(verify(issue(), { requestId: "_req2" })).toMatchObject({
      error: "The SAML response answers a different sign-in request.",
    });
    expect(verify(issue(), { requestId: null, allowUnsolicited: true })).toMatchObject({
      error: "The SAML response answers a sign-in request this browser did not start.",
    });
  });

  it("refuses IdP-initiated sign-in unless allowed", () => {
    const unsolicited = issue({ inResponseTo: null });
    expect(verify(unsolicited, { requestId: null })).toMatchObject({ error: "IdP-initiated sign-in is not allowed." });
    expect(verify(unsolicited, { requestId: null, allowUnsolicited: true }).ok).toBe(true);
  });

  it("refuses a document with a DTD", () => {
    const xml = `<!DOCTYPE x [<!ENTITY e "x">]>${issue()}`;
    expect(verify(xml)).toEqual({ ok: false, error: "The SAMLResponse is not a SAML 2.0 Response." });
  });
});
