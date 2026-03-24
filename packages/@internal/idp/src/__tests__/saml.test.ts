import { describe, it, expect } from "vitest";
import { SignedXml } from "xml-crypto";
import { deflateRawSync } from "zlib";
import { Hono } from "hono";
import { Store, WebhookDispatcher, authMiddleware } from "@internal/core";
import type { TokenMap } from "@internal/core";
import { idpPlugin, seedFromConfig, type IdpSeedConfig } from "../index.js";
import { generateSigningKeySync } from "../crypto.js";

// These will be implemented in crypto.ts and saml-xml.ts
import { generateSelfSignedCert, getPublicCertBase64 } from "../crypto.js";
import {
  buildMetadataXml,
  buildSamlResponse,
  signAssertion,
  buildAutoPostForm,
} from "../saml-xml.js";
import { ENTRA_ID_ATTRIBUTE_MAPPINGS, SAML_NAMEID_FORMATS } from "../saml-constants.js";

describe("SAML Certificate Generation", () => {
  it("generates a self-signed X.509 certificate from private key", async () => {
    const key = generateSigningKeySync("cert-test");
    const cert = await generateSelfSignedCert(key.private_key_pem);
    expect(cert).toContain("-----BEGIN CERTIFICATE-----");
    expect(cert).toContain("-----END CERTIFICATE-----");
  });

  it("getPublicCertBase64 strips PEM headers", async () => {
    const key = generateSigningKeySync();
    const cert = await generateSelfSignedCert(key.private_key_pem);
    const b64 = getPublicCertBase64(cert);
    expect(b64).not.toContain("-----BEGIN");
    expect(b64).not.toContain("-----END");
    expect(b64.length).toBeGreaterThan(100);
    // Should be valid base64
    expect(() => Buffer.from(b64, "base64")).not.toThrow();
  });
});

describe("SAML Metadata XML", () => {
  it("builds valid IdP metadata", () => {
    const xml = buildMetadataXml(
      "http://localhost:4003/saml/metadata",
      "http://localhost:4003/saml/sso",
      "MIIC...base64cert..."
    );
    expect(xml).toContain("EntityDescriptor");
    expect(xml).toContain('entityID="http://localhost:4003/saml/metadata"');
    expect(xml).toContain("IDPSSODescriptor");
    expect(xml).toContain("KeyDescriptor");
    expect(xml).toContain("MIIC...base64cert...");
    expect(xml).toContain("SingleSignOnService");
    expect(xml).toContain("http://localhost:4003/saml/sso");
    expect(xml).toContain("urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect");
    expect(xml).toContain("urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress");
  });
});

