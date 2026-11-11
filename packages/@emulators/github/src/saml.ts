import { randomBytes } from "crypto";
import { DOMParser, type Document, type Element } from "@xmldom/xmldom";
import { SignedXml } from "xml-crypto";
import { escapeAttr, type Store } from "@emulators/core";
import { getGitHubStore } from "./store.js";
import type { GitHubOrg, GitHubOrgSamlConfig } from "./entities.js";

const SAMLP_NS = "urn:oasis:names:tc:SAML:2.0:protocol";
const SAML_NS = "urn:oasis:names:tc:SAML:2.0:assertion";
const MD_NS = "urn:oasis:names:tc:SAML:2.0:metadata";
const DSIG_NS = "http://www.w3.org/2000/09/xmldsig#";
const HTTP_POST_BINDING = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST";
const STATUS_SUCCESS = "urn:oasis:names:tc:SAML:2.0:status:Success";

/** GitHub invalidates a SAML session 24 hours after authentication unless the IdP sets SessionNotOnOrAfter. */
export const SAML_SESSION_DEFAULT_MS = 24 * 60 * 60 * 1000;

export interface OrgSamlSeedConfig {
  sign_on_url: string;
  issuer?: string;
  public_certificate: string;
  signature_method?: "RSA-SHA256";
  digest_method?: "SHA256";
  enforced?: boolean;
}

interface PendingAuthnRequest {
  session_id: string;
  org_id: number;
  created_at: number;
}

export interface SamlSession {
  session_id: string;
  org_id: number;
  user_id: number;
  name_id: string;
  created_at: number;
  expires_at: number;
}

function getPendingRequests(store: Store): Map<string, PendingAuthnRequest> {
  let map = store.getData<Map<string, PendingAuthnRequest>>("github.saml.pendingRequests");
  if (!map) {
    map = new Map();
    store.setData("github.saml.pendingRequests", map);
  }
  return map;
}

function getSamlSessions(store: Store): Map<string, SamlSession> {
  let map = store.getData<Map<string, SamlSession>>("github.saml.sessions");
  if (!map) {
    map = new Map();
    store.setData("github.saml.sessions", map);
  }
  return map;
}

function sessionKey(sessionId: string, orgId: number): string {
  return `${orgId}:${sessionId}`;
}

export function seedOrgSamlConfig(store: Store, org: GitHubOrg, saml: OrgSamlSeedConfig): void {
  if (!saml.sign_on_url) throw new Error(`GitHub organization "${org.login}" saml.sign_on_url is required`);
  if (!saml.public_certificate) {
    throw new Error(`GitHub organization "${org.login}" saml.public_certificate is required`);
  }
  if (saml.signature_method !== undefined && saml.signature_method !== "RSA-SHA256") {
    throw new Error(`GitHub organization "${org.login}" saml.signature_method must be RSA-SHA256`);
  }
  if (saml.digest_method !== undefined && saml.digest_method !== "SHA256") {
    throw new Error(`GitHub organization "${org.login}" saml.digest_method must be SHA256`);
  }
  const gh = getGitHubStore(store);
  if (gh.orgSamlConfigs.findOneBy("org_id", org.id)) return;
  gh.orgSamlConfigs.insert({
    org_id: org.id,
    sign_on_url: saml.sign_on_url,
    issuer: saml.issuer ?? null,
    public_certificate: toCertificatePem(saml.public_certificate),
    signature_method: "RSA-SHA256",
    digest_method: "SHA256",
    enforced: saml.enforced ?? false,
  });
}

export function getOrgSamlConfig(store: Store, orgId: number): GitHubOrgSamlConfig | undefined {
  return getGitHubStore(store).orgSamlConfigs.findOneBy("org_id", orgId);
}

/** Accepts a PEM certificate or its base64 body, as IdPs show either. */
function toCertificatePem(certificate: string): string {
  const trimmed = certificate.trim();
  if (trimmed.includes("-----BEGIN CERTIFICATE-----")) return trimmed;
  const body = trimmed.replace(/\s+/g, "");
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----`;
}

export function samlEntityId(baseUrl: string, org: GitHubOrg): string {
  return `${baseUrl}/orgs/${org.login}`;
}

export function samlAcsUrl(baseUrl: string, org: GitHubOrg): string {
  return `${samlEntityId(baseUrl, org)}/saml/consume`;
}

export function renderSpMetadata(baseUrl: string, org: GitHubOrg): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="${MD_NS}" entityID="${escapeAttr(samlEntityId(baseUrl, org))}">
  <md:SPSSODescriptor protocolSupportEnumeration="${SAMLP_NS}">
    <md:AssertionConsumerService Binding="${HTTP_POST_BINDING}" Location="${escapeAttr(samlAcsUrl(baseUrl, org))}" index="0" isDefault="true"/>
  </md:SPSSODescriptor>
</md:EntityDescriptor>
`;
}

