import { randomBytes } from "crypto";
import { DOMParser, type Document, type Element } from "@xmldom/xmldom";
import { SignedXml } from "xml-crypto";
import { escapeAttr, parseCookies, type Context, type Store } from "@emulators/core";
import { getSlackStore } from "./store.js";
import type { SlackTeam, SlackUser } from "./entities.js";

const SAMLP_NS = "urn:oasis:names:tc:SAML:2.0:protocol";
const SAML_NS = "urn:oasis:names:tc:SAML:2.0:assertion";
const DSIG_NS = "http://www.w3.org/2000/09/xmldsig#";
const HTTP_POST_BINDING = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST";
const STATUS_SUCCESS = "urn:oasis:names:tc:SAML:2.0:status:Success";
const PERSISTENT_NAME_ID = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";

/** Slack's Service Provider Issuer (entity ID), also the Audience it expects. */
export const SLACK_SP_ISSUER = "https://slack.com";
export const SLACK_SESSION_COOKIE = "_emu_slack_session";

export type SlackSsoRequirement = "required" | "required_except_guests" | "optional";

export interface SlackSamlSeedConfig {
  /** The identity provider's SAML 2.0 Endpoint URL, where Slack sends sign-in requests. */
  endpoint_url: string;
  /** The Identity Provider Issuer URL. */
  idp_issuer: string;
  /** The identity provider's x.509 certificate, PEM or its base64 body. */
  public_certificate: string;
  responses_signed?: boolean;
  assertions_signed?: boolean;
  sso_requirement?: SlackSsoRequirement;
}

export interface SlackSamlConfig {
  endpoint_url: string;
  idp_issuer: string;
  public_certificate: string;
  responses_signed: boolean;
  assertions_signed: boolean;
  sso_requirement: SlackSsoRequirement;
}

interface PendingAuthnRequest {
  redir: string | null;
  created_at: number;
}

export interface SlackWebSession {
  session_id: string;
  user_id: string;
  name_id: string;
  created_at: number;
}

const SSO_REQUIREMENTS: SlackSsoRequirement[] = ["required", "required_except_guests", "optional"];

function dataMap<T>(store: Store, key: string): Map<string, T> {
  let map = store.getData<Map<string, T>>(key);
  if (!map) {
    map = new Map();
    store.setData(key, map);
  }
  return map;
}

export function seedSamlConfig(store: Store, saml: SlackSamlSeedConfig): void {
  if (!saml.endpoint_url) throw new Error("Slack team.saml.endpoint_url is required");
  if (!saml.idp_issuer) throw new Error("Slack team.saml.idp_issuer is required");
  if (!saml.public_certificate) throw new Error("Slack team.saml.public_certificate is required");
  const requirement = saml.sso_requirement ?? "optional";
  if (!SSO_REQUIREMENTS.includes(requirement)) {
    throw new Error(`Slack team.saml.sso_requirement must be one of ${SSO_REQUIREMENTS.join(", ")}`);
  }
  const config: SlackSamlConfig = {
    endpoint_url: saml.endpoint_url,
    idp_issuer: saml.idp_issuer,
    public_certificate: toCertificatePem(saml.public_certificate),
    responses_signed: saml.responses_signed ?? true,
    assertions_signed: saml.assertions_signed ?? false,
    sso_requirement: requirement,
  };
  store.setData("slack.saml", config);
}

export function getSamlConfig(store: Store): SlackSamlConfig | undefined {
  return store.getData<SlackSamlConfig>("slack.saml");
}

/** Accepts a PEM certificate or its base64 body, as identity providers show either. */
function toCertificatePem(certificate: string): string {
  const trimmed = certificate.trim();
  if (trimmed.includes("-----BEGIN CERTIFICATE-----")) return trimmed;
  const lines = trimmed.replace(/\s+/g, "").match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----`;
}

/** The workspace's `https://yourdomain.slack.com/sso/saml`, served on the emulator's base URL. */
export function samlAcsUrl(baseUrl: string): string {
  return `${baseUrl}/sso/saml`;
}

/**
 * A path on this host, so that a redirect after sign-in cannot leave the emulator: a single leading
 * "/", no backslash, no ASCII control or whitespace character (URL parsing drops tabs and newlines),
 * and a URL that resolves to the emulator's own origin with a path that still starts with a single
 * "/" once dot segments are removed. Returns the normalized path, query, and fragment.
 */
export function localPath(value: string | undefined | null, baseUrl: string): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u0020\u007f]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value, baseUrl);
  } catch {
    return null;
  }
  if (url.origin !== new URL(baseUrl).origin || url.pathname.startsWith("//")) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Builds an AuthnRequest for the HTTP-POST binding and remembers its ID until a response answers it. */
