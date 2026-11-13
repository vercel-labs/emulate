import type { Store } from "@emulators/core";
import {
  certificateMatchesKey,
  createSelfSignedCertificate,
  SAML_AUTHN_CONTEXT_PASSWORD_PROTECTED_TRANSPORT,
  SAML_NAMEID_FORMATS,
  type SamlAttribute,
  type SamlDigestAlgorithm,
  type SamlSignatureAlgorithm,
} from "@emulators/core/saml";
import type { OktaApp, OktaGroup, OktaUser } from "./entities.js";
import { generateOktaId, userDisplayName } from "./helpers.js";

export const SAML_2_0_SIGN_ON_MODE = "SAML_2_0";

export interface OktaSamlSigningKey {
  privateKeyPem: string;
  /** Base64 DER certificate, as it appears in metadata. */
  certificate: string;
}

const SIGNING_KEY_DATA = "okta.saml.signing_key";
let processSigningKey: OktaSamlSigningKey | undefined;

/**
 * The key Okta signs SAML responses with. Seed config can pin one so a service provider keeps trusting the same
 * certificate across restarts; otherwise one is generated per process and kept in the store, so persisted state
 * keeps working.
 */
export function getSamlSigningKey(store: Store): OktaSamlSigningKey {
  const existing = store.getData<OktaSamlSigningKey>(SIGNING_KEY_DATA);
  if (existing?.privateKeyPem && existing.certificate) return existing;
  const key = (processSigningKey ??= createSelfSignedCertificate("emulate-okta"));
  store.setData(SIGNING_KEY_DATA, key);
  return key;
}

export function setSamlSigningKey(store: Store, key: OktaSamlSigningKey): void {
  const certificate = key.certificate.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
  if (!certificateMatchesKey(certificate, key.privateKeyPem)) {
    throw new Error("Okta saml_signing_key: the certificate does not match the private key");
  }
  store.setData(SIGNING_KEY_DATA, { privateKeyPem: key.privateKeyPem, certificate });
}

export function isSamlApp(app: OktaApp): boolean {
  return app.sign_on_mode === SAML_2_0_SIGN_ON_MODE;
}

/** Okta gives every SAML 2.0 app an external key (`exk...`) used in its SSO URL, metadata URL and issuer. */
export function resolveExternalKey(signOnMode: string, current: string | undefined): string | undefined {
  if (current) return current;
  return signOnMode === SAML_2_0_SIGN_ON_MODE ? generateOktaId("exk") : undefined;
}

function signOnSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const signOn = settings.signOn;
  return signOn && typeof signOn === "object" ? (signOn as Record<string, unknown>) : {};
}

/**
 * Okta refuses a SAML 2.0 app that signs neither the response nor the assertion: "Either (or both) `responseSigned`
 * or `assertionSigned` must be `TRUE`."
 */
export function samlSettingsError(signOnMode: string, settings: Record<string, unknown>): string | undefined {
  if (signOnMode !== SAML_2_0_SIGN_ON_MODE) return undefined;
  const signOn = signOnSettings(settings);
  if (signOn.responseSigned === false && signOn.assertionSigned === false) {
    return "Either (or both) responseSigned or assertionSigned must be true.";
  }
  return undefined;
}

export interface ResolvedSamlSettings {
  ssoAcsUrl: string;
  recipient: string;
  destination: string;
  audience: string;
  idpIssuer: string;
  nameIdFormat: string;
  defaultRelayState: string;
  responseSigned: boolean;
  assertionSigned: boolean;
  signatureAlgorithm: SamlSignatureAlgorithm;
  digestAlgorithm: SamlDigestAlgorithm;
  authnContextClassRef: string;
  attributeStatements: unknown[];
}

const NAMEID_FORMATS = new Set<string>(Object.values(SAML_NAMEID_FORMATS));

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function samlIssuer(app: OktaApp): string {
  return `http://www.okta.com/${app.external_key ?? ""}`;
}

