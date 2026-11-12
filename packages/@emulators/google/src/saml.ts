import { X509Certificate, randomBytes } from "crypto";
import { DOMParser, type Document, type Element } from "@xmldom/xmldom";
import { SignedXml } from "xml-crypto";
import { escapeAttr, parseCookies, type Context, type Store } from "@emulators/core";
import { getGoogleStore } from "./store.js";
import type { GoogleUser } from "./entities.js";

const SAMLP_NS = "urn:oasis:names:tc:SAML:2.0:protocol";
const SAML_NS = "urn:oasis:names:tc:SAML:2.0:assertion";
const DSIG_NS = "http://www.w3.org/2000/09/xmldsig#";
const HTTP_POST_BINDING = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST";
const STATUS_SUCCESS = "urn:oasis:names:tc:SAML:2.0:status:Success";
const EMAIL_NAME_ID = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";
const RSA_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";

export const GOOGLE_SESSION_COOKIE = "_emu_google_session";
/** Identifies the browser that starts a sign-in, so that only that browser can complete it at the ACS. */
const SSO_BROWSER_COOKIE = "_emu_google_sso_browser";
/** "By default, the web session length for Google services is 14 days." */
export const WEB_SESSION_LENGTH_MS = 14 * 24 * 60 * 60 * 1000;

export interface GoogleSsoProfileSeed {
  /** The profile ID, from which its entity ID and ACS URL are derived. */
  id: string;
  name?: string;
  /** How the identity provider identifies itself when communicating with Google. */
  idp_entity_id?: string;
  /** Where users sign in to the identity provider (SSO URL or SAML 2.0 Endpoint). */
  sign_in_page_url: string;
  sign_out_page_url?: string;
  /** One or two X.509 certificates (PEM, or the base64 DER body) of the identity provider. */
  certificates: string[];
  /** Primary emails of the users the profile is assigned to. */
  users: string[];
}

export interface GoogleSsoProfile {
  id: string;
  name: string;
  idp_entity_id: string | null;
  sign_in_page_url: string;
  sign_out_page_url: string | null;
  certificates: string[];
  users: string[];
}

interface PendingAuthnRequest {
  profile_id: string;
  browser_id: string;
  continue_url: string;
  created_at: number;
}

interface GoogleWebSession {
  email: string;
  profile_id: string;
  expires_at: number;
}

function dataMap<T>(store: Store, key: string): Map<string, T> {
  let map = store.getData<Map<string, T>>(key);
  if (!map) {
    map = new Map();
    store.setData(key, map);
  }
  return map;
}

/** Accepts a PEM certificate or the base64 body of a DER certificate. */
function toCertificatePem(certificate: string, profileId: string): string {
  const trimmed = certificate.trim();
  const pem = trimmed.includes("-----BEGIN CERTIFICATE-----")
    ? trimmed
    : `-----BEGIN CERTIFICATE-----\n${(trimmed.replace(/\s+/g, "").match(/.{1,64}/g) ?? []).join("\n")}\n-----END CERTIFICATE-----`;
  let keyType: string | undefined;
  try {
    keyType = new X509Certificate(pem).publicKey.asymmetricKeyType;
  } catch {
    throw new Error(`Google sso_profiles[${profileId}]: the certificate is not a PEM or DER X.509 certificate`);
  }
  if (keyType === "dsa") {
    throw new Error(`Google sso_profiles[${profileId}]: DSA certificates are not supported by the emulator`);
  }
  if (keyType !== "rsa") {
    throw new Error(
      `Google sso_profiles[${profileId}]: the public key must be generated with the DSA or RSA algorithms`,
    );
  }
  return pem;
}