export function createAuthnRequest(
  store: Store,
  baseUrl: string,
  config: SlackSamlConfig,
  redir: string | null,
): { id: string; xml: string } {
  const id = `_${randomBytes(20).toString("hex")}`;
  const xml =
    `<samlp:AuthnRequest xmlns:samlp="${SAMLP_NS}" xmlns:saml="${SAML_NS}" ID="${id}" Version="2.0"` +
    ` IssueInstant="${new Date().toISOString()}" Destination="${escapeAttr(config.endpoint_url)}"` +
    ` AssertionConsumerServiceURL="${escapeAttr(samlAcsUrl(baseUrl))}" ProtocolBinding="${HTTP_POST_BINDING}">` +
    `<saml:Issuer>${SLACK_SP_ISSUER}</saml:Issuer>` +
    `</samlp:AuthnRequest>`;
  dataMap<PendingAuthnRequest>(store, "slack.saml.pendingRequests").set(id, { redir, created_at: Date.now() });
  return { id, xml };
}

/** Consumes the pending AuthnRequest `requestId`; returns null when the emulator never sent it. */
export function takePendingAuthnRequest(store: Store, requestId: string): PendingAuthnRequest | null {
  const pending = dataMap<PendingAuthnRequest>(store, "slack.saml.pendingRequests");
  const request = pending.get(requestId);
  if (!request) return null;
  pending.delete(requestId);
  return request;
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

// Slack's messages, from https://slack.com/help/articles/360037402653 ("[IDP]" names the identity provider).
export const SAML_ERRORS = {
  issuer:
    "The SAML Response does not contain the correct Identity Provider Issuer. Please check that the Issuer URL in your IDP settings matches the Identity Provider Issuer below.",
  responseNotSigned: "The SAML Response is not signed. Please check your IDP settings.",
  audience:
    "The SAML Response does not contain the correct Audience. Please check that the Service Provider URL in your IDP settings matches the Service Provider Issuer in Advanced Options below.",
  assertionNotSigned: "The Assertion of the SAML Response is not signed. Please check your IDP settings.",
  destination: (acsUrl: string) =>
    `The SAML Response does not contain the correct Destination, which should look something like ${acsUrl}. Please check your IDP settings.`,
  nameId: "The SAML Response is missing the ID attribute. Please check your IDP settings.",
  neitherSigned:
    "Neither the SAML Response nor Assertion of the SAML Response are signed. Please check your IDP settings.",
  encrypted:
    "The SAML Response is not signed (though there is a signed and encrypted Assertion with an EncryptedId). Apologies, but Slack doesn't support this format. Please check your IDP settings.",
  version: "The SAML Response is not version 2.0. Please check your IDP settings.",
  binding: "The SAML Response was not sent through a HTTP_POST Binding. Please check your IDP settings.",
  signature: "Hmm, it looks like the signature validation failed. Please check the signing certs in your IDP settings.",
} as const;

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
    throw new SamlResponseError("The SAML Response is not valid XML.", 400);
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
 * Verifies the enveloped signature of `element` with the configured certificate only, and returns
 * the signed element parsed from the XML the signature covers. Returns null when the element
 * carries no signature; refuses one that does not verify or that covers another element.
 */
function verifiedSignedElement(xml: string, element: Element, certificate: string): Element | null {
  const signatures = childElements(element, DSIG_NS, "Signature");
  if (signatures.length === 0) return null;
  if (signatures.length > 1) refuse(SAML_ERRORS.signature);

  const id = element.getAttribute("ID");
  const signed = new SignedXml({ publicCert: certificate, getCertFromKeyInfo: () => null });
  let valid = false;
  try {
    signed.loadSignature(signatures[0]);
    valid = Boolean(id) && signed.checkSignature(xml);
  } catch {
    valid = false;
  }
  if (!valid) refuse(SAML_ERRORS.signature);

  const references = signed.getSignedReferences();
  if (references.length !== 1) refuse(SAML_ERRORS.signature);
  const signedRoot = parseXml(references[0]).documentElement;
  if (
    !signedRoot ||
    signedRoot.namespaceURI !== element.namespaceURI ||
    signedRoot.localName !== element.localName ||
    signedRoot.getAttribute("ID") !== id
  ) {
    refuse(SAML_ERRORS.signature);
  }
  return signedRoot;
}

function parseInstant(value: string | null): number | null {
  if (value === null) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) refuse("The SAML Response has an invalid timestamp.");
  return time;
}

