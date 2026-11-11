import type { RouteContext } from "@emulators/core";
import { bodyStr, renderErrorPage } from "@emulators/core";
import {
  SamlResponseError,
  consumeAssertionId,
  getSsoProfile,
  openWebSession,
  takePendingAuthnRequest,
  validateSamlResponse,
} from "../saml.js";

const SERVICE_LABEL = "Google";

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

    try {
      const assertion = validateSamlResponse(store, samlResponse, baseUrl, profile);
      const request = takePendingAuthnRequest(store, profile, assertion);
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
