import type { Context, RouteContext } from "@emulators/core";
import { bodyStr, escapeHtml, renderCardPage, renderErrorPage, renderFormPostPage } from "@emulators/core";
import { getSlackStore } from "../store.js";
import {
  SAML_ERRORS,
  SamlResponseError,
  consumeAssertionId,
  createAuthnRequest,
  getSamlConfig,
  localPath,
  openWebSession,
  resolveSamlMember,
  takePendingAuthnRequest,
  validateSamlResponse,
} from "../saml.js";

const SERVICE_LABEL = "Slack";

export function samlRoutes({ app, store, baseUrl }: RouteContext): void {
  function notConfigured(c: Context) {
    return c.html(renderErrorPage("Not Found", "This workspace does not use SAML single sign-on.", SERVICE_LABEL), 404);
  }

  // SP-initiated sign-in: Slack sends the AuthnRequest to the identity provider's SAML 2.0 Endpoint URL
  // with the HTTP-POST binding, the only binding it supports.
  async function startSignIn(c: Context) {
    const config = getSamlConfig(store);
    if (!config) return notConfigured(c);
    let redir = c.req.query("redir");
    if (c.req.method === "POST") {
      const body = await c.req.parseBody();
      redir = bodyStr(body.redir) || redir;
    }
    const target = localPath(redir, baseUrl);
    const request = createAuthnRequest(store, baseUrl, config, target);
    const fields: Record<string, string> = { SAMLRequest: Buffer.from(request.xml, "utf8").toString("base64") };
    if (target) fields.RelayState = target;
    return c.html(renderFormPostPage(config.endpoint_url, fields, SERVICE_LABEL));
  }

  app.get("/sso/saml/start", startSignIn);
  app.post("/sso/saml/start", startSignIn);

  app.get("/sso/saml", (c) => {
    if (!getSamlConfig(store)) return notConfigured(c);
    return c.html(renderErrorPage("SAML sign-in failed", SAML_ERRORS.binding, SERVICE_LABEL), 400);
  });

  app.post("/sso/saml", async (c) => {
    const config = getSamlConfig(store);
    const team = getSlackStore(store).teams.all()[0];
    if (!config || !team) return notConfigured(c);

    const body = await c.req.parseBody();
    const samlResponse = bodyStr(body.SAMLResponse);
    if (!samlResponse) {
      return c.html(
        renderErrorPage("SAML sign-in failed", "The SAMLResponse parameter is missing.", SERVICE_LABEL),
        400,
      );
    }

    try {
      const assertion = validateSamlResponse(samlResponse, baseUrl, team, config);
      let redir: string | null;
      if (assertion.inResponseTo !== null) {
        const pending = takePendingAuthnRequest(store, assertion.inResponseTo);
        if (!pending)
          throw new SamlResponseError("The SAML Response does not answer a sign-in request from Slack.", 403);
        redir = pending.redir;
      } else {
        redir = localPath(bodyStr(body.RelayState), baseUrl);
      }
      consumeAssertionId(store, assertion);
      const member = resolveSamlMember(store, team, assertion);
      c.header("Set-Cookie", openWebSession(store, member, assertion.nameId));
      if (redir) return c.redirect(redir, 302);
      return c.html(
        renderCardPage(
          "Signed in",
          `You are signed in to <strong>${escapeHtml(team.name)}</strong> as <strong>${escapeHtml(member.name)}</strong>.`,
          "",
          SERVICE_LABEL,
        ),
      );
    } catch (error) {
      if (error instanceof SamlResponseError) {
        return c.html(renderErrorPage("SAML sign-in failed", error.message, SERVICE_LABEL), error.status);
      }
      throw error;
    }
  });
}