function attributeValue(assertion: Element, name: string): string | null {
  for (const statement of childElements(assertion, SAML_NS, "AttributeStatement")) {
    for (const attribute of childElements(statement, SAML_NS, "Attribute")) {
      if (attribute.getAttribute("Name") !== name) continue;
      const value = childElement(attribute, SAML_NS, "AttributeValue")?.textContent?.trim();
      if (value) return value;
    }
  }
  return null;
}

export interface ValidatedAssertion {
  assertionId: string;
  nameId: string;
  /** Null for an identity-provider-initiated response. */
  inResponseTo: string | null;
  expiresAt: number;
  email: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
}

/**
 * Validates a SAML response against Slack's documented requirements for a workspace. Every value
 * used comes from an element a valid signature by the configured certificate covers.
 */
export function validateSamlResponse(
  samlResponse: string,
  baseUrl: string,
  team: SlackTeam,
  config: SlackSamlConfig,
): ValidatedAssertion {
  const xml = Buffer.from(samlResponse, "base64").toString("utf8");
  const doc = parseXml(xml);
  const root = doc.documentElement;
  if (!root || root.namespaceURI !== SAMLP_NS || root.localName !== "Response") {
    throw new SamlResponseError("The SAML Response is not a SAML 2.0 Response.", 400);
  }
  if (root.getAttribute("Version") !== "2.0") throw new SamlResponseError(SAML_ERRORS.version, 400);
  if (!hasUniqueIds(doc)) refuse(SAML_ERRORS.signature);

  const acsUrl = samlAcsUrl(baseUrl);
  const signedResponse = verifiedSignedElement(xml, root, config.public_certificate);

  if (doc.getElementsByTagNameNS(SAML_NS, "EncryptedAssertion").length > 0) {
    refuse(signedResponse ? "Encrypted assertions are not supported by the emulator." : SAML_ERRORS.encrypted);
  }
  const rootAssertions = childElements(root, SAML_NS, "Assertion");
  if (doc.getElementsByTagNameNS(SAML_NS, "Assertion").length !== 1 || rootAssertions.length !== 1) {
    refuse("The SAML Response must contain a single assertion.");
  }

  const signedAssertion = verifiedSignedElement(xml, rootAssertions[0], config.public_certificate);
  if (!signedResponse && !signedAssertion) refuse(SAML_ERRORS.neitherSigned);
  if (config.responses_signed && !signedResponse) refuse(SAML_ERRORS.responseNotSigned);
  if (config.assertions_signed && !signedAssertion) refuse(SAML_ERRORS.assertionNotSigned);

  const response = signedResponse ?? root;
  let assertion: Element;
  if (signedAssertion) {
    assertion = signedAssertion;
  } else {
    const inner = childElements(signedResponse!, SAML_NS, "Assertion");
    if (inner.length !== 1) refuse("The SAML Response must contain a single assertion.");
    assertion = inner[0];
  }
  if (assertion.getAttribute("Version") !== "2.0") throw new SamlResponseError(SAML_ERRORS.version, 400);

  // A signed message names its Destination (SAML 2.0 Bindings, 3.5.5.2); when present it must be the ACS URL.
  const destination = response.getAttribute("Destination");
  if ((signedResponse && !destination) || (destination && destination !== acsUrl)) {
    refuse(SAML_ERRORS.destination(acsUrl));
  }

  const statusCode = childElement(childElement(response, SAMLP_NS, "Status"), SAMLP_NS, "StatusCode");
  if (statusCode?.getAttribute("Value") !== STATUS_SUCCESS) {
    refuse("The identity provider did not authenticate the user.");
  }

  const assertionIssuer = childElement(assertion, SAML_NS, "Issuer")?.textContent?.trim();
  const responseIssuer = childElement(response, SAML_NS, "Issuer")?.textContent?.trim();
  if (assertionIssuer !== config.idp_issuer || (responseIssuer !== undefined && responseIssuer !== config.idp_issuer)) {
    refuse(SAML_ERRORS.issuer);
  }

  const subject = childElement(assertion, SAML_NS, "Subject");
  const nameIdElement = childElement(subject, SAML_NS, "NameID");
  const nameId = nameIdElement?.textContent?.trim();
  if (!nameIdElement || !nameId || nameIdElement.getAttribute("Format") !== PERSISTENT_NAME_ID) {
    refuse(SAML_ERRORS.nameId);
  }
  // NameQualifier and SPNameQualifier are optional; when sent they must be the documented values.
  const nameQualifier = nameIdElement.getAttribute("NameQualifier");
  if (nameQualifier && nameQualifier.toLowerCase() !== `${team.domain}.slack.com`.toLowerCase()) {
    refuse(`The NameQualifier of the NameID must be ${team.domain}.slack.com.`);
  }
  const spNameQualifier = nameIdElement.getAttribute("SPNameQualifier");
  if (spNameQualifier && spNameQualifier !== SLACK_SP_ISSUER) {
    refuse(`The SPNameQualifier of the NameID must be ${SLACK_SP_ISSUER}.`);
  }

  const now = Date.now();
  // Bearer subject confirmation (SAML 2.0 Profiles, 4.1.4.2): it MUST carry the ACS URL as Recipient and a
  // NotOnOrAfter that limits the window during which the assertion can be delivered.
  const confirmationData = childElement(
    childElement(subject, SAML_NS, "SubjectConfirmation"),
    SAML_NS,
    "SubjectConfirmationData",
  );
  if (confirmationData?.getAttribute("Recipient") !== acsUrl) {
    refuse(`The SAML Response does not contain the correct Recipient, which should be ${acsUrl}.`);
  }
  const confirmationNotOnOrAfter = parseInstant(confirmationData.getAttribute("NotOnOrAfter"));
  if (confirmationNotOnOrAfter === null) {
    refuse("The SAML Response does not limit when it can be delivered: SubjectConfirmationData has no NotOnOrAfter.");
  }
  if (now >= confirmationNotOnOrAfter) refuse("The SAML Response has expired.");

  const conditions = childElement(assertion, SAML_NS, "Conditions");
  const notBefore = parseInstant(conditions?.getAttribute("NotBefore") ?? null);
  if (notBefore !== null && now < notBefore) refuse("The SAML Response is not valid yet.");
  const notOnOrAfter = parseInstant(conditions?.getAttribute("NotOnOrAfter") ?? null);
  if (notOnOrAfter !== null && now >= notOnOrAfter) refuse("The SAML Response has expired.");

  const restrictions = conditions ? childElements(conditions, SAML_NS, "AudienceRestriction") : [];
  const audienceValid =
    restrictions.length > 0 &&
    restrictions.every((restriction) =>
      childElements(restriction, SAML_NS, "Audience").some(
        (audience) => audience.textContent?.trim() === SLACK_SP_ISSUER,
      ),
    );
  if (!audienceValid) refuse(SAML_ERRORS.audience);

  // Only a signed element can name the request: the assertion's SubjectConfirmationData, or the
  // Response itself when it is signed. Without one, the response is identity provider initiated.
  const confirmationInResponseTo = confirmationData.getAttribute("InResponseTo") || null;
  const responseInResponseTo = root.getAttribute("InResponseTo") || null;
  const signedResponseInResponseTo = signedResponse ? responseInResponseTo : null;
  if (
    confirmationInResponseTo !== null &&
    responseInResponseTo !== null &&
    confirmationInResponseTo !== responseInResponseTo
  ) {
    refuse("The SAML Response does not answer a sign-in request from Slack.");
  }
  const inResponseTo = confirmationInResponseTo ?? signedResponseInResponseTo;
  if (inResponseTo === null && responseInResponseTo !== null) {
    refuse("The SAML Response does not answer a sign-in request from Slack.");
  }

  const email = attributeValue(assertion, "User.Email");
  if (!email) refuse("The SAML Response is missing the User.Email attribute. Please check your IDP settings.");

  const assertionId = assertion.getAttribute("ID") ?? "";
  return {
    assertionId,
    nameId,
    inResponseTo,
    expiresAt: Math.min(confirmationNotOnOrAfter, notOnOrAfter ?? Infinity),
    email,
    username: attributeValue(assertion, "User.Username"),
    firstName: attributeValue(assertion, "first_name"),
    lastName: attributeValue(assertion, "last_name"),
  };
}

