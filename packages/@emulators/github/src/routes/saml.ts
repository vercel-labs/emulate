import type { RouteContext } from "@emulators/core";
import { renderErrorPage, renderFormPostPage } from "@emulators/core";
import { getGitHubStore } from "../store.js";
import { getBrowserSession, renderSignInPicker } from "./oauth.js";
import {
  SamlResponseError,
  createAuthnRequest,
  getOrgSamlConfig,
  linkSamlIdentity,
  openSamlSession,
  renderSpMetadata,
  takePendingAuthnRequest,
  validateSamlResponse,
} from "../saml.js";

const SERVICE_LABEL = "GitHub";

/** A path on this host, so that a redirect after sign-in cannot leave the emulator. */
function localPath(value: string | undefined): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return null;
  return value;
}

export function samlRoutes({ app, store, baseUrl }: RouteContext): void {
  const gh = getGitHubStore(store);

  function findSamlOrg(login: string) {
    const org = gh.orgs.findOneBy("login", login);
    if (!org) return null;
    const config = getOrgSamlConfig(store, org.id);
    if (!config) return null;
    return { org, config };
  }

  function notConfigured() {
    return renderErrorPage("Not Found", "This organization does not use SAML single sign-on.", SERVICE_LABEL);
  }

  app.get("/orgs/:org/saml/metadata", (c) => {
    const found = findSamlOrg(c.req.param("org"));
    if (!found) return c.html(notConfigured(), 404);
    c.header("Content-Type", "application/xml; charset=utf-8");
    return c.body(renderSpMetadata(baseUrl, found.org), 200);
  });

  app.get("/orgs/:org/sso", (c) => {
    const found = findSamlOrg(c.req.param("org"));
    if (!found) return c.html(notConfigured(), 404);
    const { org, config } = found;
    const returnTo = localPath(c.req.query("return_to"));

    const session = getBrowserSession(store, c);
    if (!session || !gh.users.findOneBy("login", session.login)) {
      const ssoUrl = `${baseUrl}/orgs/${org.login}/sso${returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : ""}`;
      return c.html(
        renderSignInPicker(store, baseUrl, `Sign in to your personal account to continue to ${org.login}.`, {
          redirect_uri: ssoUrl,
          scope: "",
          state: "",
          client_id: "",
        }),
      );
    }

    const request = createAuthnRequest(store, baseUrl, org, config, session.sessionId);
    const fields: Record<string, string> = { SAMLRequest: Buffer.from(request.xml, "utf8").toString("base64") };
    if (returnTo) fields.RelayState = returnTo;
    return c.html(renderFormPostPage(config.sign_on_url, fields, SERVICE_LABEL));
  });

  app.post("/orgs/:org/saml/consume", async (c) => {
    const found = findSamlOrg(c.req.param("org"));
    if (!found) return c.html(notConfigured(), 404);
    const { org, config } = found;

    const body = (await c.req.parseBody()) as Record<string, string>;
    const samlResponse = typeof body.SAMLResponse === "string" ? body.SAMLResponse : "";
    if (!samlResponse) {
      return c.html(renderErrorPage("Bad Request", "The SAMLResponse parameter is missing.", SERVICE_LABEL), 400);
    }

    const session = getBrowserSession(store, c);
    const user = session ? gh.users.findOneBy("login", session.login) : undefined;
    if (!session || !user) {
      return c.html(
        renderErrorPage(
          "SAML sign-in failed",
          "Sign in to your personal account before you sign in with your identity provider.",
          SERVICE_LABEL,
        ),
        403,
      );
    }

    try {
      const assertion = validateSamlResponse(samlResponse, baseUrl, org, config);
      if (!takePendingAuthnRequest(store, assertion.inResponseTo, session.sessionId, org.id)) {
        throw new SamlResponseError("The SAML response does not answer a sign-in request from this browser.", 403);
      }
      linkSamlIdentity(store, org.id, user.id, assertion.nameId);
      openSamlSession(store, session.sessionId, org.id, user.id, assertion.nameId, assertion.sessionNotOnOrAfter);
    } catch (error) {
      if (error instanceof SamlResponseError) {
        return c.html(renderErrorPage("SAML sign-in failed", error.message, SERVICE_LABEL), error.status);
      }
      throw error;
    }

    const relayState = typeof body.RelayState === "string" ? localPath(body.RelayState) : null;
    return c.redirect(relayState ?? `/orgs/${org.login}`, 302);
  });
}
