import { randomBytes } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { DOMParser } from "@xmldom/xmldom";
import type { Context } from "@emulators/core";
import type { AppEnv, RouteContext } from "@emulators/core";
import {
  bodyStr,
  debug,
  escapeHtml,
  renderCardPage,
  renderErrorPage,
  renderFormPostPage,
  renderUserButton,
} from "@emulators/core";
import type { OktaApp } from "../entities.js";
import { SAML_2_0_SIGN_ON_MODE, userDisplayName } from "../helpers.js";
import { findAppByRef, findUserByRef, oktaError, requireManagementAuth } from "../route-helpers.js";
import {
  SAML_AUTHN_CONTEXT_PASSWORD_PROTECTED_TRANSPORT,
  SAML_DIGEST_ALGORITHMS,
  SAML_NAMEID_FORMATS,
  SAML_SIGNATURE_ALGORITHMS,
} from "../saml-constants.js";
import { getSamlSigningMaterial } from "../saml-crypto.js";
import { buildMetadataXml, buildSamlResponse, signAssertion, signResponse } from "../saml-xml.js";
import { getOktaStore } from "../store.js";

const SERVICE_LABEL = "Okta";

// Not documented by Okta; the same window as upstream PR #9.
const ASSERTION_VALIDITY_MS = 5 * 60 * 1000;

const NAMEID_FORMAT_VALUES = new Set<string>(Object.values(SAML_NAMEID_FORMATS));

type SamlSignOnSettings = {
  ssoAcsUrl: string;
  recipient: string;
  destination: string;
  audience: string;
  subjectNameIdFormat: string;
  responseSigned: boolean;
  assertionSigned: boolean;
  signatureAlgorithm: string;
  digestAlgorithm: string;
  authnContextClassRef: string;
};

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function resolveSignOnSettings(app: OktaApp): SamlSignOnSettings {
  const raw = app.settings.signOn;
  const signOn = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const ssoAcsUrl = str(signOn.ssoAcsUrl);
  const format = str(signOn.subjectNameIdFormat);
  const responseSigned = signOn.responseSigned === true;
  const assertionSigned = typeof signOn.assertionSigned === "boolean" ? signOn.assertionSigned : true;
  const signatureAlgorithm = signOn.signatureAlgorithm === "RSA_SHA1" ? "RSA_SHA1" : "RSA_SHA256";
  const digestAlgorithm = signOn.digestAlgorithm === "SHA1" ? "SHA1" : "SHA256";

  return {
    ssoAcsUrl,
    recipient: str(signOn.recipient) || ssoAcsUrl,
    destination: str(signOn.destination) || ssoAcsUrl,
    audience: str(signOn.audience),
    subjectNameIdFormat: NAMEID_FORMAT_VALUES.has(format) ? format : SAML_NAMEID_FORMATS.unspecified,
    responseSigned,
    // Okta requires at least one of the two to be true; sign the assertion when neither is set.
    assertionSigned: assertionSigned || !responseSigned,
    signatureAlgorithm: SAML_SIGNATURE_ALGORITHMS[signatureAlgorithm],
    digestAlgorithm: SAML_DIGEST_ALGORITHMS[digestAlgorithm],
    authnContextClassRef: str(signOn.authnContextClassRef) || SAML_AUTHN_CONTEXT_PASSWORD_PROTECTED_TRANSPORT,
  };
}

function ssoPath(app: OktaApp): string {
  return `/app/${encodeURIComponent(app.name)}/${encodeURIComponent(app.external_key ?? "")}/sso/saml`;
}

function samlIssuer(app: OktaApp): string {
  return `http://www.okta.com/${app.external_key ?? ""}`;
}

/** Returns the AuthnRequest ID, or null when the request cannot be decoded. */
function parseAuthnRequestId(samlRequest: string, deflated: boolean): string | null {
  try {
    const decoded = Buffer.from(samlRequest, "base64");
    const xml = (deflated ? inflateRawSync(decoded) : decoded).toString("utf-8");
    const doc = new DOMParser({ onError: () => undefined }).parseFromString(xml, "text/xml");
    const root = doc.documentElement;
    if (!root || root.localName !== "AuthnRequest") return null;
    return root.getAttribute("ID") ?? "";
  } catch {
    return null;
  }
}