export function seedSsoProfiles(store: Store, profiles: GoogleSsoProfileSeed[]): void {
  const gs = getGoogleStore(store);
  const map = dataMap<GoogleSsoProfile>(store, "google.sso.profiles");
  const assigned = new Map<string, string>();
  for (const existing of map.values()) for (const email of existing.users) assigned.set(email, existing.id);

  for (const profile of profiles) {
    if (!profile.id || !/^[A-Za-z0-9_-]+$/.test(profile.id)) {
      throw new Error("Google sso_profiles[].id is required and may only contain letters, digits, '-' and '_'");
    }
    if (map.has(profile.id)) throw new Error(`Google sso_profiles[${profile.id}] is defined twice`);
    if (!profile.sign_in_page_url) throw new Error(`Google sso_profiles[${profile.id}].sign_in_page_url is required`);
    const certificates = profile.certificates ?? [];
    if (certificates.length < 1 || certificates.length > 2) {
      throw new Error(`Google sso_profiles[${profile.id}].certificates must hold one or two certificates`);
    }
    for (const email of profile.users ?? []) {
      if (!gs.users.findOneBy("email", email)) {
        throw new Error(`Google sso_profiles[${profile.id}].users: ${email} is not a seeded user`);
      }
      const other = assigned.get(email);
      if (other) throw new Error(`Google sso_profiles: ${email} is assigned to both ${other} and ${profile.id}`);
      assigned.set(email, profile.id);
    }
    map.set(profile.id, {
      id: profile.id,
      name: profile.name ?? profile.id,
      idp_entity_id: profile.idp_entity_id ?? null,
      sign_in_page_url: profile.sign_in_page_url,
      sign_out_page_url: profile.sign_out_page_url ?? null,
      certificates: certificates.map((certificate) => toCertificatePem(certificate, profile.id)),
      users: [...(profile.users ?? [])],
    });
  }
}

export function getSsoProfile(store: Store, id: string): GoogleSsoProfile | undefined {
  return store.getData<Map<string, GoogleSsoProfile>>("google.sso.profiles")?.get(id);
}

/**
 * The SSO profile `user` signs in with, if any. Super administrators sign in with Google:
 * single sign-on for them "is not supported by the newer SSO profiles".
 */
export function ssoProfileForUser(store: Store, user: GoogleUser | undefined): GoogleSsoProfile | null {
  if (!user || user.is_admin) return null;
  const profiles = store.getData<Map<string, GoogleSsoProfile>>("google.sso.profiles");
  if (!profiles) return null;
  for (const profile of profiles.values()) if (profile.users.includes(user.email)) return profile;
  return null;
}

/** The profile's entity ID, in the `https://accounts.google.com/samlrp/ID` form, on the emulator's base URL. */
export function samlEntityId(baseUrl: string, profile: GoogleSsoProfile): string {
  return `${baseUrl}/samlrp/${profile.id}`;
}

/** The profile's ACS URL, in the `https://accounts.google.com/samlrp/ID/acs` form, on the emulator's base URL. */
export function samlAcsUrl(baseUrl: string, profile: GoogleSsoProfile): string {
  return `${baseUrl}/samlrp/${profile.id}/acs`;
}

/** The SSO browser ID of the browser sending `c`, if it has one. */
export function getSsoBrowserId(c: Context): string | null {
  return parseCookies(c.req.header("Cookie") ?? "")[SSO_BROWSER_COOKIE] || null;
}

/**
 * Builds the unsigned AuthnRequest for the HTTP-POST binding and remembers it, bound to the browser
 * that sends `c`, until a response answers it. `setCookie` is the browser cookie to set, if the
 * browser has none yet.
 */