describe("SAML Response XML", () => {
  it("builds response with assertion, subject, and attributes", () => {
    const xml = buildSamlResponse({
      responseId: "_resp123",
      assertionId: "_assert456",
      issuer: "http://localhost:4003/saml/metadata",
      destination: "http://localhost:3000/api/auth/sso/saml2/callback/local-idp",
      audienceEntityId: "http://localhost:3000",
      nameId: "alice@example.com",
      nameIdFormat: SAML_NAMEID_FORMATS.emailAddress,
      inResponseTo: "_req789",
      authnInstant: "2026-03-23T00:00:00Z",
      notBefore: "2026-03-22T23:55:00Z",
      notOnOrAfter: "2026-03-23T00:05:00Z",
      sessionNotOnOrAfter: "2026-03-23T08:00:00Z",
      attributes: [
        { name: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress", value: "alice@example.com" },
        { name: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name", value: "Alice Example" },
      ],
    });

    expect(xml).toContain("<saml2p:Response");
    expect(xml).toContain('ID="_resp123"');
    expect(xml).toContain("<saml2:Assertion");
    expect(xml).toContain('ID="_assert456"');
    expect(xml).toContain("<saml2:Issuer>http://localhost:4003/saml/metadata</saml2:Issuer>");
    expect(xml).toContain("<saml2:NameID");
    expect(xml).toContain("alice@example.com");
    expect(xml).toContain("<saml2:AudienceRestriction>");
    expect(xml).toContain("http://localhost:3000");
    expect(xml).toContain("<saml2:AttributeStatement>");
    expect(xml).toContain("Alice Example");
    expect(xml).toContain("InResponseTo");
  });
});

describe("SAML Assertion Signing", () => {
  it("produces a valid XML-DSig signature", async () => {
    const key = generateSigningKeySync("sign-test");
    const cert = await generateSelfSignedCert(key.private_key_pem);
    const certBase64 = getPublicCertBase64(cert);

    const xml = buildSamlResponse({
      responseId: "_resp1",
      assertionId: "_assert1",
      issuer: "http://localhost:4003/saml/metadata",
      destination: "http://localhost:3000/callback",
      audienceEntityId: "http://localhost:3000",
      nameId: "alice@example.com",
      nameIdFormat: SAML_NAMEID_FORMATS.emailAddress,
      inResponseTo: "_req1",
      authnInstant: new Date().toISOString(),
      notBefore: new Date(Date.now() - 300000).toISOString(),
      notOnOrAfter: new Date(Date.now() + 300000).toISOString(),
      sessionNotOnOrAfter: new Date(Date.now() + 28800000).toISOString(),
      attributes: [
        { name: "email", value: "alice@example.com" },
      ],
    });

    const signed = signAssertion(xml, key.private_key_pem, certBase64);
    expect(signed).toContain("<ds:Signature");
    expect(signed).toContain("<ds:SignatureValue");
    expect(signed).toContain("<ds:DigestValue");

    // Verify signature using xml-crypto
    const doc = new (await import("@xmldom/xmldom")).DOMParser().parseFromString(signed);
    const sig = doc.getElementsByTagNameNS("http://www.w3.org/2000/09/xmldsig#", "Signature")[0];
    expect(sig).toBeDefined();

    const sigVerifier = new SignedXml();
    sigVerifier.publicCert = cert;
    sigVerifier.loadSignature(sig);
    const isValid = sigVerifier.checkSignature(signed);
    expect(isValid).toBe(true);
  });
});

describe("Auto-Post Form", () => {
  it("builds HTML with hidden form fields", () => {
    const html = buildAutoPostForm(
      "http://localhost:3000/callback",
      "PHNhbWw+dGVzdDwvc2FtbD4=",
      "https://app.example.com/dashboard"
    );
    expect(html).toContain("<form");
    expect(html).toContain('action="http://localhost:3000/callback"');
    expect(html).toContain('method="post"');
    expect(html).toContain('name="SAMLResponse"');
    expect(html).toContain("PHNhbWw+dGVzdDwvc2FtbD4=");
    expect(html).toContain('name="RelayState"');
    expect(html).toContain("https://app.example.com/dashboard");
    expect(html).toContain("submit()"); // auto-submit via JS
  });

  it("handles empty RelayState", () => {
    const html = buildAutoPostForm("http://localhost/cb", "dGVzdA==", "");
    expect(html).toContain("<form");
    expect(html).not.toContain('name="RelayState"');
  });
});

describe("ENTRA_ID_ATTRIBUTE_MAPPINGS", () => {
  it("maps standard Entra ID claim URIs", () => {
    expect(ENTRA_ID_ATTRIBUTE_MAPPINGS["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"]).toBe("email");
    expect(ENTRA_ID_ATTRIBUTE_MAPPINGS["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier"]).toBe("uid");
    expect(ENTRA_ID_ATTRIBUTE_MAPPINGS["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"]).toBe("name");
    expect(ENTRA_ID_ATTRIBUTE_MAPPINGS["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname"]).toBe("given_name");
    expect(ENTRA_ID_ATTRIBUTE_MAPPINGS["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname"]).toBe("family_name");
  });
});

// ---------------------------------------------------------------------------
// SAML Route Integration Tests
// ---------------------------------------------------------------------------

import { getIdpStore } from "../store.js";

function createSamlTestApp(config?: IdpSeedConfig) {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  const app = new Hono();
  app.use("*", authMiddleware(tokenMap));
  idpPlugin.register(app as any, store, webhooks, "http://localhost:4003", tokenMap);
  idpPlugin.seed!(store, "http://localhost:4003");
  if (config) seedFromConfig(store, "http://localhost:4003", config);
  return { app, store, tokenMap };
}

/** Helper to perform full SAML SSO flow and return the SAMLResponse XML */
async function performSamlSso(app: any, store: Store, targetEmail: string, acsUrl = "http://localhost:3000/callback", spEntityId = "http://localhost:3000", relayState = ""): Promise<string> {
  const idp = getIdpStore(store);
  const user = idp.users.findOneBy("email", targetEmail);
  if (!user) throw new Error(`User ${targetEmail} not found in store`);

  const samlReq = buildSamlRequest(acsUrl, spEntityId);
  const qs = relayState ? `&RelayState=${encodeURIComponent(relayState)}` : "";
  const ssoRes = await app.request(`/saml/sso?SAMLRequest=${encodeURIComponent(samlReq)}${qs}`);
  const ssoHtml = await ssoRes.text();
  const refMatch = ssoHtml.match(/name="saml_request_ref"\s+value="([^"]+)"/);
  if (!refMatch) throw new Error("No saml_request_ref found in SSO page");

  const callbackRes = await app.request("/saml/sso/callback", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      uid: user.uid,
      saml_request_ref: refMatch[1],
    }).toString(),
  });
  return callbackRes.text();
}

