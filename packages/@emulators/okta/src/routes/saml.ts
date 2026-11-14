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
import { buildIdpMetadata, buildSamlResponse, parseAuthnRequest, signSamlResponse } from "@emulators/core/saml";
import type { OktaApp } from "../entities.js";
import { userDisplayName } from "../helpers.js";
import { findAppByRef, findUserByRef, oktaError, requireManagementAuth } from "../route-helpers.js";
import { getSamlSigningKey, isSamlApp, resolveSamlSettings, samlAttributes, samlNameId } from "../saml.js";
import { getOktaStore } from "../store.js";

const SERVICE_LABEL = "Okta";

// SAML 2.0 app integrations: https://help.okta.com/en-us/content/topics/apps/aiw-saml-reference.htm
// Metadata and settings.signOn: https://developer.okta.com/docs/api/openapi/okta-management/management/tag/ApplicationSSO/
export function samlRoutes({ app, store, baseUrl, tokenMap }: RouteContext): void {
  const oktaStore = getOktaStore(store);

  const findByExternalKey = (externalKey: string): OktaApp | undefined => {
    const key = decodeURIComponent(externalKey);
    return oktaStore.apps.all().find((entry) => isSamlApp(entry) && entry.external_key === key);
  };

  const ssoPath = (samlApp: OktaApp): string =>
    `/app/${encodeURIComponent(samlApp.name)}/${encodeURIComponent(samlApp.external_key ?? "")}/sso/saml`;

  const notFound = (c: Context<AppEnv>): Response =>
    c.html(renderErrorPage("App not found", "No active SAML 2.0 app has this URL.", SERVICE_LABEL), 404);

  const metadata = (c: Context<AppEnv>, samlApp: OktaApp): Response => {
    const xml = buildIdpMetadata({
      entityId: resolveSamlSettings(samlApp).idpIssuer,
      ssoUrl: `${baseUrl}${ssoPath(samlApp)}`,
      certificate: getSamlSigningKey(store).certificate,
    });
    return c.body(xml, 200, { "Content-Type": "text/xml;charset=utf-8" });
  };

  // The metadata URL shown on the app's Sign On tab.
  app.get("/app/:externalKey/sso/saml/metadata", (c) => {
    const samlApp = findByExternalKey(c.req.param("externalKey"));
    if (!samlApp) return notFound(c);
    return metadata(c, samlApp);
  });

  app.get("/api/v1/apps/:appId/sso/saml/metadata", (c) => {
    const auth = requireManagementAuth(c, tokenMap);
    if (auth instanceof Response) return auth;
    const samlApp = findAppByRef(oktaStore, c.req.param("appId"));
    if (!samlApp || !isSamlApp(samlApp) || !samlApp.external_key) {
      return oktaError(c, 404, "E0000007", "Not found: Resource not found");
    }
    return metadata(c, samlApp);
  });

  // A deactivated app integration refuses sign-in: https://help.okta.com/en-us/content/topics/apps/apps-deactivate.htm
  const findActive = (c: Context<AppEnv>): OktaApp | undefined => {
    const samlApp = findByExternalKey(c.req.param("externalKey") ?? "");
    if (!samlApp || samlApp.status !== "ACTIVE" || samlApp.name !== decodeURIComponent(c.req.param("appName") ?? "")) {
      return undefined;
    }
    return samlApp;
  };

  const signInPage = (
    c: Context<AppEnv>,
    samlApp: OktaApp,
    samlRequest: string,
    relayState: string,
    binding: "redirect" | "post",
  ) => {
    let requestId = "";
    if (samlRequest) {
      const request = parseAuthnRequest(samlRequest, binding);
      if (!request) {
        return c.html(
          renderErrorPage("Invalid SAML request", "The SAMLRequest could not be decoded.", SERVICE_LABEL),
          400,
        );
      }
      requestId = request.id;
    } else if (!relayState) {
      // IdP-initiated sign-in starts at the app's default relay state.
      relayState = resolveSamlSettings(samlApp).defaultRelayState;
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
          hiddenFields: { user_ref: user.okta_id, in_response_to: requestId, relay_state: relayState },
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

  // The SSO URL takes an SP-initiated AuthnRequest through the HTTP-Redirect or HTTP-POST binding; without one it
  // is IdP-initiated sign-in.
  app.get("/app/:appName/:externalKey/sso/saml", (c) => {
    const samlApp = findActive(c);
    if (!samlApp) return notFound(c);
    return signInPage(c, samlApp, c.req.query("SAMLRequest") ?? "", c.req.query("RelayState") ?? "", "redirect");
  });

  app.post("/app/:appName/:externalKey/sso/saml", async (c) => {
    const samlApp = findActive(c);
    if (!samlApp) return notFound(c);
    const body = await c.req.parseBody();
    return signInPage(c, samlApp, bodyStr(body.SAMLRequest), bodyStr(body.RelayState), "post");
  });

  app.post("/app/:appName/:externalKey/sso/saml/callback", async (c) => {
    const samlApp = findActive(c);
    if (!samlApp) return notFound(c);

    const body = await c.req.parseBody();
    const user = findUserByRef(oktaStore, bodyStr(body.user_ref));
    if (!user) {
      return c.html(renderErrorPage("Unknown user", "The selected user is not available.", SERVICE_LABEL), 400);
    }
    if (user.status !== "ACTIVE") {
      return c.html(renderErrorPage("User not active", "The selected user cannot sign in.", SERVICE_LABEL), 400);
    }

    // https://support.okta.com/help/s/article/App-Sign-on-Error-403-User-attempted-unauthorized-access-to-app
    const assigned = oktaStore.appAssignments
      .findBy("app_okta_id", samlApp.okta_id)
      .some((assignment) => assignment.user_okta_id === user.okta_id);
    if (!assigned) {
      return c.html(
        renderErrorPage(
          "App Not Assigned",
          `Sorry, you can't access ${samlApp.label} because you are not assigned this app in Okta.`,
          SERVICE_LABEL,
        ),
        403,
      );
    }

    const settings = resolveSamlSettings(samlApp);
    if (!settings.ssoAcsUrl) {
      return c.html(
        renderErrorPage("SAML app not configured", "The app has no single sign-on URL (ssoAcsUrl).", SERVICE_LABEL),
        400,
      );
    }

    const groups = oktaStore.groupMemberships
      .findBy("user_okta_id", user.okta_id)
      .map((membership) => oktaStore.groups.findOneBy("okta_id", membership.group_okta_id))
      .filter((group): group is NonNullable<typeof group> => Boolean(group));
    const { xml } = buildSamlResponse({
      issuer: settings.idpIssuer,
      destination: settings.destination,
      recipient: settings.recipient,
      audience: settings.audience,
      nameId: samlNameId(samlApp, user),
      nameIdFormat: settings.nameIdFormat,
      inResponseTo: bodyStr(body.in_response_to) || null,
      attributes: samlAttributes(settings.attributeStatements, user, groups),
      authnContextClassRef: settings.authnContextClassRef,
    });
    const key = getSamlSigningKey(store);
    const signed = signSamlResponse(xml, {
      privateKeyPem: key.privateKeyPem,
      certificate: key.certificate,
      signAssertion: settings.assertionSigned,
      signResponse: settings.responseSigned,
      signatureAlgorithm: settings.signatureAlgorithm,
      digestAlgorithm: settings.digestAlgorithm,
    });

    debug("okta.saml", `[sso] ${user.login} -> ${samlApp.name} (${settings.ssoAcsUrl})`);

    const fields: Record<string, string> = { SAMLResponse: Buffer.from(signed, "utf-8").toString("base64") };
    const relayState = bodyStr(body.relay_state);
    if (relayState) fields.RelayState = relayState;
    return c.html(renderFormPostPage(settings.ssoAcsUrl, fields, SERVICE_LABEL));
  });
}