export function createAuthnRequest(
  store: Store,
  baseUrl: string,
  profile: GoogleSsoProfile,
  continueUrl: string,
  c: Context,
): { id: string; xml: string; relayState: string; setCookie: string | null } {
  let browserId = getSsoBrowserId(c);
  let setCookie: string | null = null;
  if (!browserId) {
    browserId = randomBytes(24).toString("hex");
    setCookie = `${SSO_BROWSER_COOKIE}=${browserId}; Path=/; HttpOnly; SameSite=Lax`;
  }
  const id = `_${randomBytes(20).toString("hex")}`;
  const xml =
    `<samlp:AuthnRequest xmlns:samlp="${SAMLP_NS}" xmlns:saml="${SAML_NS}" ID="${id}" Version="2.0"` +
    ` IssueInstant="${new Date().toISOString()}" Destination="${escapeAttr(profile.sign_in_page_url)}"` +
    ` AssertionConsumerServiceURL="${escapeAttr(samlAcsUrl(baseUrl, profile))}" ProtocolBinding="${HTTP_POST_BINDING}">` +
    `<saml:Issuer>${escapeAttr(samlEntityId(baseUrl, profile))}</saml:Issuer>` +
    `</samlp:AuthnRequest>`;
  dataMap<PendingAuthnRequest>(store, "google.sso.pendingRequests").set(id, {
    profile_id: profile.id,
    browser_id: browserId,
    continue_url: continueUrl,
    created_at: Date.now(),
  });
  return { id, xml, relayState: randomBytes(16).toString("hex"), setCookie };
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

const NOT_SIGNED = "The SAML assertion is not signed with the profile's verification certificate.";
const NOT_REQUESTED = "Google did not request this SAML response. Sign-in must start at Google.";
const NOT_THIS_BROWSER = "The SAML response does not answer a sign-in request from this browser.";

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
 * Verifies the enveloped RSA-SHA256 signature of `element` with the profile's certificates only,
 * and returns the signed element parsed from the XML the signature covers. Returns null when the
 * element carries no signature; refuses one that does not verify or that covers another element.
 */
function verifiedSignedElement(xml: string, element: Element, certificates: string[]): Element | null {
  const signatures = childElements(element, DSIG_NS, "Signature");
  if (signatures.length === 0) return null;
  if (signatures.length > 1) refuse(NOT_SIGNED);

  const id = element.getAttribute("ID");
  let signed: SignedXml | null = null;
  for (const certificate of certificates) {
    const candidate = new SignedXml({ publicCert: certificate, getCertFromKeyInfo: () => null });
    try {
      candidate.loadSignature(signatures[0]);
      if (candidate.signatureAlgorithm !== RSA_SHA256) refuse("The SAML assertion must be signed with RSA-SHA256.");
      if (id && candidate.checkSignature(xml)) {
        signed = candidate;
        break;
      }
    } catch (error) {
      if (error instanceof SamlResponseError) throw error;
    }
  }
  if (!signed) refuse(NOT_SIGNED);

  const references = signed.getSignedReferences();
  if (references.length !== 1) refuse(NOT_SIGNED);
  const signedRoot = parseXml(references[0]).documentElement;
  if (
    !signedRoot ||
    signedRoot.namespaceURI !== element.namespaceURI ||
    signedRoot.localName !== element.localName ||
    signedRoot.getAttribute("ID") !== id
  ) {
    refuse(NOT_SIGNED);
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
  assertionId: string;
  user: GoogleUser;
  inResponseTo: string;
  expiresAt: number;
}

/**
 * Validates a SAML response posted to `profile`'s ACS URL against Google's documented assertion
 * requirements. Every value used comes from an element a valid signature covers.
 */
export function validateSamlResponse(
  store: Store,
  samlResponse: string,
  baseUrl: string,
  profile: GoogleSsoProfile,
): ValidatedAssertion {
  const xml = Buffer.from(samlResponse, "base64").toString("utf8");
  const doc = parseXml(xml);
  const root = doc.documentElement;
  if (!root || root.namespaceURI !== SAMLP_NS || root.localName !== "Response") {
    throw new SamlResponseError("The SAML response is not a SAML 2.0 Response.", 400);
  }
  if (root.getAttribute("Version") !== "2.0") throw new SamlResponseError("The SAML response is not version 2.0.", 400);
  if (!hasUniqueIds(doc)) refuse(NOT_SIGNED);

  const acsUrl = samlAcsUrl(baseUrl, profile);
  const entityId = samlEntityId(baseUrl, profile);
  const signedResponse = verifiedSignedElement(xml, root, profile.certificates);

  if (doc.getElementsByTagNameNS(SAML_NS, "EncryptedAssertion").length > 0) {
    refuse("Encrypted assertions are not supported by the emulator.");
  }
  const rootAssertions = childElements(root, SAML_NS, "Assertion");
  if (doc.getElementsByTagNameNS(SAML_NS, "Assertion").length !== 1 || rootAssertions.length !== 1) {
    refuse("The SAML response must contain a single assertion.");
  }

  const signedAssertion = verifiedSignedElement(xml, rootAssertions[0], profile.certificates);
  if (!signedResponse && !signedAssertion) refuse(NOT_SIGNED);

  const response = signedResponse ?? root;
  let assertion: Element;
  if (signedAssertion) {
    assertion = signedAssertion;
  } else {
    const inner = childElements(signedResponse!, SAML_NS, "Assertion");
    if (inner.length !== 1) refuse("The SAML response must contain a single assertion.");
    assertion = inner[0];
  }

  // "This is an optional attribute; if it's set, it should be the ACS URL value."
  const destination = response.getAttribute("Destination");
  if (destination && destination !== acsUrl) {
    refuse(`The SAML response Destination must be the profile's ACS URL, ${acsUrl}.`);
  }

  const statusCode = childElement(childElement(response, SAMLP_NS, "Status"), SAMLP_NS, "StatusCode");
  if (statusCode?.getAttribute("Value") !== STATUS_SUCCESS) {
    refuse("The identity provider did not authenticate the user.");
  }

  // The IdP entity ID is "how your IdP identifies itself when communicating with Google": when the
  // profile sets one, it must be the assertion's Issuer, and the Response's when it names one.
  if (profile.idp_entity_id !== null) {
    const assertionIssuer = childElement(assertion, SAML_NS, "Issuer")?.textContent?.trim();
    const responseIssuer = childElement(response, SAML_NS, "Issuer")?.textContent?.trim();
    if (
      assertionIssuer !== profile.idp_entity_id ||
      (responseIssuer !== undefined && responseIssuer !== profile.idp_entity_id)
    ) {
      refuse(`The SAML Issuer must be the profile's IdP entity ID, ${profile.idp_entity_id}.`);
    }
  }

  // "NameID identifies the subject which is the user's primary email address. It is case-sensitive."
  const subject = childElement(assertion, SAML_NS, "Subject");
  const nameIdElement = childElement(subject, SAML_NS, "NameID");
  const nameId = nameIdElement?.textContent?.trim();
  if (!nameIdElement || !nameId || nameIdElement.getAttribute("Format") !== EMAIL_NAME_ID) {
    refuse(`The SAML assertion must carry a NameID in the ${EMAIL_NAME_ID} format.`);
  }
  const user = getGoogleStore(store).users.findOneBy("email", nameId);
  if (!user || ssoProfileForUser(store, user)?.id !== profile.id) {
    refuse("The NameID is not the primary email address of a user assigned to this SSO profile.");
  }

  const now = Date.now();
  const confirmationData = childElement(
    childElement(subject, SAML_NS, "SubjectConfirmation"),
    SAML_NS,
    "SubjectConfirmationData",
  );
  // "Recipient specifies the assertion consumer service URL of the service provider."
  if (confirmationData?.getAttribute("Recipient") !== acsUrl) {
    refuse(`The SAML assertion Recipient must be the profile's ACS URL, ${acsUrl}.`);
  }
  // The bearer SubjectConfirmationData MUST carry "a NotOnOrAfter attribute that limits the window
  // during which the assertion can be delivered" (SAML 2.0 Profiles, 4.1.4.2).
  const confirmationNotOnOrAfter = parseInstant(confirmationData.getAttribute("NotOnOrAfter"));
  if (confirmationNotOnOrAfter === null) {
    refuse("The SAML assertion does not limit when it can be delivered: SubjectConfirmationData has no NotOnOrAfter.");
  }
  if (now >= confirmationNotOnOrAfter) refuse("The SAML assertion has expired.");

  const conditions = childElement(assertion, SAML_NS, "Conditions");
  const notBefore = parseInstant(conditions?.getAttribute("NotBefore") ?? null);
  if (notBefore !== null && now < notBefore) refuse("The SAML assertion is not valid yet.");
  const notOnOrAfter = parseInstant(conditions?.getAttribute("NotOnOrAfter") ?? null);
  if (notOnOrAfter !== null && now >= notOnOrAfter) refuse("The SAML assertion has expired.");

  // "Audience ... The Entity ID value from the service provider (SP) details section of the SSO profile."
  const restrictions = conditions ? childElements(conditions, SAML_NS, "AudienceRestriction") : [];
  const audienceValid =
    restrictions.length > 0 &&
    restrictions.every((restriction) =>
      childElements(restriction, SAML_NS, "Audience").some((audience) => audience.textContent?.trim() === entityId),
    );
  if (!audienceValid) refuse(`The SAML assertion Audience must be the profile's entity ID, ${entityId}.`);

  // Google does not support identity-provider-initiated sign-on: the response must answer a request
  // Google sent, named by a signed element (the assertion's SubjectConfirmationData, or a signed Response).
  const confirmationInResponseTo = confirmationData.getAttribute("InResponseTo") || null;
  const responseInResponseTo = root.getAttribute("InResponseTo") || null;
  if (
    confirmationInResponseTo !== null &&
    responseInResponseTo !== null &&
    confirmationInResponseTo !== responseInResponseTo
  ) {
    refuse(NOT_REQUESTED);
  }
  const inResponseTo = confirmationInResponseTo ?? (signedResponse ? responseInResponseTo : null);
  if (inResponseTo === null) refuse(NOT_REQUESTED);

  return {
    assertionId: assertion.getAttribute("ID") ?? "",
    user,
    inResponseTo,
    expiresAt: Math.min(confirmationNotOnOrAfter, notOnOrAfter ?? Infinity),
  };
}

/**
 * Consumes the pending AuthnRequest the response answers; refuses one Google never sent for this
 * profile, or sent for another browser than the one posting the response (`browserId`).
 */
export function takePendingAuthnRequest(
  store: Store,
  profile: GoogleSsoProfile,
  assertion: ValidatedAssertion,
  browserId: string | null,
): PendingAuthnRequest {
  const pending = dataMap<PendingAuthnRequest>(store, "google.sso.pendingRequests");
  const request = pending.get(assertion.inResponseTo);
  if (!request || request.profile_id !== profile.id) refuse(NOT_REQUESTED);
  if (request.browser_id !== browserId) refuse(NOT_THIS_BROWSER);
  pending.delete(assertion.inResponseTo);
  return request;
}

/** Refuses an assertion already used (SAML 2.0 Profiles, 4.1.4.5: bearer assertions are not replayed). */
export function consumeAssertionId(store: Store, assertion: ValidatedAssertion): void {
  const used = dataMap<number>(store, "google.sso.usedAssertions");
  const now = Date.now();
  for (const [id, expiresAt] of used) if (expiresAt <= now) used.delete(id);
  if (used.has(assertion.assertionId)) refuse("This SAML response has already been used.");
  used.set(assertion.assertionId, assertion.expiresAt);
}

/** Opens the browser's Google web session for `user` and returns the cookie to set. */
export function openWebSession(store: Store, user: GoogleUser, profile: GoogleSsoProfile): string {
  const sessionId = randomBytes(24).toString("hex");
  dataMap<GoogleWebSession>(store, "google.sso.sessions").set(sessionId, {
    email: user.email,
    profile_id: profile.id,
    expires_at: Date.now() + WEB_SESSION_LENGTH_MS,
  });
  const maxAge = Math.floor(WEB_SESSION_LENGTH_MS / 1000);
  return `${GOOGLE_SESSION_COOKIE}=${sessionId}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`;
}

/** The user signed in by this browser's Google web session, if the session is still valid. */
export function getWebSessionUser(store: Store, c: Context): GoogleUser | null {
  const sessionId = parseCookies(c.req.header("Cookie") ?? "")[GOOGLE_SESSION_COOKIE];
  if (!sessionId) return null;
  const sessions = dataMap<GoogleWebSession>(store, "google.sso.sessions");
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (Date.now() >= session.expires_at) {
    sessions.delete(sessionId);
    return null;
  }
  const user = getGoogleStore(store).users.findOneBy("email", session.email);
  return user && ssoProfileForUser(store, user)?.id === session.profile_id ? user : null;
}
