import { randomBytes } from "crypto";
import { inflateRawSync } from "zlib";
import type { RouteContext, Store } from "@internal/core";
import {
  renderCardPage,
  renderErrorPage,
  renderUserButton,
  escapeHtml,
  bodyStr,
  debug,
} from "@internal/core";
import { getIdpStore } from "../store.js";
import { resolvePath, generateSelfSignedCert, getPublicCertBase64 } from "../crypto.js";
import { getStrict, getPendingSamlRequests, getSamlEntityId } from "../helpers.js";
import { buildMetadataXml, buildSamlResponse, signAssertion, buildAutoPostForm } from "../saml-xml.js";
import { ENTRA_ID_ATTRIBUTE_MAPPINGS, SAML_NAMEID_FORMATS } from "../saml-constants.js";

const SERVICE_LABEL = "Identity Provider";

async function getOrGenerateCert(store: Store): Promise<{ certPem: string; certBase64: string }> {
  let certPem = store.getData<string>("idp.saml.certificatePem");
  if (!certPem) {
    const idp = getIdpStore(store);
    const activeKey = idp.signingKeys.all().find(k => k.active);
    if (!activeKey) throw new Error("No active signing key");
    certPem = await generateSelfSignedCert(activeKey.private_key_pem);
    store.setData("idp.saml.certificatePem", certPem);
  }
  return { certPem, certBase64: getPublicCertBase64(certPem) };
}