/** Builds an AuthnRequest for the HTTP-POST binding and remembers its ID for this browser session. */
export function createAuthnRequest(
  store: Store,
  baseUrl: string,
  org: GitHubOrg,
  config: GitHubOrgSamlConfig,
  sessionId: string,
): { id: string; xml: string } {
  const id = `_${randomBytes(20).toString("hex")}`;
  const issueInstant = new Date().toISOString();
  const xml =
    `<samlp:AuthnRequest xmlns:samlp="${SAMLP_NS}" xmlns:saml="${SAML_NS}" ID="${id}" Version="2.0"` +
    ` IssueInstant="${issueInstant}" Destination="${escapeAttr(config.sign_on_url)}"` +
    ` AssertionConsumerServiceURL="${escapeAttr(samlAcsUrl(baseUrl, org))}" ProtocolBinding="${HTTP_POST_BINDING}">` +
    `<saml:Issuer>${escapeAttr(samlEntityId(baseUrl, org))}</saml:Issuer>` +
    `</samlp:AuthnRequest>`;
  getPendingRequests(store).set(id, { session_id: sessionId, org_id: org.id, created_at: Date.now() });
  return { id, xml };
}

export class SamlResponseError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403,
  ) {
    super(message);
  }
}

function refuse(message: string): never {
  throw new SamlResponseError(message, 403);
}

function childElements(parent: Element, ns: string, localName: string): Element[] {
  const result: Element[] = [];
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.nodeType !== 1) continue;
    const el = node as Element;
    if (el.namespaceURI === ns && el.localName === localName) result.push(el);
  }
  return result;
}

function childElement(parent: Element | undefined, ns: string, localName: string): Element | undefined {
  return parent ? childElements(parent, ns, localName)[0] : undefined;
}

function parseXml(xml: string): Document {
  try {
    const doc = new DOMParser({
      onError: (level, message) => {
        if (level !== "warning") throw new Error(message);
      },
    }).parseFromString(xml, "text/xml");
    if (doc.doctype) throw new Error("DOCTYPE is not allowed");
    return doc;
  } catch {
    throw new SamlResponseError("The SAML response is not valid XML.", 400);
  }
}

