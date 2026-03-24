import { SignedXml } from "xml-crypto";
import { SAML_NS, SAML_BINDINGS, SAML_NAMEID_FORMATS } from "./saml-constants.js";

export function buildMetadataXml(entityId: string, ssoUrl: string, certBase64: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="${SAML_NS.METADATA}" entityID="${escapeXml(entityId)}">
  <md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="${SAML_NS.PROTOCOL}">
    <md:KeyDescriptor use="signing">
      <ds:KeyInfo xmlns:ds="${SAML_NS.XMLDSIG}">
        <ds:X509Data>
          <ds:X509Certificate>${certBase64}</ds:X509Certificate>
        </ds:X509Data>
      </ds:KeyInfo>
    </md:KeyDescriptor>
    <md:NameIDFormat>${SAML_NAMEID_FORMATS.emailAddress}</md:NameIDFormat>
    <md:NameIDFormat>${SAML_NAMEID_FORMATS.persistent}</md:NameIDFormat>
    <md:NameIDFormat>${SAML_NAMEID_FORMATS.unspecified}</md:NameIDFormat>
    <md:SingleSignOnService Binding="${SAML_BINDINGS.HTTP_REDIRECT}" Location="${escapeXml(ssoUrl)}"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;
}

export interface SamlResponseParams {
  responseId: string;
  assertionId: string;
  issuer: string;
  destination: string;
  audienceEntityId: string;
  nameId: string;
  nameIdFormat: string;
  inResponseTo: string;
  authnInstant: string;
  notBefore: string;
  notOnOrAfter: string;
  sessionNotOnOrAfter: string;
  attributes: Array<{ name: string; value: string }>;
}

export function buildSamlResponse(params: SamlResponseParams): string {
  const {
    responseId, assertionId, issuer, destination, audienceEntityId,
    nameId, nameIdFormat, inResponseTo, authnInstant,
    notBefore, notOnOrAfter, sessionNotOnOrAfter, attributes,
  } = params;

  const now = new Date().toISOString();

  const attributeStatements = attributes.length > 0
    ? `<saml2:AttributeStatement>${attributes.map(a =>
        `<saml2:Attribute Name="${escapeXml(a.name)}" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:uri"><saml2:AttributeValue xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="xs:string">${escapeXml(a.value)}</saml2:AttributeValue></saml2:Attribute>`
      ).join("")}</saml2:AttributeStatement>`
    : "";

  return `<saml2p:Response xmlns:saml2p="${SAML_NS.PROTOCOL}" Destination="${escapeXml(destination)}" ID="${responseId}" InResponseTo="${inResponseTo}" IssueInstant="${now}" Version="2.0"><saml2:Issuer xmlns:saml2="${SAML_NS.ASSERTION}">${escapeXml(issuer)}</saml2:Issuer><saml2p:Status><saml2p:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></saml2p:Status><saml2:Assertion xmlns:saml2="${SAML_NS.ASSERTION}" ID="${assertionId}" IssueInstant="${now}" Version="2.0"><saml2:Issuer>${escapeXml(issuer)}</saml2:Issuer><saml2:Subject><saml2:NameID Format="${escapeXml(nameIdFormat)}">${escapeXml(nameId)}</saml2:NameID><saml2:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml2:SubjectConfirmationData InResponseTo="${inResponseTo}" NotOnOrAfter="${notOnOrAfter}" Recipient="${escapeXml(destination)}"/></saml2:SubjectConfirmation></saml2:Subject><saml2:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}"><saml2:AudienceRestriction><saml2:Audience>${escapeXml(audienceEntityId)}</saml2:Audience></saml2:AudienceRestriction></saml2:Conditions><saml2:AuthnStatement AuthnInstant="${authnInstant}" SessionIndex="${assertionId}" SessionNotOnOrAfter="${sessionNotOnOrAfter}"><saml2:AuthnContext><saml2:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml2:AuthnContextClassRef></saml2:AuthnContext></saml2:AuthnStatement>${attributeStatements}</saml2:Assertion></saml2p:Response>`;
}

export function signAssertion(responseXml: string, privateKeyPem: string, certBase64: string): string {
  const sig = new SignedXml({
    privateKey: privateKeyPem,
    publicCert: `-----BEGIN CERTIFICATE-----\n${certBase64}\n-----END CERTIFICATE-----`,
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  });

  sig.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
  });

  sig.computeSignature(responseXml, {
    prefix: "ds",
    location: { reference: "//*[local-name(.)='Issuer' and ancestor::*[local-name(.)='Assertion']]", action: "after" },
  });

  return sig.getSignedXml();
}

export function buildAutoPostForm(acsUrl: string, samlResponseB64: string, relayState: string): string {
  const relayStateField = relayState
    ? `<input type="hidden" name="RelayState" value="${escapeXml(relayState)}"/>`
    : "";

  return `<!DOCTYPE html>
<html>
<head><title>SSO Redirect</title></head>
<body onload="document.forms[0].submit()">
<noscript><p>JavaScript is required. Click the button below to continue.</p></noscript>
<form method="post" action="${escapeXml(acsUrl)}">
<input type="hidden" name="SAMLResponse" value="${samlResponseB64}"/>
${relayStateField}
<noscript><button type="submit">Continue</button></noscript>
</form>
</body>
</html>`;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
