import type { RouteContext } from "@emulators/core";
import { escapeHtml, renderCardPage, renderErrorPage, renderFormPostPage, renderUserButton } from "@emulators/core";
import { getGitHubStore } from "../store.js";
import { getBrowserSession, renderSignInPicker } from "./oauth.js";
import {
  SamlResponseError,
  createAuthnRequest,
  createPendingRelink,
  getOrgSamlConfig,
  linkSamlIdentity,
  openSamlSession,
  relinkSamlIdentity,
  renderSpMetadata,
  takePendingAuthnRequest,
  takePendingRelink,
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

    const relayState = typeof body.RelayState === "string" ? localPath(body.RelayState) : null;

    try {
      const assertion = validateSamlResponse(samlResponse, baseUrl, org, config);
      if (!takePendingAuthnRequest(store, assertion.inResponseTo, session.sessionId, org.id)) {
        throw new SamlResponseError("The SAML response does not answer a sign-in request from this browser.", 403);
      }
      if (linkSamlIdentity(store, org.id, user.id, assertion.nameId) === "relink") {
        const token = createPendingRelink(store, {
          session_id: session.sessionId,
          org_id: org.id,
          user_id: user.id,
          name_id: assertion.nameId,
          session_not_on_or_after: assertion.sessionNotOnOrAfter,
          relay_state: relayState,
        });
        return c.html(renderRelinkWarning(org.login, user.login, assertion.nameId, token));
      }
      openSamlSession(store, session.sessionId, org.id, user.id, assertion.nameId, assertion.sessionNotOnOrAfter);
    } catch (error) {
      if (error instanceof SamlResponseError) {
        return c.html(renderErrorPage("SAML sign-in failed", error.message, SERVICE_LABEL), error.status);
      }
      throw error;
    }

    return c.redirect(relayState ?? `/orgs/${org.login}`, 302);
  });

  // GitHub warns before it relinks an account to another external identity, and relinks only if the
  // user continues.
  function renderRelinkWarning(orgLogin: string, login: string, nameId: string, token: string): string {
    const subtitle =
      `The external identity <strong>${escapeHtml(nameId)}</strong> does not match the external identity ` +
      `linked to your account in ${escapeHtml(orgLogin)}. You are about to relink your account. ` +
      "As your external identity is used to govern access and team membership, continuing with the new external " +
      "identity can cause you to lose access to teams and organizations. Only continue if you know that you're " +
      "supposed to use that new external identity for authentication in the future.";
    const button = renderUserButton({
      letter: (login[0] ?? "?").toUpperCase(),
      login,
      name: `Continue and relink to ${nameId}`,
      formAction: `/orgs/${orgLogin}/saml/relink`,
      hiddenFields: { relink_token: token },
    });
    return renderCardPage("Relink your account?", subtitle, button, SERVICE_LABEL);
  }

  app.post("/orgs/:org/saml/relink", async (c) => {
    const found = findSamlOrg(c.req.param("org"));
    if (!found) return c.html(notConfigured(), 404);
    const { org } = found;

    const body = (await c.req.parseBody()) as Record<string, string>;
    const token = typeof body.relink_token === "string" ? body.relink_token : "";
    const session = getBrowserSession(store, c);
    const relink = session && token ? takePendingRelink(store, token, session.sessionId, org.id) : null;
    const user = relink ? gh.users.get(relink.user_id) : undefined;
    if (!session || !relink || !user || user.login !== session.login) {
      return c.html(
        renderErrorPage("SAML sign-in failed", "This relink request is not valid for this browser.", SERVICE_LABEL),
        403,
      );
    }

    try {
      relinkSamlIdentity(store, org.id, user.id, relink.name_id);
    } catch (error) {
      if (error instanceof SamlResponseError) {
        return c.html(renderErrorPage("SAML sign-in failed", error.message, SERVICE_LABEL), error.status);
      }
      throw error;
    }
    openSamlSession(store, session.sessionId, org.id, user.id, relink.name_id, relink.session_not_on_or_after);
    return c.redirect(relink.relay_state ?? `/orgs/${org.login}`, 302);
  });
}
