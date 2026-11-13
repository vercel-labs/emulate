// SAML 2.0 building blocks shared by the emulators, exported as `@emulators/core/saml` so only the emulators that
// use SAML load the XML signature dependencies: an identity provider (Okta) builds and signs responses, and a
// service provider (GitHub, Slack, Google) sends AuthnRequests and verifies the responses it receives.
// Core: https://docs.oasis-open.org/security/saml/v2.0/saml-core-2.0-os.pdf
// Bindings: https://docs.oasis-open.org/security/saml/v2.0/saml-bindings-2.0-os.pdf
// Profiles: https://docs.oasis-open.org/security/saml/v2.0/saml-profiles-2.0-os.pdf

import { randomBytes } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { DOMParser, type Document, type Element } from "@xmldom/xmldom";
import { SignedXml } from "xml-crypto";
import { certificateToPem } from "./x509.js";

export {
  certificateMatchesKey,
  certificateToPem,
  createSelfSignedCertificate,
  type SelfSignedCertificate,
} from "./x509.js";

export const SAML_NS = {
  protocol: "urn:oasis:names:tc:SAML:2.0:protocol",
  assertion: "urn:oasis:names:tc:SAML:2.0:assertion",
  metadata: "urn:oasis:names:tc:SAML:2.0:metadata",
  xmldsig: "http://www.w3.org/2000/09/xmldsig#",
} as const;

export const SAML_NAMEID_FORMATS = {
  emailAddress: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  unspecified: "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
  persistent: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
  transient: "urn:oasis:names:tc:SAML:2.0:nameid-format:transient",
  x509SubjectName: "urn:oasis:names:tc:SAML:1.1:nameid-format:x509SubjectName",
} as const;

export const SAML_BINDINGS = {
  httpRedirect: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
  httpPost: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
} as const;

export const SAML_STATUS_SUCCESS = "urn:oasis:names:tc:SAML:2.0:status:Success";
export const SAML_ATTRIBUTE_NAME_FORMAT_UNSPECIFIED = "urn:oasis:names:tc:SAML:2.0:attrname-format:unspecified";
export const SAML_AUTHN_CONTEXT_PASSWORD_PROTECTED_TRANSPORT =
  "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport";

export type SamlSignatureAlgorithm = "RSA_SHA256" | "RSA_SHA1";
export type SamlDigestAlgorithm = "SHA256" | "SHA1";

const SIGNATURE_ALGORITHMS: Record<SamlSignatureAlgorithm, string> = {
  RSA_SHA256: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  RSA_SHA1: "http://www.w3.org/2000/09/xmldsig#rsa-sha1",
};
const DIGEST_ALGORITHMS: Record<SamlDigestAlgorithm, string> = {
  SHA256: "http://www.w3.org/2001/04/xmlenc#sha256",
  SHA1: "http://www.w3.org/2000/09/xmldsig#sha1",
};
const EXCLUSIVE_C14N = "http://www.w3.org/2001/10/xml-exc-c14n#";
const ENVELOPED_SIGNATURE = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";
const BEARER = "urn:oasis:names:tc:SAML:2.0:cm:bearer";

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** A SAML ID: an xs:ID, so it must not start with a digit. */
export function generateSamlId(prefix = "id"): string {
  return `${prefix}${randomBytes(20).toString("hex")}`;
}