function buildSamlRequest(acsUrl: string, issuer: string, requestId = "_req123"): string {
  const xml = `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="${requestId}" Version="2.0" IssueInstant="${new Date().toISOString()}" AssertionConsumerServiceURL="${acsUrl}" Destination="http://localhost:4003/saml/sso"><saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${issuer}</saml:Issuer></samlp:AuthnRequest>`;
  const deflated = deflateRawSync(Buffer.from(xml));
  return deflated.toString("base64");
}

describe("SAML Metadata endpoint", () => {
  it("GET /saml/metadata returns XML with EntityDescriptor and correct entity ID", async () => {
    const { app } = createSamlTestApp();
    const res = await app.request("/saml/metadata");
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain("EntityDescriptor");
    expect(xml).toContain("http://localhost:4003/saml/metadata");
    expect(xml).toContain("IDPSSODescriptor");
    expect(xml).toContain("X509Certificate");
  });
});

describe("SAML SSO endpoint", () => {
  it("GET /saml/sso with SAMLRequest renders user picker HTML with users", async () => {
    const { app } = createSamlTestApp({
      users: [
        { email: "alice@example.com", name: "Alice" },
        { email: "bob@example.com", name: "Bob" },
      ],
    });
    const samlReq = buildSamlRequest("http://localhost:3000/callback", "http://localhost:3000");
    const res = await app.request(`/saml/sso?SAMLRequest=${encodeURIComponent(samlReq)}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("alice@example.com");
    expect(html).toContain("bob@example.com");
    expect(html).toContain("Sign in");
  });
});

describe("SAML SSO callback", () => {
  it("POST /saml/sso/callback returns auto-post form HTML with SAMLResponse", async () => {
    const { app, store } = createSamlTestApp({
      users: [{ email: "alice@example.com", name: "Alice" }],
    });

    const html = await performSamlSso(app, store, "alice@example.com");
    expect(html).toContain("<form");
    expect(html).toContain('name="SAMLResponse"');
    expect(html).toContain('action="http://localhost:3000/callback"');
    expect(html).toContain("submit()");
  });
});

describe("SAMLResponse contains valid assertion", () => {
  it("parses the base64 SAMLResponse and finds correct NameID and attributes", async () => {
    const { app, store } = createSamlTestApp({
      users: [{ email: "alice@example.com", name: "Alice Example" }],
    });

    const html = await performSamlSso(app, store, "alice@example.com");
    const samlRespMatch = html.match(/name="SAMLResponse"\s+value="([^"]+)"/);
    expect(samlRespMatch).toBeTruthy();
    const responseXml = Buffer.from(samlRespMatch![1], "base64").toString("utf-8");
    expect(responseXml).toContain("alice@example.com");
    expect(responseXml).toContain("saml2:NameID");
    expect(responseXml).toContain("saml2:Assertion");
    expect(responseXml).toContain("Alice Example");
  });
});

describe("Entra ID default claims", () => {
  it("without custom mappings, assertion uses Entra ID claim URIs", async () => {
    const { app, store } = createSamlTestApp({
      users: [{ email: "alice@example.com", name: "Alice Example" }],
    });

    const html = await performSamlSso(app, store, "alice@example.com");
    const samlRespMatch = html.match(/name="SAMLResponse"\s+value="([^"]+)"/);
    const responseXml = Buffer.from(samlRespMatch![1], "base64").toString("utf-8");

    expect(responseXml).toContain("http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress");
    expect(responseXml).toContain("http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name");
  });
});

describe("Custom attribute mappings", () => {
  it("with override, assertion uses custom claim URIs", async () => {
    const { app, store } = createSamlTestApp({
      users: [{ email: "alice@example.com", name: "Alice" }],
      saml: {
        service_providers: [{
          entity_id: "http://localhost:3000",
          acs_url: "http://localhost:3000/callback",
          attribute_mappings: {
            "custom:email": "email",
            "custom:name": "name",
          },
        }],
      },
    });

    const html = await performSamlSso(app, store, "alice@example.com");
    const samlRespMatch = html.match(/name="SAMLResponse"\s+value="([^"]+)"/);
    const responseXml = Buffer.from(samlRespMatch![1], "base64").toString("utf-8");

    expect(responseXml).toContain("custom:email");
    expect(responseXml).toContain("custom:name");
    // Should NOT contain the default Entra ID URIs
    expect(responseXml).not.toContain("http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress");
  });
});

describe("NameID format emailAddress", () => {
  it("NameID contains user email", async () => {
    const { app, store } = createSamlTestApp({
      users: [{ email: "alice@example.com", name: "Alice" }],
    });

    const html = await performSamlSso(app, store, "alice@example.com");
    const samlRespMatch = html.match(/name="SAMLResponse"\s+value="([^"]+)"/);
    const responseXml = Buffer.from(samlRespMatch![1], "base64").toString("utf-8");

    expect(responseXml).toContain("urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress");
    expect(responseXml).toContain(">alice@example.com<");
  });
});

describe("Strict mode", () => {
  it("unknown SP entity ID returns error page", async () => {
    const { app } = createSamlTestApp({
      strict: true,
      saml: {
        service_providers: [{
          entity_id: "http://known-sp.example.com",
          acs_url: "http://known-sp.example.com/callback",
        }],
      },
    });

    const samlReq = buildSamlRequest("http://unknown-sp.com/callback", "http://unknown-sp.com");
    const res = await app.request(`/saml/sso?SAMLRequest=${encodeURIComponent(samlReq)}`);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Unknown Service Provider");
  });
});

describe("RelayState roundtrip", () => {
  it("RelayState appears in the auto-post form", async () => {
    const { app, store } = createSamlTestApp({
      users: [{ email: "alice@example.com", name: "Alice" }],
    });

    const html = await performSamlSso(app, store, "alice@example.com", "http://localhost:3000/callback", "http://localhost:3000", "https://app.example.com/dashboard");
    expect(html).toContain('name="RelayState"');
    expect(html).toContain("https://app.example.com/dashboard");
  });
});

describe("Custom IdP entity ID", () => {
  it("saml.entity_id override appears in metadata issuer", async () => {
    const { app } = createSamlTestApp({
      saml: { entity_id: "https://custom-idp.example.com" },
    });

    const res = await app.request("/saml/metadata");
    const xml = await res.text();
    expect(xml).toContain('entityID="https://custom-idp.example.com"');
  });
});

describe("User attributes in assertion", () => {
  it("custom attributes (department, groups) appear as claims", async () => {
    const { app, store } = createSamlTestApp({
      users: [{ email: "alice@example.com", name: "Alice", groups: ["admins", "devs"], attributes: { department: "Engineering" } }],
      saml: {
        service_providers: [{
          entity_id: "http://localhost:3000",
          acs_url: "http://localhost:3000/callback",
          attribute_mappings: {
            "custom:email": "email",
            "custom:department": "attributes.department",
            "custom:groups": "groups",
          },
        }],
      },
    });

    const html = await performSamlSso(app, store, "alice@example.com");
    const samlRespMatch = html.match(/name="SAMLResponse"\s+value="([^"]+)"/);
    const responseXml = Buffer.from(samlRespMatch![1], "base64").toString("utf-8");

    expect(responseXml).toContain("custom:department");
    expect(responseXml).toContain("Engineering");
    expect(responseXml).toContain("custom:groups");
  });
});
