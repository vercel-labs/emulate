import { SignedXml } from "xml-crypto";
import { SAML_BINDINGS, SAML_NAMEID_FORMATS, SAML_NS } from "./saml-constants.js";

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
    <md:NameIDFormat>${SAML_NAMEID_FORMATS.unspecified}</md:NameIDFormat>
    <md:SingleSignOnService Binding="${SAML_BINDINGS.HTTP_POST}" Location="${escapeXml(ssoUrl)}"/>
    <md:SingleSignOnService Binding="${SAML_BINDINGS.HTTP_REDIRECT}" Location="${escapeXml(ssoUrl)}"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;
}

export interface SamlResponseParams {
  responseId: string;
  assertionId: string;
  issuer: string;
  destination: string;
  recipient: string;
  audience: string;
  nameId: string;
  nameIdFormat: string;
  inResponseTo: string | null;
  issueInstant: string;
  notBefore: string;
  notOnOrAfter: string;
  authnContextClassRef: string;
}

export function buildSamlResponse(params: SamlResponseParams): string {
  const {
    responseId,
    assertionId,
    issuer,
    destination,
    recipient,
    audience,
    nameId,
    nameIdFormat,
    inResponseTo,
    issueInstant,
    notBefore,
    notOnOrAfter,
    authnContextClassRef,
  } = params;

  const inResponseToAttr = inResponseTo ? ` InResponseTo="${escapeXml(inResponseTo)}"` : "";
  const audienceRestriction = audience
    ? `<saml2:AudienceRestriction><saml2:Audience>${escapeXml(audience)}</saml2:Audience></saml2:AudienceRestriction>`
    : "";

  return `<saml2p:Response xmlns:saml2p="${SAML_NS.PROTOCOL}" Destination="${escapeXml(destination)}" ID="${escapeXml(responseId)}"${inResponseToAttr} IssueInstant="${escapeXml(issueInstant)}" Version="2.0"><saml2:Issuer xmlns:saml2="${SAML_NS.ASSERTION}">${escapeXml(issuer)}</saml2:Issuer><saml2p:Status><saml2p:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></saml2p:Status><saml2:Assertion xmlns:saml2="${SAML_NS.ASSERTION}" ID="${escapeXml(assertionId)}" IssueInstant="${escapeXml(issueInstant)}" Version="2.0"><saml2:Issuer>${escapeXml(issuer)}</saml2:Issuer><saml2:Subject><saml2:NameID Format="${escapeXml(nameIdFormat)}">${escapeXml(nameId)}</saml2:NameID><saml2:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml2:SubjectConfirmationData${inResponseToAttr} NotOnOrAfter="${escapeXml(notOnOrAfter)}" Recipient="${escapeXml(recipient)}"/></saml2:SubjectConfirmation></saml2:Subject><saml2:Conditions NotBefore="${escapeXml(notBefore)}" NotOnOrAfter="${escapeXml(notOnOrAfter)}">${audienceRestriction}</saml2:Conditions><saml2:AuthnStatement AuthnInstant="${escapeXml(issueInstant)}" SessionIndex="${escapeXml(assertionId)}"><saml2:AuthnContext><saml2:AuthnContextClassRef>${escapeXml(authnContextClassRef)}</saml2:AuthnContextClassRef></saml2:AuthnContext></saml2:AuthnStatement></saml2:Assertion></saml2p:Response>`;
}

export interface SamlSigningOptions {
  privateKeyPem: string;
  certBase64: string;
  signatureAlgorithm: string;
  digestAlgorithm: string;
}

function signElement(xml: string, elementXpath: string, issuerXpath: string, options: SamlSigningOptions): string {
  const sig = new SignedXml({
    privateKey: options.privateKeyPem,
    publicCert: `-----BEGIN CERTIFICATE-----\n${options.certBase64}\n-----END CERTIFICATE-----`,
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
    signatureAlgorithm: options.signatureAlgorithm,
  });

  sig.addReference({
    xpath: elementXpath,
    digestAlgorithm: options.digestAlgorithm,
    transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"],
  });

  sig.computeSignature(xml, {
    prefix: "ds",
    location: { reference: issuerXpath, action: "after" },
  });

  return sig.getSignedXml();
}

export function signAssertion(responseXml: string, options: SamlSigningOptions): string {
  return signElement(
    responseXml,
    "//*[local-name(.)='Assertion']",
    "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']",
    options,
  );
}

export function signResponse(responseXml: string, options: SamlSigningOptions): string {
  return signElement(responseXml, "/*[local-name(.)='Response']", "/*/*[local-name(.)='Issuer']", options);
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