export function samlRoutes({ app, store, baseUrl, tokenMap }: RouteContext): void {
  const oktaStore = getOktaStore(store);

  const findSamlApp = (externalKey: string): OktaApp | undefined => {
    const decoded = decodeURIComponent(externalKey);
    return oktaStore.apps
      .all()
      .find((entry) => entry.sign_on_mode === SAML_2_0_SIGN_ON_MODE && entry.external_key === decoded);
  };

  const appNotFound = (c: Context<AppEnv>): Response =>
    c.html(renderErrorPage("App not found", "No SAML 2.0 app has this external key.", SERVICE_LABEL), 404);

  const metadataResponse = async (c: Context<AppEnv>, samlApp: OktaApp): Promise<Response> => {
    const { certBase64 } = await getSamlSigningMaterial(store);
    const xml = buildMetadataXml(samlIssuer(samlApp), `${baseUrl}${ssoPath(samlApp)}`, certBase64);
    return c.text(xml, 200, { "Content-Type": "text/xml; charset=UTF-8" });
  };

  app.get("/app/:externalKey/sso/saml/metadata", async (c) => {
    const samlApp = findSamlApp(c.req.param("externalKey"));
    if (!samlApp) return appNotFound(c);
    return metadataResponse(c, samlApp);
  });

  app.get("/api/v1/apps/:appId/sso/saml/metadata", async (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;

    const appEntity = findAppByRef(oktaStore, c.req.param("appId"));
    if (!appEntity || appEntity.sign_on_mode !== SAML_2_0_SIGN_ON_MODE || !appEntity.external_key) {
      return oktaError(c, 404, "E0000007", "Not found: app");
    }
    return metadataResponse(c, appEntity);
  });

  const renderPicker = (
    c: Context<AppEnv>,
    samlApp: OktaApp,
    samlRequest: string,
    relayState: string,
    deflated: boolean,
  ): Response => {
    let requestId = "";
    if (samlRequest) {
      const parsed = parseAuthnRequestId(samlRequest, deflated);
      if (parsed === null) {
        return c.html(
          renderErrorPage("Invalid SAMLRequest", "The SAMLRequest could not be decoded.", SERVICE_LABEL),
          400,
        );
      }
      requestId = parsed;
    }

    const users = oktaStore.users.all();
    const buttons = users
      .map((user) =>
        renderUserButton({
          letter: (user.login[0] ?? "?").toUpperCase(),
          login: user.login,
          name: userDisplayName(user),
          email: user.email,
          formAction: `${ssoPath(samlApp)}/callback`,
          hiddenFields: {
            user_ref: user.okta_id,
            in_response_to: requestId,
            relay_state: relayState,
          },
        }),
      )
      .join("\n");

    return c.html(
      renderCardPage(
        "Sign in with Okta",
        `Sign in to <strong>${escapeHtml(samlApp.label)}</strong> with your Okta account.`,
        users.length > 0 ? buttons : '<p class="empty">No users in the emulator store.</p>',
        SERVICE_LABEL,
      ),
    );
  };

  // HTTP-Redirect binding (SAMLRequest deflated and base64 encoded in the query) or IdP-initiated sign-in.
  app.get("/app/:appName/:externalKey/sso/saml", (c) => {
    const samlApp = findSamlApp(c.req.param("externalKey"));
    if (!samlApp) return appNotFound(c);
    return renderPicker(c, samlApp, c.req.query("SAMLRequest") ?? "", c.req.query("RelayState") ?? "", true);
  });

  // HTTP-POST binding (SAMLRequest base64 encoded in the form).
  app.post("/app/:appName/:externalKey/sso/saml", async (c) => {
    const samlApp = findSamlApp(c.req.param("externalKey"));
    if (!samlApp) return appNotFound(c);
    const body = await c.req.parseBody();
    return renderPicker(c, samlApp, bodyStr(body.SAMLRequest), bodyStr(body.RelayState), false);
  });

  app.post("/app/:appName/:externalKey/sso/saml/callback", async (c) => {
    const samlApp = findSamlApp(c.req.param("externalKey"));
    if (!samlApp) return appNotFound(c);

    const body = await c.req.parseBody();
    const inResponseTo = bodyStr(body.in_response_to);
    const relayState = bodyStr(body.relay_state);

    const user = findUserByRef(oktaStore, bodyStr(body.user_ref));
    if (!user) {
      return c.html(renderErrorPage("Unknown user", "The selected user is not available.", SERVICE_LABEL), 400);
    }

    if (user.status !== "ACTIVE") {
      return c.html(
        renderErrorPage(
          "User not active",
          `${user.login} cannot sign in because the user is ${user.status}.`,
          SERVICE_LABEL,
        ),
        403,
      );
    }

    const assigned = oktaStore.appAssignments
      .findBy("app_okta_id", samlApp.okta_id)
      .some((assignment) => assignment.user_okta_id === user.okta_id);
    if (!assigned) {
      return c.html(
        renderErrorPage(
          "App Not Assigned",
          `Sorry, you cannot access ${samlApp.label} because you are not assigned this app in Okta.`,
          SERVICE_LABEL,
        ),
        403,
      );
    }

    const settings = resolveSignOnSettings(samlApp);
    if (!settings.ssoAcsUrl) {
      return c.html(
        renderErrorPage("SAML app not configured", "The app has no single sign-on URL (ssoAcsUrl).", SERVICE_LABEL),
        400,
      );
    }

    const now = Date.now();
    const assertionId = `id${randomBytes(16).toString("hex")}`;
    let xml = buildSamlResponse({
      responseId: `id${randomBytes(16).toString("hex")}`,
      assertionId,
      issuer: samlIssuer(samlApp),
      destination: settings.destination,
      recipient: settings.recipient,
      audience: settings.audience,
      nameId: user.login,
      nameIdFormat: settings.subjectNameIdFormat,
      inResponseTo: inResponseTo || null,
      issueInstant: new Date(now).toISOString(),
      notBefore: new Date(now - ASSERTION_VALIDITY_MS).toISOString(),
      notOnOrAfter: new Date(now + ASSERTION_VALIDITY_MS).toISOString(),
      authnContextClassRef: settings.authnContextClassRef,
    });

    const { privateKeyPem, certBase64 } = await getSamlSigningMaterial(store);
    const signing = {
      privateKeyPem,
      certBase64,
      signatureAlgorithm: settings.signatureAlgorithm,
      digestAlgorithm: settings.digestAlgorithm,
    };
    if (settings.assertionSigned) xml = signAssertion(xml, signing);
    if (settings.responseSigned) xml = signResponse(xml, signing);

    const fields: Record<string, string> = { SAMLResponse: Buffer.from(xml).toString("base64") };
    if (relayState) fields.RelayState = relayState;

    debug("okta.saml", `[callback] assertion for ${user.login} app=${samlApp.okta_id} acs=${settings.ssoAcsUrl}`);

    return c.html(renderFormPostPage(settings.ssoAcsUrl, fields, SERVICE_LABEL));
  });
}