function hasUniqueIds(doc: Document): boolean {
  const seen = new Set<string>();
  const all = doc.getElementsByTagName("*");
  for (let i = 0; i < all.length; i++) {
    const id = all[i].getAttribute("ID");
    if (id === null) continue;
    if (seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

/**
 * Verifies the enveloped signature of `element` with the configured certificate and returns the
 * signed element, parsed from the XML the signature covers. Returns null when the element carries
 * no signature; refuses one that does not verify or that covers another element.
 */
function verifiedSignedElement(xml: string, element: Element, certificate: string): Element | null {
  const signatures = childElements(element, DSIG_NS, "Signature");
  if (signatures.length === 0) return null;
  if (signatures.length > 1) refuse("SAML Response is not signed or has been modified.");

  const id = element.getAttribute("ID");
  const signed = new SignedXml({ publicCert: certificate, getCertFromKeyInfo: () => null });
  let valid = false;
  try {
    signed.loadSignature(signatures[0]);
    valid = Boolean(id) && signed.checkSignature(xml);
  } catch {
    valid = false;
  }
  if (!valid) refuse("SAML Response is not signed or has been modified.");

  const signedReferences = signed.getSignedReferences();
  if (signedReferences.length !== 1) refuse("SAML Response is not signed or has been modified.");
  const signedRoot = parseXml(signedReferences[0]).documentElement;
  if (
    !signedRoot ||
    signedRoot.namespaceURI !== element.namespaceURI ||
    signedRoot.localName !== element.localName ||
    signedRoot.getAttribute("ID") !== id
  ) {
    refuse("SAML Response is not signed or has been modified.");
  }
  return signedRoot;
}

function parseInstant(value: string | null): number | null {
  if (value === null) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) refuse("The SAML response has an invalid timestamp.");
  return time;
}

export interface ValidatedAssertion {
  nameId: string;
  inResponseTo: string;
  sessionNotOnOrAfter: number | null;
}

/**
 * Validates a SAML response against GitHub's documented requirements for an organization. Every
 * value used comes from the element a valid signature covers.
 */
export function validateSamlResponse(
  samlResponse: string,
  baseUrl: string,
  org: GitHubOrg,
  config: GitHubOrgSamlConfig,
): ValidatedAssertion {
  const xml = Buffer.from(samlResponse, "base64").toString("utf8");
  const doc = parseXml(xml);
  const root = doc.documentElement;
  if (!root || root.namespaceURI !== SAMLP_NS || root.localName !== "Response") {
    throw new SamlResponseError("The SAML response is not a SAML 2.0 Response.", 400);
  }
  if (!hasUniqueIds(doc)) refuse("SAML Response is not signed or has been modified.");

  const acsUrl = samlAcsUrl(baseUrl, org);
  const entityId = samlEntityId(baseUrl, org);

  if (doc.getElementsByTagNameNS(SAML_NS, "EncryptedAssertion").length > 0) {
    refuse("Encrypted assertions are not supported.");
  }
  const assertions = doc.getElementsByTagNameNS(SAML_NS, "Assertion");
  const rootAssertions = childElements(root, SAML_NS, "Assertion");
  if (assertions.length !== 1 || rootAssertions.length !== 1) {
    refuse("The SAML response must contain a single assertion.");
  }

  const signedResponse = verifiedSignedElement(xml, root, config.public_certificate);
  const response = signedResponse ?? root;
  let assertion: Element | undefined;
  if (signedResponse) {
    const inner = childElements(signedResponse, SAML_NS, "Assertion");
    if (inner.length !== 1) refuse("The SAML response must contain a single assertion.");
    assertion = verifiedSignedElement(xml, rootAssertions[0], config.public_certificate) ?? inner[0];
  } else {
    assertion = verifiedSignedElement(xml, rootAssertions[0], config.public_certificate) ?? undefined;
    if (!assertion) refuse("SAML Response is not signed or has been modified.");
  }

  if (signedResponse && response.getAttribute("Destination") !== acsUrl) {
    refuse("Destination in the SAML response was not valid.");
  }

  const statusCode = childElement(childElement(response, SAMLP_NS, "Status"), SAMLP_NS, "StatusCode");
  if (statusCode?.getAttribute("Value") !== STATUS_SUCCESS) {
    refuse("The identity provider did not authenticate the user.");
  }

  if (config.issuer !== null) {
    const assertionIssuer = childElement(assertion, SAML_NS, "Issuer")?.textContent?.trim();
    const responseIssuer = childElement(response, SAML_NS, "Issuer")?.textContent?.trim();
    if (assertionIssuer !== config.issuer || (responseIssuer !== undefined && responseIssuer !== config.issuer)) {
      refuse("Issuer in the SAML response was not valid.");
    }
  }

  const subject = childElement(assertion, SAML_NS, "Subject");
  const nameId = childElement(subject, SAML_NS, "NameID")?.textContent?.trim();
  if (!nameId) refuse("The SAML response must provide a NameID.");

  const now = Date.now();
  const confirmationData = childElement(
    childElement(subject, SAML_NS, "SubjectConfirmation"),
    SAML_NS,
    "SubjectConfirmationData",
  );
  const recipient = confirmationData?.getAttribute("Recipient");
  if (!recipient) refuse("Recipient in the SAML response must not be blank.");
  if (recipient !== acsUrl) refuse("Recipient in the SAML response was not valid.");
  const confirmationNotOnOrAfter = parseInstant(confirmationData?.getAttribute("NotOnOrAfter") ?? null);
  if (confirmationNotOnOrAfter !== null && now >= confirmationNotOnOrAfter) refuse("The SAML response has expired.");

  const conditions = childElement(assertion, SAML_NS, "Conditions");
  const notBefore = parseInstant(conditions?.getAttribute("NotBefore") ?? null);
  if (notBefore !== null && now < notBefore) refuse("Current time is earlier than NotBefore condition.");
  const notOnOrAfter = parseInstant(conditions?.getAttribute("NotOnOrAfter") ?? null);
  if (notOnOrAfter !== null && now >= notOnOrAfter) refuse("The SAML response has expired.");

  const restrictions = conditions ? childElements(conditions, SAML_NS, "AudienceRestriction") : [];
  const audienceValid =
    restrictions.length > 0 &&
    restrictions.every((restriction) =>
      childElements(restriction, SAML_NS, "Audience").some((audience) => audience.textContent?.trim() === entityId),
    );
  if (!audienceValid) refuse(`Audience is invalid. Audience attribute does not match ${entityId}`);

  // Only a signed element can name the request: the assertion's SubjectConfirmationData, or the
  // Response itself when it is signed.
  const confirmationInResponseTo = confirmationData?.getAttribute("InResponseTo") || null;
  const responseInResponseTo = response.getAttribute("InResponseTo") || null;
  const inResponseTo = confirmationInResponseTo ?? (signedResponse ? responseInResponseTo : null);
  if (!inResponseTo || (responseInResponseTo !== null && responseInResponseTo !== inResponseTo)) {
    refuse("The SAML response does not answer a sign-in request from this browser.");
  }

  const authnStatement = childElement(assertion, SAML_NS, "AuthnStatement");
  const sessionNotOnOrAfter = parseInstant(authnStatement?.getAttribute("SessionNotOnOrAfter") ?? null);

  return { nameId, inResponseTo, sessionNotOnOrAfter };
}

/** Consumes the pending AuthnRequest `requestId` if this browser session sent it for this organization. */
export function takePendingAuthnRequest(store: Store, requestId: string, sessionId: string, orgId: number): boolean {
  const pending = getPendingRequests(store);
  const request = pending.get(requestId);
  if (!request || request.session_id !== sessionId || request.org_id !== orgId) return false;
  pending.delete(requestId);
  return true;
}

export function openSamlSession(
  store: Store,
  sessionId: string,
  orgId: number,
  userId: number,
  nameId: string,
  sessionNotOnOrAfter: number | null,
): SamlSession {
  const now = Date.now();
  const session: SamlSession = {
    session_id: sessionId,
    org_id: orgId,
    user_id: userId,
    name_id: nameId,
    created_at: now,
    expires_at: sessionNotOnOrAfter ?? now + SAML_SESSION_DEFAULT_MS,
  };
  getSamlSessions(store).set(sessionKey(sessionId, orgId), session);
  return session;
}

/** The active SAML session of a browser session for an organization, if any. */
export function getActiveSamlSession(store: Store, sessionId: string, orgId: number): SamlSession | null {
  const sessions = getSamlSessions(store);
  const key = sessionKey(sessionId, orgId);
  const session = sessions.get(key);
  if (!session) return null;
  if (Date.now() >= session.expires_at) {
    sessions.delete(key);
    return null;
  }
  return session;
}

/** The NameID linked to a personal account in an organization, if the account has signed in with SAML. */
export function getLinkedSamlIdentity(store: Store, orgId: number, userId: number): string | null {
  const identity = getGitHubStore(store)
    .samlIdentities.findBy("org_id", orgId)
    .find((row) => row.user_id === userId);
  return identity?.name_id ?? null;
}

/**
 * Links `nameId` to the personal account on first use. Refuses a NameID linked to another account in
 * the organization. Returns `"relink"` without changing anything when the account is linked to
 * another NameID: GitHub then warns that the account is about to be relinked.
 */
export function linkSamlIdentity(store: Store, orgId: number, userId: number, nameId: string): "linked" | "relink" {
  const gh = getGitHubStore(store);
  const identities = gh.samlIdentities.findBy("org_id", orgId);
  const forNameId = identities.find((row) => row.name_id === nameId);
  if (forNameId && forNameId.user_id !== userId) {
    refuse("You cannot sign in with this external identity: it is linked to another GitHub account.");
  }
  const forUser = identities.find((row) => row.user_id === userId);
  if (forUser && forUser.name_id !== nameId) return "relink";
  if (!forUser) gh.samlIdentities.insert({ org_id: orgId, user_id: userId, name_id: nameId });
  return "linked";
}

/** Links the personal account to `nameId` in place of the identity it was linked to. */
export function relinkSamlIdentity(store: Store, orgId: number, userId: number, nameId: string): void {
  const gh = getGitHubStore(store);
  const identities = gh.samlIdentities.findBy("org_id", orgId);
  const forNameId = identities.find((row) => row.name_id === nameId);
  if (forNameId && forNameId.user_id !== userId) {
    refuse("You cannot sign in with this external identity: it is linked to another GitHub account.");
  }
  const forUser = identities.find((row) => row.user_id === userId);
  if (forUser) gh.samlIdentities.update(forUser.id, { name_id: nameId });
  else gh.samlIdentities.insert({ org_id: orgId, user_id: userId, name_id: nameId });
}

export interface PendingRelink {
  session_id: string;
  org_id: number;
  user_id: number;
  name_id: string;
  session_not_on_or_after: number | null;
  relay_state: string | null;
}

function getPendingRelinks(store: Store): Map<string, PendingRelink> {
  let map = store.getData<Map<string, PendingRelink>>("github.saml.pendingRelinks");
  if (!map) {
    map = new Map();
    store.setData("github.saml.pendingRelinks", map);
  }
  return map;
}

/** Keeps a validated assertion that needs the user's confirmation to relink, and returns its token. */
export function createPendingRelink(store: Store, relink: PendingRelink): string {
  const token = randomBytes(20).toString("hex");
  getPendingRelinks(store).set(token, relink);
  return token;
}

/** Consumes a pending relink if this browser session holds it for this organization. */
export function takePendingRelink(store: Store, token: string, sessionId: string, orgId: number): PendingRelink | null {
  const pending = getPendingRelinks(store);
  const relink = pending.get(token);
  if (!relink || relink.session_id !== sessionId || relink.org_id !== orgId) return null;
  pending.delete(token);
  return relink;
}