/** Refuses an assertion already used (SAML 2.0 Profiles, 4.1.4.5: bearer assertions are not replayed). */
export function consumeAssertionId(store: Store, assertion: ValidatedAssertion): void {
  const used = dataMap<number>(store, "slack.saml.usedAssertions");
  const now = Date.now();
  for (const [id, expiresAt] of used) if (expiresAt <= now) used.delete(id);
  if (used.has(assertion.assertionId)) refuse("This SAML Response has already been used.");
  used.set(assertion.assertionId, assertion.expiresAt);
}

/**
 * The workspace member the assertion signs in. The persistent NameID is linked to the member with
 * the `User.Email` address on first sign-in; an unknown address creates the member (Just In Time
 * provisioning).
 */
export function resolveSamlMember(store: Store, team: SlackTeam, assertion: ValidatedAssertion): SlackUser {
  const ss = getSlackStore(store);
  const identities = store.getData<Map<string, string>>("slack.saml.identities") ?? new Map<string, string>();
  store.setData("slack.saml.identities", identities);

  const linkedUserId = identities.get(assertion.nameId);
  let member: SlackUser | undefined;
  if (linkedUserId) {
    member = ss.users.findOneBy("user_id", linkedUserId);
  } else {
    const email = assertion.email.toLowerCase();
    member = ss.users.all().find((user) => !user.is_bot && user.email.toLowerCase() === email);
    if (member && [...identities.values()].includes(member.user_id)) {
      refuse("This Slack account is already linked to another identity of your identity provider.");
    }
    member ??= provisionMember(store, team, assertion);
    identities.set(assertion.nameId, member.user_id);
  }
  if (!member || member.deleted) refuse("This Slack account has been deactivated.");
  return member;
}

