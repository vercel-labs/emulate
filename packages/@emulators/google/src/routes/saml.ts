import type { RouteContext } from "@emulators/core";
import { bodyStr, renderErrorPage, renderFormPostPage } from "@emulators/core";
import {
  SamlResponseError,
  consumeAssertionId,
  getSsoBrowserId,
  getSsoProfile,
  openWebSession,
  samlAcsUrl,
  takePendingAuthnRequest,
  validateSamlResponse,
} from "../saml.js";

const SERVICE_LABEL = "Google";
/** Marks the ACS post the emulator sends again from its own origin. */
const REPOSTED_FIELD = "_emu_reposted";

export function samlRoutes({ app, store, baseUrl }: RouteContext): void {
  // The SSO profile's ACS URL. Google implements the SAML 2.0 HTTP POST binding.
  app.post("/samlrp/:id/acs", async (c) => {
    const profile = getSsoProfile(store, c.req.param("id"));
    if (!profile) {
      return c.html(renderErrorPage("Not Found", "There is no SSO profile with this ID.", SERVICE_LABEL), 404);
    }

    const body = await c.req.parseBody();
    const samlResponse = bodyStr(body.SAMLResponse);
    if (!samlResponse) {
      return c.html(
        renderErrorPage("SAML sign-in failed", "The SAMLResponse parameter is missing.", SERVICE_LABEL),
        400,
      );
    }

    // The response is bound to the browser that started the sign-in by its SameSite=Lax cookie, which
    // a cross-site post from the identity provider does not carry: post it again from this origin once.
    const browserId = getSsoBrowserId(c);
    if (!browserId && bodyStr(body[REPOSTED_FIELD]) !== "1") {
      const fields: Record<string, string> = { SAMLResponse: samlResponse, [REPOSTED_FIELD]: "1" };
      const relayState = bodyStr(body.RelayState);
      if (relayState) fields.RelayState = relayState;
      return c.html(renderFormPostPage(samlAcsUrl(baseUrl, profile), fields, SERVICE_LABEL));
    }

    try {
      const assertion = validateSamlResponse(store, samlResponse, baseUrl, profile);
      const request = takePendingAuthnRequest(store, profile, assertion, browserId, bodyStr(body.RelayState));
      consumeAssertionId(store, assertion);
      c.header("Set-Cookie", openWebSession(store, assertion.user, profile));
      return c.redirect(request.continue_url, 302);
    } catch (error) {
      if (error instanceof SamlResponseError) {
        return c.html(renderErrorPage("SAML sign-in failed", error.message, SERVICE_LABEL), error.status);
      }
      throw error;
    }
  });
}