export function samlRoutes({ app, store, baseUrl }: RouteContext): void {
  const idp = getIdpStore(store);

  // GET /saml/metadata
  app.get("/saml/metadata", async (c) => {
    const { certBase64 } = await getOrGenerateCert(store);
    const entityId = getSamlEntityId(store, baseUrl);
    const ssoUrl = `${baseUrl}/saml/sso`;
    const xml = buildMetadataXml(entityId, ssoUrl, certBase64);
    return c.text(xml, 200, { "Content-Type": "application/xml" });
  });

  // GET /saml/sso — SP-initiated SSO entry point
  app.get("/saml/sso", (c) => {
    const samlRequest = c.req.query("SAMLRequest") ?? "";
    const relayState = c.req.query("RelayState") ?? "";

    if (!samlRequest) {
      return c.html(renderErrorPage("Missing SAMLRequest", "No SAMLRequest parameter provided.", SERVICE_LABEL), 400);
    }

    // Decode SAMLRequest: base64 -> inflate -> XML
    let requestXml: string;
    try {
      const decoded = Buffer.from(samlRequest, "base64");
      requestXml = inflateRawSync(decoded).toString("utf-8");
    } catch {
      return c.html(renderErrorPage("Invalid SAMLRequest", "Could not decode the SAMLRequest.", SERVICE_LABEL), 400);
    }

    // Parse AuthnRequest - extract key fields via regex (no full XML parser needed)
    const acsUrlMatch = requestXml.match(/Assert(?:i|io)nConsumerServiceURL="([^"]+)"/);
    const requestIdMatch = requestXml.match(/ID="([^"]+)"/);
    const issuerMatch = requestXml.match(/<(?:saml[p2]?:)?Issuer[^>]*>([^<]+)<\//);

    const acsUrl = acsUrlMatch?.[1] ?? "";
    const requestId = requestIdMatch?.[1] ?? "";
    const spEntityId = issuerMatch?.[1] ?? "";

    // Strict mode: validate SP
    const strict = getStrict(store);
    if (strict) {
      const sp = idp.serviceProviders.findOneBy("entity_id", spEntityId);
      if (!sp) {
        return c.html(renderErrorPage("Unknown Service Provider", `The entity '${escapeHtml(spEntityId)}' is not registered.`, SERVICE_LABEL), 400);
      }
    }

    // Use configured ACS URL if available, otherwise use the one from the request
    const sp = idp.serviceProviders.findOneBy("entity_id", spEntityId);
    const resolvedAcsUrl = sp?.acs_url ?? acsUrl;

    // Store pending SAML request
    const ref = randomBytes(16).toString("hex");
    getPendingSamlRequests(store).set(ref, {
      requestId,
      acsUrl: resolvedAcsUrl,
      spEntityId,
      relayState,
      created_at: Date.now(),
    });

    // Render user picker
    const users = idp.users.all();
    const userButtons = users.map(user =>
      renderUserButton({
        letter: (user.email[0] ?? "?").toUpperCase(),
        login: user.email,
        name: user.name,
        email: user.email,
        formAction: "/saml/sso/callback",
        hiddenFields: {
          uid: user.uid,
          saml_request_ref: ref,
        },
      })
    ).join("\n");

    const body = users.length === 0
      ? '<p class="empty">No users in the emulator store.</p>'
      : userButtons;

    return c.html(renderCardPage("Sign in", "Choose a user to continue with SAML SSO.", body, SERVICE_LABEL));
  });

  // POST /saml/sso/callback — User selected, build and POST assertion
  app.post("/saml/sso/callback", async (c) => {
    const formBody = await c.req.parseBody();
    const uid = bodyStr(formBody.uid);
    const samlRequestRef = bodyStr(formBody.saml_request_ref);

    // Look up pending request
    const pendingMap = getPendingSamlRequests(store);
    const pending = pendingMap.get(samlRequestRef);
    if (!pending) {
      return c.html(renderErrorPage("Invalid Request", "SAML request reference not found or expired.", SERVICE_LABEL), 400);
    }

    // Check TTL (10 minutes)
    const SAML_REQUEST_TTL_MS = 10 * 60 * 1000;
    if (Date.now() - pending.created_at > SAML_REQUEST_TTL_MS) {
      pendingMap.delete(samlRequestRef);
      return c.html(renderErrorPage("Request Expired", "The SAML request has expired. Please try again.", SERVICE_LABEL), 400);
    }

    pendingMap.delete(samlRequestRef);

    // Look up user
    const user = idp.users.findOneBy("uid", uid);
    if (!user) {
      return c.html(renderErrorPage("User Not Found", "The selected user does not exist.", SERVICE_LABEL), 400);
    }

    // Look up SP config for attribute mappings and NameID format
    const sp = idp.serviceProviders.findOneBy("entity_id", pending.spEntityId);
    const attributeMappings = sp?.attribute_mappings ?? ENTRA_ID_ATTRIBUTE_MAPPINGS;
    const nameIdFormatKey = sp?.name_id_format ?? "emailAddress";
    const nameIdFormat = SAML_NAMEID_FORMATS[nameIdFormatKey] ?? SAML_NAMEID_FORMATS.emailAddress;

    // Resolve NameID
    let nameId: string;
    if (nameIdFormatKey === "persistent") {
      nameId = user.uid;
    } else {
      nameId = user.email;
    }

    // Resolve attributes
    const attributes: Array<{ name: string; value: string }> = [];
    for (const [claimUri, userPath] of Object.entries(attributeMappings)) {
      const value = resolvePath(user, userPath);
      if (value !== undefined) {
        const strValue = typeof value === "string" ? value : JSON.stringify(value);
        attributes.push({ name: claimUri, value: strValue });
      }
    }

    // Build timing
    const now = new Date();
    const notBefore = new Date(now.getTime() - 5 * 60 * 1000);
    const notOnOrAfter = new Date(now.getTime() + 5 * 60 * 1000);
    const sessionNotOnOrAfter = new Date(now.getTime() + 8 * 60 * 60 * 1000);

    // Build SAML Response
    const responseId = `_${randomBytes(16).toString("hex")}`;
    const assertionId = `_${randomBytes(16).toString("hex")}`;
    const entityId = getSamlEntityId(store, baseUrl);

    const responseXml = buildSamlResponse({
      responseId,
      assertionId,
      issuer: entityId,
      destination: pending.acsUrl,
      audienceEntityId: pending.spEntityId,
      nameId,
      nameIdFormat,
      inResponseTo: pending.requestId,
      authnInstant: now.toISOString(),
      notBefore: notBefore.toISOString(),
      notOnOrAfter: notOnOrAfter.toISOString(),
      sessionNotOnOrAfter: sessionNotOnOrAfter.toISOString(),
      attributes,
    });

    // Sign the assertion
    const { certBase64 } = await getOrGenerateCert(store);
    const activeKey = idp.signingKeys.all().find(k => k.active);
    if (!activeKey) {
      return c.html(renderErrorPage("No Signing Key", "No active signing key available.", SERVICE_LABEL), 500);
    }

    const signedXml = signAssertion(responseXml, activeKey.private_key_pem, certBase64);

    // Base64 encode and return auto-post form
    const samlResponseB64 = Buffer.from(signedXml).toString("base64");
    const html = buildAutoPostForm(pending.acsUrl, samlResponseB64, pending.relayState);

    debug("idp.saml", `[SAML SSO] Assertion for ${user.email} → ${pending.acsUrl}`);

    return c.html(html);
  });
}