function provisionMember(store: Store, team: SlackTeam, assertion: ValidatedAssertion): SlackUser {
  const ss = getSlackStore(store);
  const name = assertion.username ?? assertion.email.split("@")[0];
  const realName = [assertion.firstName, assertion.lastName].filter(Boolean).join(" ") || name;
  return ss.users.insert({
    user_id: `U${randomBytes(5).toString("hex").toUpperCase()}`,
    team_id: team.team_id,
    name,
    real_name: realName,
    email: assertion.email,
    is_admin: false,
    is_bot: false,
    deleted: false,
    profile: {
      display_name: name,
      real_name: realName,
      email: assertion.email,
      image_48: "",
      image_192: "",
      ...(assertion.firstName ? { first_name: assertion.firstName } : {}),
      ...(assertion.lastName ? { last_name: assertion.lastName } : {}),
      real_name_normalized: realName,
      display_name_normalized: name,
      status_text: "",
      status_emoji: "",
      status_emoji_display_info: [],
      status_expiration: 0,
    },
    presence: "active",
    manual_presence: "auto",
    connection_count: 1,
    last_activity: Math.floor(Date.now() / 1000),
  });
}

/** Opens the browser's Slack web session for `member` and returns the cookie to set. */
export function openWebSession(store: Store, member: SlackUser, nameId: string): string {
  const sessionId = randomBytes(24).toString("hex");
  dataMap<SlackWebSession>(store, "slack.saml.sessions").set(sessionId, {
    session_id: sessionId,
    user_id: member.user_id,
    name_id: nameId,
    created_at: Date.now(),
  });
  return `${SLACK_SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax`;
}

/** The active member signed in by this browser's Slack web session, if any. */
export function getWebSessionMember(store: Store, c: Context): SlackUser | null {
  const sessionId = parseCookies(c.req.header("Cookie") ?? "")[SLACK_SESSION_COOKIE];
  if (!sessionId) return null;
  const session = dataMap<SlackWebSession>(store, "slack.saml.sessions").get(sessionId);
  if (!session) return null;
  const member = getSlackStore(store).users.findOneBy("user_id", session.user_id);
  return member && !member.deleted ? member : null;
}

export function isGuest(user: SlackUser): boolean {
  return Boolean(user.is_restricted || user.is_ultra_restricted);
}

/**
 * Whether `user` may sign in without SSO: everyone when SSO is optional, Workspace Owners always
 * (the documented bypass), and guests when SSO is required for all members excluding guests.
 */
export function canSignInWithoutSso(config: SlackSamlConfig, user: SlackUser): boolean {
  if (config.sso_requirement === "optional") return true;
  if (user.is_owner) return true;
  return config.sso_requirement === "required_except_guests" && isGuest(user);
}