/** SAML timestamps are UTC xs:dateTime values; whole seconds read as most identity providers send them. */
function samlInstant(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

// ---------------------------------------------------------------------------------------------------------------
// Identity provider side
// ---------------------------------------------------------------------------------------------------------------

export interface SamlIdpMetadataInput {
  entityId: string;
  ssoUrl: string;
  /** Base64 DER signing certificate. */
  certificate: string;
  nameIdFormats?: string[];
}

export function buildIdpMetadata(input: SamlIdpMetadataInput): string {
  const formats = (input.nameIdFormats ?? [SAML_NAMEID_FORMATS.emailAddress, SAML_NAMEID_FORMATS.unspecified])
    .map((format) => `<md:NameIDFormat>${escapeXml(format)}</md:NameIDFormat>`)
    .join("");
  const location = escapeXml(input.ssoUrl);
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<md:EntityDescriptor xmlns:md="${SAML_NS.metadata}" entityID="${escapeXml(input.entityId)}">` +
    `<md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="${SAML_NS.protocol}">` +
    `<md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="${SAML_NS.xmldsig}"><ds:X509Data>` +
    `<ds:X509Certificate>${input.certificate.replace(/\s+/g, "")}</ds:X509Certificate>` +
    `</ds:X509Data></ds:KeyInfo></md:KeyDescriptor>` +
    formats +
    `<md:SingleSignOnService Binding="${SAML_BINDINGS.httpPost}" Location="${location}"/>` +
    `<md:SingleSignOnService Binding="${SAML_BINDINGS.httpRedirect}" Location="${location}"/>` +
    `</md:IDPSSODescriptor></md:EntityDescriptor>`
  );
}

export interface SamlAttribute {
  name: string;
  nameFormat?: string;
  values: string[];
}

export interface SamlResponseInput {
  issuer: string;
  destination: string;
  recipient?: string;
  audience?: string;
  nameId: string;
  nameIdFormat?: string;
  inResponseTo?: string | null;
  attributes?: SamlAttribute[];
  authnContextClassRef?: string;
  /** How long the assertion stays valid. Defaults to 300 seconds. */
  lifetimeSeconds?: number;
  now?: number;
}

export interface BuiltSamlResponse {
  xml: string;
  responseId: string;
  assertionId: string;
}

export function buildSamlResponse(input: SamlResponseInput): BuiltSamlResponse {
  const now = input.now ?? Date.now();
  const lifetimeMs = (input.lifetimeSeconds ?? 300) * 1000;
  const issueInstant = samlInstant(now);
  const notBefore = samlInstant(now - lifetimeMs);
  const notOnOrAfter = samlInstant(now + lifetimeMs);
  const responseId = generateSamlId();
  const assertionId = generateSamlId();
  const inResponseTo = input.inResponseTo ? ` InResponseTo="${escapeXml(input.inResponseTo)}"` : "";
  const audience = input.audience
    ? `<saml2:AudienceRestriction><saml2:Audience>${escapeXml(input.audience)}</saml2:Audience></saml2:AudienceRestriction>`
    : "";
  const attributes = (input.attributes ?? []).filter((attribute) => attribute.values.length > 0);
  const attributeStatement = attributes.length
    ? `<saml2:AttributeStatement>${attributes
        .map(
          (attribute) =>
            `<saml2:Attribute Name="${escapeXml(attribute.name)}" NameFormat="${escapeXml(
              attribute.nameFormat ?? SAML_ATTRIBUTE_NAME_FORMAT_UNSPECIFIED,
            )}">${attribute.values
              .map(
                (value) =>
                  `<saml2:AttributeValue xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="xs:string">${escapeXml(value)}</saml2:AttributeValue>`,
              )
              .join("")}</saml2:Attribute>`,
        )
        .join("")}</saml2:AttributeStatement>`
    : "";

  const xml =
    `<saml2p:Response xmlns:saml2p="${SAML_NS.protocol}" Destination="${escapeXml(input.destination)}" ID="${responseId}"${inResponseTo} IssueInstant="${issueInstant}" Version="2.0">` +
    `<saml2:Issuer xmlns:saml2="${SAML_NS.assertion}" Format="urn:oasis:names:tc:SAML:2.0:nameid-format:entity">${escapeXml(input.issuer)}</saml2:Issuer>` +
    `<saml2p:Status><saml2p:StatusCode Value="${SAML_STATUS_SUCCESS}"/></saml2p:Status>` +
    `<saml2:Assertion xmlns:saml2="${SAML_NS.assertion}" ID="${assertionId}" IssueInstant="${issueInstant}" Version="2.0">` +
    `<saml2:Issuer Format="urn:oasis:names:tc:SAML:2.0:nameid-format:entity">${escapeXml(input.issuer)}</saml2:Issuer>` +
    `<saml2:Subject><saml2:NameID Format="${escapeXml(input.nameIdFormat ?? SAML_NAMEID_FORMATS.unspecified)}">${escapeXml(input.nameId)}</saml2:NameID>` +
    `<saml2:SubjectConfirmation Method="${BEARER}"><saml2:SubjectConfirmationData${inResponseTo} NotOnOrAfter="${notOnOrAfter}" Recipient="${escapeXml(input.recipient ?? input.destination)}"/></saml2:SubjectConfirmation></saml2:Subject>` +
    `<saml2:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">${audience}</saml2:Conditions>` +
    `<saml2:AuthnStatement AuthnInstant="${issueInstant}" SessionIndex="${assertionId}"><saml2:AuthnContext><saml2:AuthnContextClassRef>${escapeXml(input.authnContextClassRef ?? SAML_AUTHN_CONTEXT_PASSWORD_PROTECTED_TRANSPORT)}</saml2:AuthnContextClassRef></saml2:AuthnContext></saml2:AuthnStatement>` +
    attributeStatement +
    `</saml2:Assertion></saml2p:Response>`;

  return { xml, responseId, assertionId };
}

export interface SamlSigningOptions {
  privateKeyPem: string;
  /** Base64 DER certificate, embedded in the signature's KeyInfo. */
  certificate: string;
  signAssertion: boolean;
  signResponse: boolean;
  signatureAlgorithm?: SamlSignatureAlgorithm;
  digestAlgorithm?: SamlDigestAlgorithm;
}

function signElement(xml: string, element: "Response" | "Assertion", options: SamlSigningOptions): string {
  const elementPath = element === "Response" ? "/*[local-name(.)='Response']" : "/*/*[local-name(.)='Assertion']";
  const signer = new SignedXml({
    privateKey: options.privateKeyPem,
    publicCert: certificateToPem(options.certificate),
    canonicalizationAlgorithm: EXCLUSIVE_C14N,
    signatureAlgorithm: SIGNATURE_ALGORITHMS[options.signatureAlgorithm ?? "RSA_SHA256"],
  });
  signer.addReference({
    xpath: elementPath,
    digestAlgorithm: DIGEST_ALGORITHMS[options.digestAlgorithm ?? "SHA256"],
    transforms: [ENVELOPED_SIGNATURE, EXCLUSIVE_C14N],
  });
  // The schema places ds:Signature directly after the element's Issuer.
  signer.computeSignature(xml, {
    prefix: "ds",
    location: { reference: `${elementPath}/*[local-name(.)='Issuer']`, action: "after" },
  });
  return signer.getSignedXml();
}

/** Signs the assertion, then the response, so a response signature covers the signed assertion. */
export function signSamlResponse(xml: string, options: SamlSigningOptions): string {
  let signed = xml;
  if (options.signAssertion) signed = signElement(signed, "Assertion", options);
  if (options.signResponse) signed = signElement(signed, "Response", options);
  return signed;
}

export interface ParsedAuthnRequest {
  id: string;
  issuer: string;
  acsUrl: string;
  destination: string;
  forceAuthn: boolean;
}

/**
 * Decodes an AuthnRequest from the HTTP-Redirect binding (deflated, then base64) or the HTTP-POST binding
 * (base64). Returns null when the value is not an AuthnRequest.
 */
export function parseAuthnRequest(encoded: string, binding: "redirect" | "post"): ParsedAuthnRequest | null {
  let raw: Buffer;
  try {
    raw = Buffer.from(encoded, "base64");
  } catch {
    return null;
  }
  let xml: string;
  if (binding === "redirect") {
    try {
      xml = inflateRawSync(raw).toString("utf-8");
    } catch {
      return null;
    }
  } else {
    xml = raw.toString("utf-8");
  }
  const doc = parseXml(xml);
  const root = doc?.documentElement;
  if (!root || root.namespaceURI !== SAML_NS.protocol || root.localName !== "AuthnRequest") return null;
  return {
    id: root.getAttribute("ID") ?? "",
    issuer: textOf(firstChild(root, SAML_NS.assertion, "Issuer")),
    acsUrl: root.getAttribute("AssertionConsumerServiceURL") ?? "",
    destination: root.getAttribute("Destination") ?? "",
    forceAuthn: root.getAttribute("ForceAuthn") === "true",
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Service provider side
// ---------------------------------------------------------------------------------------------------------------

export interface SamlAuthnRequestInput {
  issuer: string;
  destination: string;
  acsUrl: string;
  nameIdFormat?: string;
  now?: number;
}

export function buildAuthnRequest(input: SamlAuthnRequestInput): { id: string; xml: string } {
  const id = generateSamlId("_");
  const policy = input.nameIdFormat
    ? `<samlp:NameIDPolicy Format="${escapeXml(input.nameIdFormat)}" AllowCreate="true"/>`
    : "";
  const xml =
    `<samlp:AuthnRequest xmlns:samlp="${SAML_NS.protocol}" xmlns:saml="${SAML_NS.assertion}" ID="${id}" Version="2.0" IssueInstant="${samlInstant(input.now ?? Date.now())}" Destination="${escapeXml(input.destination)}" ProtocolBinding="${SAML_BINDINGS.httpPost}" AssertionConsumerServiceURL="${escapeXml(input.acsUrl)}">` +
    `<saml:Issuer>${escapeXml(input.issuer)}</saml:Issuer>${policy}</samlp:AuthnRequest>`;
  return { id, xml };
}

/** Encodes a message for the HTTP-Redirect binding: DEFLATE, then base64. URL-encode it when building the query. */
export function encodeRedirectBinding(xml: string): string {
  return deflateRawSync(Buffer.from(xml, "utf-8")).toString("base64");
}

export interface VerifySamlResponseOptions {
  /** Trusted IdP signing certificates, base64 DER or PEM. */
  certificates: string[];
  /** The SP's assertion consumer service URL: checked against Destination and the bearer Recipient. */
  acsUrl: string;
  /** The SP entity ID, which must appear as an Audience. */
  audience: string;
  /** The expected IdP entity ID. */
  issuer?: string;
  /**
   * The ID of the AuthnRequest this response answers. A response that answers a different request is refused.
   * Leave it null for IdP-initiated sign-in, which is refused unless `allowUnsolicited` is true.
   */
  requestId?: string | null;
  allowUnsolicited?: boolean;
  now?: number;
  /** Allowed clock skew for NotBefore and NotOnOrAfter. Defaults to 60 seconds. */
  clockSkewSeconds?: number;
}

export interface VerifiedSamlAssertion {
  issuer: string;
  nameId: string;
  nameIdFormat: string;
  sessionIndex: string;
  inResponseTo: string;
  attributes: Record<string, string[]>;
}

export type VerifySamlResponseResult = { ok: true; assertion: VerifiedSamlAssertion } | { ok: false; error: string };

function parseXml(xml: string): Document | null {
  // Identity providers never send a DTD; refusing one rules out entity expansion.
  if (/<!DOCTYPE/i.test(xml)) return null;
  try {
    return new DOMParser({
      onError: (level, message) => {
        if (level !== "warning") throw new Error(message);
      },
    }).parseFromString(xml, "text/xml");
  } catch {
    return null;
  }
}

function elementChildren(parent: Element, namespace: string, localName: string): Element[] {
  const found: Element[] = [];
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.nodeType !== 1) continue;
    const element = node as Element;
    if (element.namespaceURI === namespace && element.localName === localName) found.push(element);
  }
  return found;
}

function firstChild(parent: Element | null | undefined, namespace: string, localName: string): Element | null {
  return parent ? (elementChildren(parent, namespace, localName)[0] ?? null) : null;
}

function textOf(element: Element | null | undefined): string {
  return element?.textContent?.trim() ?? "";
}

/**
 * Verifies the enveloped signature on `element` and returns the element re-parsed from the bytes the signature
 * covers, so nothing outside the signed content can be read by mistake (XML signature wrapping).
 */
function verifiedCopy(xml: string, element: Element, certificates: string[]): Element | null {
  const signatures = elementChildren(element, SAML_NS.xmldsig, "Signature");
  const id = element.getAttribute("ID");
  if (signatures.length !== 1 || !id) return null;

  for (const certificate of certificates) {
    const verifier = new SignedXml({ publicCert: certificateToPem(certificate) });
    try {
      verifier.loadSignature(signatures[0] as unknown as Parameters<SignedXml["loadSignature"]>[0]);
      const references = verifier.getReferences();
      if (references.length !== 1 || references[0]!.uri !== `#${id}`) return null;
      if (!verifier.checkSignature(xml)) continue;
    } catch {
      continue;
    }
    const signed = verifier.getSignedReferences();
    const copy = signed.length === 1 ? parseXml(signed[0]!)?.documentElement : null;
    if (!copy || copy.namespaceURI !== element.namespaceURI || copy.localName !== element.localName) return null;
    if (copy.getAttribute("ID") !== id) return null;
    return copy;
  }
  return null;
}

function parseInstant(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Verifies a base64 SAMLResponse posted to an SP's assertion consumer service under the Web Browser SSO profile. */
export function verifySamlResponse(encoded: string, options: VerifySamlResponseOptions): VerifySamlResponseResult {
  const fail = (error: string): VerifySamlResponseResult => ({ ok: false, error });
  const xml = Buffer.from(encoded, "base64").toString("utf-8");
  const doc = parseXml(xml);
  const root = doc?.documentElement;
  if (!root || root.namespaceURI !== SAML_NS.protocol || root.localName !== "Response") {
    return fail("The SAMLResponse is not a SAML 2.0 Response.");
  }

  const status = firstChild(firstChild(root, SAML_NS.protocol, "Status"), SAML_NS.protocol, "StatusCode");
  if (status?.getAttribute("Value") !== SAML_STATUS_SUCCESS) {
    return fail(`The identity provider did not sign the user in (${status?.getAttribute("Value") ?? "no status"}).`);
  }

  let response = root;
  if (elementChildren(root, SAML_NS.xmldsig, "Signature").length > 0) {
    const signed = verifiedCopy(xml, root, options.certificates);
    if (!signed) return fail("The SAML response signature is invalid.");
    response = signed;
  }

  if (elementChildren(response, SAML_NS.assertion, "EncryptedAssertion").length > 0) {
    return fail("Encrypted assertions are not supported.");
  }
  const assertions = elementChildren(response, SAML_NS.assertion, "Assertion");
  if (assertions.length !== 1) return fail("The SAML response must contain exactly one assertion.");
  let assertion = assertions[0]!;
  if (elementChildren(assertion, SAML_NS.xmldsig, "Signature").length > 0) {
    const signed = verifiedCopy(xml, assertion, options.certificates);
    if (!signed) return fail("The SAML assertion signature is invalid.");
    assertion = signed;
  } else if (response === root) {
    return fail("Neither the SAML response nor its assertion is signed.");
  }

  const destination = response.getAttribute("Destination");
  if (destination && destination !== options.acsUrl) return fail("The SAML response was sent to another destination.");

  const issuer = textOf(firstChild(assertion, SAML_NS.assertion, "Issuer"));
  if (options.issuer !== undefined && issuer !== options.issuer) {
    return fail("The SAML assertion comes from an unexpected issuer.");
  }

  const now = options.now ?? Date.now();
  const skew = (options.clockSkewSeconds ?? 60) * 1000;
  const conditions = firstChild(assertion, SAML_NS.assertion, "Conditions");
  const notBefore = parseInstant(conditions?.getAttribute("NotBefore") ?? null);
  const notOnOrAfter = parseInstant(conditions?.getAttribute("NotOnOrAfter") ?? null);
  if (notBefore !== null && now + skew < notBefore) return fail("The SAML assertion is not yet valid.");
  if (notOnOrAfter !== null && now - skew >= notOnOrAfter) return fail("The SAML assertion has expired.");

  const audiences = conditions
    ? elementChildren(conditions, SAML_NS.assertion, "AudienceRestriction").map((restriction) =>
        elementChildren(restriction, SAML_NS.assertion, "Audience").map((entry) => textOf(entry)),
      )
    : [];
  if (audiences.length === 0 || !audiences.every((list) => list.includes(options.audience))) {
    return fail("The SAML assertion is not intended for this service provider.");
  }

  const subject = firstChild(assertion, SAML_NS.assertion, "Subject");
  const nameIdElement = firstChild(subject, SAML_NS.assertion, "NameID");
  const nameId = textOf(nameIdElement);
  if (!nameId) return fail("The SAML assertion has no NameID.");

  const confirmation = subject
    ? elementChildren(subject, SAML_NS.assertion, "SubjectConfirmation").find(
        (entry) => entry.getAttribute("Method") === BEARER,
      )
    : undefined;
  const confirmationData = firstChild(confirmation, SAML_NS.assertion, "SubjectConfirmationData");
  if (!confirmationData) return fail("The SAML assertion has no bearer subject confirmation.");
  if (confirmationData.getAttribute("Recipient") !== options.acsUrl) {
    return fail("The SAML assertion was issued for another recipient.");
  }
  const confirmationExpiry = parseInstant(confirmationData.getAttribute("NotOnOrAfter"));
  if (confirmationExpiry === null) return fail("The SAML subject confirmation has no NotOnOrAfter.");
  if (now - skew >= confirmationExpiry) return fail("The SAML assertion has expired.");

  const inResponseTo = confirmationData.getAttribute("InResponseTo") ?? response.getAttribute("InResponseTo") ?? "";
  if (options.requestId) {
    if (inResponseTo !== options.requestId) return fail("The SAML response answers a different sign-in request.");
  } else if (inResponseTo) {
    return fail("The SAML response answers a sign-in request this browser did not start.");
  } else if (!options.allowUnsolicited) {
    return fail("IdP-initiated sign-in is not allowed.");
  }

  const attributes: Record<string, string[]> = {};
  for (const statement of elementChildren(assertion, SAML_NS.assertion, "AttributeStatement")) {
    for (const attribute of elementChildren(statement, SAML_NS.assertion, "Attribute")) {
      const name = attribute.getAttribute("Name");
      if (!name) continue;
      const values = elementChildren(attribute, SAML_NS.assertion, "AttributeValue").map((value) => textOf(value));
      attributes[name] = [...(attributes[name] ?? []), ...values];
    }
  }

  const authn = firstChild(assertion, SAML_NS.assertion, "AuthnStatement");
  return {
    ok: true,
    assertion: {
      issuer,
      nameId,
      nameIdFormat: nameIdElement?.getAttribute("Format") ?? SAML_NAMEID_FORMATS.unspecified,
      sessionIndex: authn?.getAttribute("SessionIndex") ?? "",
      inResponseTo,
      attributes,
    },
  };
}