export function resolveSamlSettings(app: OktaApp): ResolvedSamlSettings {
  const signOn = signOnSettings(app.settings);
  const ssoAcsUrl = str(signOn.ssoAcsUrl);
  const format = str(signOn.subjectNameIdFormat);
  const responseSigned = signOn.responseSigned === true;
  return {
    ssoAcsUrl,
    recipient: str(signOn.recipient) || ssoAcsUrl,
    destination: str(signOn.destination) || ssoAcsUrl,
    audience: str(signOn.audience),
    // `idpIssuer` is usually the template "http://www.okta.com/${org.externalKey}"; only a literal value overrides.
    idpIssuer: str(signOn.idpIssuer) && !str(signOn.idpIssuer).includes("${") ? str(signOn.idpIssuer) : samlIssuer(app),
    nameIdFormat: NAMEID_FORMATS.has(format) ? format : SAML_NAMEID_FORMATS.unspecified,
    defaultRelayState: str(signOn.defaultRelayState),
    responseSigned,
    // An app created without either flag still signs its assertion, the Okta default.
    assertionSigned: signOn.assertionSigned !== false || !responseSigned,
    signatureAlgorithm: signOn.signatureAlgorithm === "RSA_SHA1" ? "RSA_SHA1" : "RSA_SHA256",
    digestAlgorithm: signOn.digestAlgorithm === "SHA1" ? "SHA1" : "SHA256",
    authnContextClassRef: str(signOn.authnContextClassRef) || SAML_AUTHN_CONTEXT_PASSWORD_PROTECTED_TRANSPORT,
    attributeStatements: Array.isArray(signOn.attributeStatements) ? signOn.attributeStatements : [],
  };
}

function profileValue(user: OktaUser, field: string): string | undefined {
  switch (field) {
    case "login":
    case "userName":
      return user.login;
    case "email":
      return user.email;
    case "firstName":
      return user.first_name;
    case "lastName":
      return user.last_name;
    case "displayName":
      return userDisplayName(user);
    case "locale":
      return user.locale;
    case "timeZone":
      return user.time_zone;
    case "id":
      return user.okta_id;
    default:
      return undefined;
  }
}

/**
 * The app username, which Okta sends as the NameID. `credentials.userNameTemplate` defaults to
 * `${source.login}`; `${source.<field>}` and `${user.<field>}` templates for the profile fields are supported.
 */
export function samlNameId(app: OktaApp, user: OktaUser): string {
  const template = (app.credentials.userNameTemplate as { template?: unknown } | undefined)?.template;
  const match = typeof template === "string" ? /^\$\{(?:source|user)\.(\w+)\}$/.exec(template) : null;
  return (match && profileValue(user, match[1]!)) || user.login;
}

/**
 * Attribute statements from `settings.signOn.attributeStatements`. EXPRESSION values of the form `user.<field>` read
 * the user's profile and any other value is sent as written; GROUP statements send the names of the user's groups
 * that match `filterType` and `filterValue`.
 */
export function samlAttributes(statements: unknown[], user: OktaUser, groups: OktaGroup[]): SamlAttribute[] {
  const attributes: SamlAttribute[] = [];
  for (const raw of statements) {
    if (!raw || typeof raw !== "object") continue;
    const statement = raw as Record<string, unknown>;
    const name = str(statement.name);
    if (!name) continue;
    const nameFormat = str(statement.namespace) || undefined;

    if (statement.type === "GROUP") {
      const filterValue = str(statement.filterValue);
      const matches = (group: string): boolean => {
        switch (statement.filterType) {
          case "STARTS_WITH":
            return group.startsWith(filterValue);
          case "EQUALS":
            return group === filterValue;
          case "CONTAINS":
            return group.includes(filterValue);
          case "REGEX":
            try {
              return new RegExp(`^(?:${filterValue})$`).test(group);
            } catch {
              return false;
            }
          default:
            return false;
        }
      };
      attributes.push({ name, nameFormat, values: groups.map((group) => group.name).filter(matches) });
      continue;
    }

    const values = Array.isArray(statement.values) ? statement.values.filter((v) => typeof v === "string") : [];
    attributes.push({
      name,
      nameFormat,
      values: (values as string[]).map((value) => {
        const match = /^user\.(\w+)$/.exec(value.trim());
        return match ? (profileValue(user, match[1]!) ?? "") : value;
      }),
    });
  }
  return attributes;
}
