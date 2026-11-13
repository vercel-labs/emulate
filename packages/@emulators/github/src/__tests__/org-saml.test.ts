import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { SignedXml } from "xml-crypto";
import { createServer, type AppKeyResolver, type Hono, type Store } from "@emulators/core";
import { createAppKeyResolver, getGitHubStore, githubPlugin, seedFromConfig } from "../index.js";
import { getActiveSamlSession, getLinkedSamlIdentity } from "../saml.js";

const base = "http://localhost:4000";
const idpUrl = "http://localhost:4100/app/acme_github/exk1/sso/saml";
const idpIssuer = "http://www.okta.com/exk1";
const entityId = `${base}/orgs/acme`;
const acsUrl = `${base}/orgs/acme/saml/consume`;
const SAMLP_NS = "urn:oasis:names:tc:SAML:2.0:protocol";
const SAML_NS = "urn:oasis:names:tc:SAML:2.0:assertion";

interface TestKey {
  certificate: string;
  privateKey: string;
}

// Self-signed test certificates and keys (openssl req -x509 -newkey rsa:2048 -sha256 -days 36500).
const idpKey: TestKey = {
  certificate: `-----BEGIN CERTIFICATE-----
MIIDETCCAfmgAwIBAgIUY3eTbkq38rQqB4unj68doMXBXpgwDQYJKoZIhvcNAQEL
BQAwFzEVMBMGA1UEAwwMVGVzdCBJZFAgaWRwMCAXDTI2MTExMTE3MzgxMloYDzIx
MjYxMDE4MTczODEyWjAXMRUwEwYDVQQDDAxUZXN0IElkUCBpZHAwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQCaZFZGl7q0bmkhXacO+M3czUBcHkvrIzon
1pGHC47cq4FbrAVZ+dnOY1KeKsGyNloz5W6JVTKhjl/KJ+27ChOWe2DWd7KxzSIp
zwwu+f7IrEcStPoOsf5kjgRuosnhk7SV9H68FsM9RyTa4kRRRPlmENr96q69zLsI
6H9Eajo0ZOmyHvc2J76pCWSXCbkj9Bsjx371P7AhEsA+tPsRmvJczGGV2tXBdJVD
CuRcJuMsSKn+MCe/cfMVasUO9GAhQZdrExZVfTXRNrCld8V8tzHtd+9ISHSNMTyY
9UIUCccgDRfAxkgowE8POE47MaY32AXx/wHGezGfRsR+iNeJUgYvAgMBAAGjUzBR
MB0GA1UdDgQWBBS83+WDDRNoRFTGjcJviiXbACQBqjAfBgNVHSMEGDAWgBS83+WD
DRNoRFTGjcJviiXbACQBqjAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUA
A4IBAQBXZNR6RXPLdETrrTybuw3Ncay1cUv3jfAIf3ki3lZwXFHa7ITRagkdPqyi
EX/knszj2GuuWd+MaprUmgKQv6wVm4aUuPs6n27Gud5xyJ+/7drHJhCAgGg5nOpd
AwBb5JTjN/mxmXMFyn+GI5HtkYDTxhjb1mLafVrndxd7Cbswt1/XzpR9+mAigmOV
uMedZl/C9LrbK0/lDvv+4inBFS2cTNsbo5JNj9zFE0UvyhKqR/gzUzakOXtpub0t
jBZdilfoO6B15sWbaANImaBlNxccIouGfnZQZXW3XCyeDyUgYbNHObce9Hn0HHhr
yohVL7MkWVq8Ilt54rq2UxQko1SQ
-----END CERTIFICATE-----`,
  privateKey: `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCaZFZGl7q0bmkh
XacO+M3czUBcHkvrIzon1pGHC47cq4FbrAVZ+dnOY1KeKsGyNloz5W6JVTKhjl/K
J+27ChOWe2DWd7KxzSIpzwwu+f7IrEcStPoOsf5kjgRuosnhk7SV9H68FsM9RyTa
4kRRRPlmENr96q69zLsI6H9Eajo0ZOmyHvc2J76pCWSXCbkj9Bsjx371P7AhEsA+
tPsRmvJczGGV2tXBdJVDCuRcJuMsSKn+MCe/cfMVasUO9GAhQZdrExZVfTXRNrCl
d8V8tzHtd+9ISHSNMTyY9UIUCccgDRfAxkgowE8POE47MaY32AXx/wHGezGfRsR+
iNeJUgYvAgMBAAECggEADwvmSJzy6jC0eDb7V/8xeOpb8l5VgcX+HfHQXvvmYWUp
hzidkOZDrtSJMbbzB546bkJW4nV2KL6KYVZA2fCidhDyIBSsSp22TaLLCiz9Aquf
hZgzookAROZ+UhX1XNGbUN3yF/yT7H3pfpd8lvsE30iXPxXHD+JK/BREivNbVs20
JIjaAlZlmqr/sAUmH/2ZFnpnwh46Gbu3hRO1NV2pKkvzx9p+Vh85ijvjFUJsOYxf
pe34JhJVH6RIPjPIw0IbrwaSvxgVL+uNR0lSUvNjuYCzCMnlUN5pAn++lCjB2SxG
iVAGBYl8v8TvxUeKs5kIjdHHKsJgvhbe8FggaqfwSQKBgQDHxXORJzeMlYOVJdPb
7CrH0EhIt4vQWCy/vwMk4VBtiKJ5SXZaX4TyihFsCYXdfc3zCMleAeaUwfcblD2e
Q3E7mLQ1ohM//SCEgp6sPdu173a8BgjeEX+SecCIf2YNyumPpjUHJqndSTscvCF4
G/8rusuYbjxaIewWsXM+ldUMfQKBgQDF2RHnttKyseZ48h5pIvSHtaL0fI0GyRsu
CiBzL0EUFNmzjx34nMDLRD2D+wfkS36N+7WqRlzyRHw0OMdkeZ2T7i1EHbd3aVw6
DQULID8jxv75Zth0Q1m7FHlXWE21fNB+nvlU/H73HS3AGOxZHExw7XpQ6eEmwIGO
h2uU6V+ZGwKBgD8n9kxKeK5SSmIprlvVwwSenWuX03TPm34XNjg/nzyxuKPdjLQv
hIllCvL7471NW4HdIkQ9F5ep5qRqbjyNl8u+kCJwleNh9BjQbreHauGOzhvNUJpc
L9ev9CVzGWF85/AJHLShDYyu7Sg9ddtSBo7dpCYRm7TnCot2GDgOCGfFAoGAYsP2
GEI/9EyyzPWxELMOdyDJdFso25ZRJy6O/HE+f5PZCbYMNCusYsxyGQyb5+94AdEB
4zq084wUpM0jXJkJfOuNVU+wYsAJ9kDBn8g9PNL+PeqFa6Sjiqyx1lSSlmL0ggFC
XpadmybJy/elJObnkgg642GdsAaxpkEcB35o5rkCgYEAofxn+xbTYzk7ZF7Dni/e
/5DCDFxZWnORGDXIn1c0wQeStaIoWwHEGzrXGZNF1LFkr4C/mx7dSViCjuhy8mTT
K2Tel2peet2bfZEt/c5s2yvJgCF6sKD7vpxkaVJIdr97mF2UQPMVPUX7ABk14GEj
qb/bgFNGGwlQ6haw3DQDy8Q=
-----END PRIVATE KEY-----`,
};

const otherKey: TestKey = {
  certificate: `-----BEGIN CERTIFICATE-----
MIIDFTCCAf2gAwIBAgIUYQsL0MKRk8/x/G+zO8HiYVkexdQwDQYJKoZIhvcNAQEL
BQAwGTEXMBUGA1UEAwwOVGVzdCBJZFAgb3RoZXIwIBcNMjYxMTExMTczODEyWhgP
MjEyNjEwMTgxNzM4MTJaMBkxFzAVBgNVBAMMDlRlc3QgSWRQIG90aGVyMIIBIjAN
BgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArfaMQTCw02zPUbBcWX1ZVCaDb1iH
JXFPyxYQTFcf1QNqxA4UwytGtqPZ58hlI+bwz+aT37+rnXxmYN4q4d+IY0OtSwaV
7WON04KayLjgt6BYYBvvuWVU/of0m0tNGsGlZTqwJ0bYDsdrU8gRLgNVrZfLGRI0
hJ+95+8y9AnDLnhFVLxTxQvMhAZ6JRlJ71kbSB3KBEnXqVDqtJTrYUIELQmC8xOh
5VUWhDNmWZf0Fyxy2AkdD+OBWb8seF1MqGeyMGE2o5Je3Df59Md7AovzqX1eRWtO
rLr4HJXzeoeZMU3J9lVOzmVWejS9foD8P5g6gIW/mgf43X2mASp2+2b1rwIDAQAB
o1MwUTAdBgNVHQ4EFgQU6ULtQaPxxv6iB8+5fk6cHty1Vs8wHwYDVR0jBBgwFoAU
6ULtQaPxxv6iB8+5fk6cHty1Vs8wDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0B
AQsFAAOCAQEASpY2vOjWNJFOq2Uij8gnu6ZBdg1lmi5bFvu4I+6zD22xtj1PBsOe
Z+G/fCVT8GK3cCNJiU+S+POLA+eRA4702B/HFpR97DsjlyQRkPkN+tAn8qqywr0j
8v1hWSzkRIKmc4UuCTmModoiCIPZVL6of5mNCkk97DwzyOT0uObGHiPPV0djGCwf
MAlLyZj5D7+6lZ93PawN4O1wYenn99iqKxnR5qRUxIBssMYDR8rc0RacwiaJZDuC
DxH3BS7+EkvtYETArPsb76hnTCG7up1O7fz1A/58K7Dexlk2Z0E9tpAAiu4kqCA2
psOZUMtN9Qrw0pKzE1Kq6X68qxwoxWAQew==
-----END CERTIFICATE-----`,
  privateKey: `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCt9oxBMLDTbM9R
sFxZfVlUJoNvWIclcU/LFhBMVx/VA2rEDhTDK0a2o9nnyGUj5vDP5pPfv6udfGZg
3irh34hjQ61LBpXtY43TgprIuOC3oFhgG++5ZVT+h/SbS00awaVlOrAnRtgOx2tT
yBEuA1Wtl8sZEjSEn73n7zL0CcMueEVUvFPFC8yEBnolGUnvWRtIHcoESdepUOq0
lOthQgQtCYLzE6HlVRaEM2ZZl/QXLHLYCR0P44FZvyx4XUyoZ7IwYTajkl7cN/n0
x3sCi/OpfV5Fa06suvgclfN6h5kxTcn2VU7OZVZ6NL1+gPw/mDqAhb+aB/jdfaYB
Knb7ZvWvAgMBAAECggEAP3tegDWP+X9WAmXctW1oKSyqvvmry66XYzFofis2+wk1
r1jCG9yRf/m3/Xyj59+RFhT69mYf7qbkR0oblPR49VxPgzbihE/VhA8/g6rvmiLB
zUS0jM+dHgsn6Hmop/Btdkzd1l9kXbRJBrhWCJf/7oqbe0ko8BLI/rfLvMFJQA3Z
dFUcqHZ/CnV6/pQ0836rs3GNHByzayFcRTArhylQOKqmF4HcQvKs6+W7/fYjyUkB
TNoCaVgwX4SOfIGyMWTd4QnDrr5xwtyRGLel1NKJuAxKE9udLZnDmUh6/R0k1Mrb
YWZr3ukq8+jkFbn0Otl5fRX9mnbLPKdp85v8wM4+CQKBgQDumPN/LqDEKw5bfGj8
iDGBiDgmaH9/zYCsVLqpQJSyz99X/gD/HbL2GU9zNz2TEiGhV9SKKUmf6y1MPKgH
PfzSZsDGyBABozs8RnKp2lNqHqOyfYeQLgmkNT7WrbKRW6PcKpFlKCZZCz+Sg7jd
K3SYS23rFSw1VXWtLylMAWYgqQKBgQC6psFMzVGvRY/e3D/Y8Vi7QiO6qJxjmmbJ
EJve+vj+V1ZsFLiB9lpnS6+BQ7eUQyKWIs/ZL+im0AoBZ8VHAnpA3yxMNN4qJhtM
BkJ2wPkwPuh8CE/N3+/gYxpqeExmmzdLSldPCvfghoZmN1zTpwyGT6q3+JAbzi42
Tk891wFilwKBgH1HTBsMdZdq8BfzRADM1gmoZ6srFT8avSQ/PN9frHQTF7dRBF7v
zibP9VqOt8MAMy5POqbstN7GEjvEYYmj75reHvyA0X66oYCtkMlEfKXsvpEavlJj
CebxmjQIcglGr8wLgdo2caQxdsjMZwWiKo9Ik8dqj5LVc3tilvF0jpY5AoGAH2Et
mkXid78QIv2QVl6s9j52V0lFkZFBuofqTKCQ/+GbC+yn4GGUbU1SIj9KO8jVpbwQ
iYj+ah0LsZTKm9eUyhc7EUzKFPf3Gt7qiaCDxFKvLzsOf6QoZecDZ+b1oUJzF1tW
Nlm3tq2nJsQj/QlWl7YJE4jcYXBWYJblx5XAC90CgYEA7kElPPYerpNlUVzIYp6N
7q48vRf2+Hp/FuHQu3wqpNdq7FNeBjFGZL6stPRiT8V6q/lZ9wkarrp21Wy8HNi+
/5wkumswYWC4JetlJ6G1dxqvajRS8g9NMEerRDVPqjovcbByX4DZfXeZrOsiw1JE
9liEO0q3T1vWqkEpJEmua4w=
-----END PRIVATE KEY-----`,
};

function createTestApp(saml?: { issuer?: string }) {
  // Built the way the CLI builds it: an App key resolver over the store, and a fallback user.
  const keys: { resolve?: AppKeyResolver } = {};
  const { app, store } = createServer(githubPlugin, {
    baseUrl: base,
    appKeyResolver: (appId) => keys.resolve!(appId),
    fallbackUser: { login: "octocat", id: 1, scopes: ["repo", "user", "admin:org", "admin:repo_hook"] },
  });
  keys.resolve = createAppKeyResolver(store);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "octocat" }, { login: "hubot" }],
    orgs: [
      {
        login: "acme",
        members: [{ login: "octocat" }, { login: "hubot" }],
        saml: { sign_on_url: idpUrl, public_certificate: idpKey.certificate, ...saml },
      },
      { login: "plain" },
    ],
  });
  return { app, store };
}

async function signIn(app: Hono, login: string): Promise<string> {
  const res = await app.request(`${base}/login/oauth/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ login, redirect_uri: `${base}/orgs/acme/sso`, scope: "", state: "", client_id: "" }),
  });
  const cookie = res.headers.get("Set-Cookie") ?? "";
  const match = /_emu_session=([^;]+)/.exec(cookie);
  expect(match).not.toBeNull();
  return match![1];
}

function hiddenField(html: string, name: string): string | null {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  return match
    ? match[1]
        .replace(/&#x2F;|&#47;/g, "/")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
    : null;
}

async function startSso(app: Hono, sessionId: string, query = ""): Promise<{ html: string; requestId: string }> {
  const res = await app.request(`${base}/orgs/acme/sso${query}`, { headers: { Cookie: `_emu_session=${sessionId}` } });
  expect(res.status).toBe(200);
  const html = await res.text();
  const samlRequest = hiddenField(html, "SAMLRequest");
  expect(samlRequest).not.toBeNull();
  const request = new DOMParser().parseFromString(Buffer.from(samlRequest!, "base64").toString("utf8"), "text/xml");
  return { html, requestId: request.documentElement!.getAttribute("ID")! };
}

interface ResponseOptions {
  requestId?: string | null;
  nameId?: string;
  audience?: string;
  recipient?: string;
  destination?: string;
  issuer?: string;
  notBefore?: Date;
  notOnOrAfter?: Date;
  /** `null` leaves NotOnOrAfter out of the bearer SubjectConfirmationData. */
  confirmationNotOnOrAfter?: Date | null;
  sessionNotOnOrAfter?: Date;
  sign?: "assertion" | "response" | "none";
  key?: TestKey;
  keyInfo?: boolean;
}

function buildResponse(options: ResponseOptions = {}): string {
  const now = Date.now();
  const issuer = options.issuer ?? idpIssuer;
  const inResponseTo = options.requestId === null ? "" : ` InResponseTo="${options.requestId}"`;
  const notBefore = (options.notBefore ?? new Date(now - 5 * 60 * 1000)).toISOString();
  const notOnOrAfter = (options.notOnOrAfter ?? new Date(now + 5 * 60 * 1000)).toISOString();
  const confirmationNotOnOrAfter =
    options.confirmationNotOnOrAfter === null
      ? ""
      : ` NotOnOrAfter="${options.confirmationNotOnOrAfter?.toISOString() ?? notOnOrAfter}"`;
  const sessionNotOnOrAfter = options.sessionNotOnOrAfter
    ? ` SessionNotOnOrAfter="${options.sessionNotOnOrAfter.toISOString()}"`
    : "";
  const issueInstant = new Date(now).toISOString();
  const xml =
    `<samlp:Response xmlns:samlp="${SAMLP_NS}" xmlns:saml="${SAML_NS}" ID="_response1" Version="2.0"` +
    ` IssueInstant="${issueInstant}" Destination="${options.destination ?? acsUrl}"${inResponseTo}>` +
    `<saml:Issuer>${issuer}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    `<saml:Assertion ID="_assertion1" Version="2.0" IssueInstant="${issueInstant}">` +
    `<saml:Issuer>${issuer}</saml:Issuer>` +
    `<saml:Subject>` +
    `<saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">${options.nameId ?? "octocat@acme.test"}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
    `<saml:SubjectConfirmationData${inResponseTo}${confirmationNotOnOrAfter} Recipient="${options.recipient ?? acsUrl}"/>` +
    `</saml:SubjectConfirmation>` +
    `</saml:Subject>` +
    `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">` +
    `<saml:AudienceRestriction><saml:Audience>${options.audience ?? entityId}</saml:Audience></saml:AudienceRestriction>` +
    `</saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${issueInstant}"${sessionNotOnOrAfter}>` +
    `<saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext>` +
    `</saml:AuthnStatement>` +
    `</saml:Assertion>` +
    `</samlp:Response>`;

  const sign = options.sign ?? "assertion";
  if (sign === "none") return xml;
  const target = sign === "assertion" ? "Assertion" : "Response";
  const signer = new SignedXml({
    privateKey: (options.key ?? idpKey).privateKey,
    publicCert: options.keyInfo ? (options.key ?? idpKey).certificate : undefined,
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  });
  signer.addReference({
    xpath: `//*[local-name(.)='${target}']`,
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"],
  });
  signer.computeSignature(xml, {
    location: { reference: `//*[local-name(.)='${target}']/*[local-name(.)='Issuer']`, action: "after" },
  });
  return signer.getSignedXml();
}

/** Posts the response as the browser would; `sessionId: null` is a cross-site POST without the session cookie. */
function consume(app: Hono, sessionId: string | null, xml: string, relayState?: string) {
  const form = new URLSearchParams({ SAMLResponse: Buffer.from(xml, "utf8").toString("base64") });
  if (relayState !== undefined) form.set("RelayState", relayState);
  return app.request(`${base}/orgs/acme/saml/consume`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(sessionId === null ? {} : { Cookie: `_emu_session=${sessionId}` }),
    },
    body: form,
  });
}

function acme(store: Store) {
  return getGitHubStore(store).orgs.findOneBy("login", "acme")!;
}

function userId(store: Store, login: string) {
  return getGitHubStore(store).users.findOneBy("login", login)!.id;
}

describe("GitHub organization SAML metadata", () => {
  it("publishes the organization's service provider metadata", async () => {
    const { app } = createTestApp();
    const res = await app.request(`${base}/orgs/acme/saml/metadata`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("xml");
    const doc = new DOMParser().parseFromString(await res.text(), "text/xml");
    const descriptor = doc.documentElement!;
    expect(descriptor.localName).toBe("EntityDescriptor");
    expect(descriptor.getAttribute("entityID")).toBe(entityId);
    const acs = doc.getElementsByTagNameNS("urn:oasis:names:tc:SAML:2.0:metadata", "AssertionConsumerService")[0];
    expect(acs.getAttribute("Location")).toBe(acsUrl);
    expect(acs.getAttribute("Binding")).toBe("urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST");
  });

  it("returns 404 for an organization without SAML single sign-on", async () => {
    const { app } = createTestApp();
    expect((await app.request(`${base}/orgs/plain/saml/metadata`)).status).toBe(404);
    expect((await app.request(`${base}/orgs/plain/sso`)).status).toBe(404);
  });
});

describe("GitHub organization SAML sign-in request", () => {
  it("asks a browser without a GitHub session to sign in to its personal account first", async () => {
    const { app } = createTestApp();
    const res = await app.request(`${base}/orgs/acme/sso`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Sign in to GitHub");
    expect(html).toContain('action="/login/oauth/callback"');
    expect(hiddenField(html, "redirect_uri")).toBe(`${base}/orgs/acme/sso`);
    expect(hiddenField(html, "SAMLRequest")).toBeNull();
  });

  it("does not take the API fallback user as a browser session", async () => {
    const { app } = createTestApp();
    const res = await app.request(`${base}/orgs/acme/sso`, { headers: { Authorization: "Bearer unknown" } });
    expect(hiddenField(await res.text(), "SAMLRequest")).toBeNull();
  });

  it("posts an AuthnRequest to the identity provider for a signed-in browser", async () => {
    const { app } = createTestApp();
    const sessionId = await signIn(app, "octocat");
    const { html } = await startSso(app, sessionId, "?return_to=%2Facme%2Frepo");
    expect(html).toContain(`action="${idpUrl}"`);
    expect(hiddenField(html, "RelayState")).toBe("/acme/repo");

    const xml = Buffer.from(hiddenField(html, "SAMLRequest")!, "base64").toString("utf8");
    const request = new DOMParser().parseFromString(xml, "text/xml").documentElement!;
    expect(request.localName).toBe("AuthnRequest");
    expect(request.namespaceURI).toBe(SAMLP_NS);
    expect(request.getAttribute("ID")).toMatch(/^_[0-9a-f]+$/);
    expect(request.getAttribute("Destination")).toBe(idpUrl);
    expect(request.getAttribute("AssertionConsumerServiceURL")).toBe(acsUrl);
    expect(request.getAttribute("ProtocolBinding")).toBe("urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST");
    expect(request.getElementsByTagNameNS(SAML_NS, "Issuer")[0].textContent).toBe(entityId);
  });
});

describe("GitHub organization SAML response", () => {
  let app: Hono;
  let store: Store;
  let sessionId: string;

  beforeEach(async () => {
    ({ app, store } = createTestApp());
    sessionId = await signIn(app, "octocat");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function expectRefused(xmlFor: (requestId: string) => string, status = 403) {
    const { requestId } = await startSso(app, sessionId);
    const res = await consume(app, sessionId, xmlFor(requestId));
    expect(res.status).toBe(status);
    const html = await res.text();
    expect(html).toContain("SAML sign-in failed");
    expect(getActiveSamlSession(store, sessionId, acme(store).id)).toBeNull();
    return html;
  }

  it("opens a SAML session and links the NameID for a valid signed assertion", async () => {
    const { requestId } = await startSso(app, sessionId);
    const res = await consume(app, sessionId, buildResponse({ requestId }), "/acme/repo");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/acme/repo");

    const session = getActiveSamlSession(store, sessionId, acme(store).id);
    expect(session?.name_id).toBe("octocat@acme.test");
    expect(session?.user_id).toBe(userId(store, "octocat"));
    expect(getLinkedSamlIdentity(store, acme(store).id, userId(store, "octocat"))).toBe("octocat@acme.test");
    expect(getActiveSamlSession(store, "another-browser", acme(store).id)).toBeNull();
  });

  it("accepts a signed response and redirects to the organization without RelayState", async () => {
    const { requestId } = await startSso(app, sessionId);
    const res = await consume(app, sessionId, buildResponse({ requestId, sign: "response" }));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/orgs/acme");
    expect(getActiveSamlSession(store, sessionId, acme(store).id)).not.toBeNull();
  });

  it("does not redirect to another host from RelayState", async () => {
    for (const relayState of [
      "/\t/evil.example/",
      "/ /evil.example",
      "//evil.example",
      "/\\evil.example",
      "https://evil.example",
      "/a/..//evil.example/",
      "/a/../..//evil.example/",
    ]) {
      const { requestId } = await startSso(app, sessionId);
      const res = await consume(app, sessionId, buildResponse({ requestId }), relayState);
      expect(res.status, relayState).toBe(302);
      expect(res.headers.get("Location"), relayState).toBe("/orgs/acme");
    }
  });

  it("redirects to a local RelayState path", async () => {
    const { requestId } = await startSso(app, sessionId);
    const res = await consume(app, sessionId, buildResponse({ requestId }), "/acme/repo?tab=code#readme");
    expect(res.headers.get("Location")).toBe("/acme/repo?tab=code#readme");
  });

  it("does not send an external return_to as RelayState", async () => {
    const { html } = await startSso(app, sessionId, `?return_to=${encodeURIComponent("/\t/evil.example/")}`);
    expect(hiddenField(html, "RelayState")).toBeNull();
  });

  it("refuses an unsigned response", async () => {
    await expectRefused((requestId) => buildResponse({ requestId, sign: "none" }));
  });

  it("refuses a response signed by another key", async () => {
    await expectRefused((requestId) => buildResponse({ requestId, key: otherKey }));
    await expectRefused((requestId) => buildResponse({ requestId, key: otherKey, sign: "response" }));
    await expectRefused((requestId) => buildResponse({ requestId, key: otherKey, keyInfo: true }));
  });

  it("refuses a signed assertion modified after signing", async () => {
    await expectRefused((requestId) => buildResponse({ requestId }).replace("octocat@acme.test", "hubot@acme.test"));
  });

  it("refuses a response with a second, unsigned assertion next to the signed one", async () => {
    const forged = (requestId: string) =>
      buildResponse({ requestId, sign: "none", nameId: "hubot@acme.test" })
        .match(/<saml:Assertion[\s\S]*<\/saml:Assertion>/)![0]
        .replace('ID="_assertion1"', 'ID="_forged"');
    const before = await expectRefused((requestId) =>
      buildResponse({ requestId }).replace("</samlp:Status>", `</samlp:Status>${forged(requestId)}`),
    );
    expect(before).toContain("single assertion");
    const after = await expectRefused((requestId) =>
      buildResponse({ requestId }).replace("</samlp:Response>", `${forged(requestId)}</samlp:Response>`),
    );
    expect(after).toContain("single assertion");
  });

  it("reads the signed assertion, not an unsigned copy wrapped around it", async () => {
    await expectRefused((requestId) => {
      const signed = buildResponse({ requestId });
      const signedAssertion = signed.match(/<saml:Assertion[\s\S]*<\/saml:Assertion>/)![0];
      const forged = buildResponse({ requestId, sign: "none", nameId: "hubot@acme.test" })
        .match(/<saml:Assertion[\s\S]*<\/saml:Assertion>/)![0]
        .replace("</saml:Subject>", `</saml:Subject><saml:Advice>${signedAssertion}</saml:Advice>`);
      return signed.replace(signedAssertion, forged);
    });
  });

  it("refuses a response for another audience", async () => {
    await expectRefused((requestId) => buildResponse({ requestId, audience: `${base}/orgs/other` }));
  });

  it("refuses a response for another recipient", async () => {
    await expectRefused((requestId) => buildResponse({ requestId, recipient: `${base}/orgs/other/saml/consume` }));
  });

  it("refuses a signed response for another destination", async () => {
    await expectRefused((requestId) =>
      buildResponse({ requestId, sign: "response", destination: `${base}/orgs/other/saml/consume` }),
    );
  });

  it("refuses an expired response", async () => {
    await expectRefused((requestId) =>
      buildResponse({
        requestId,
        notBefore: new Date(Date.now() - 10 * 60 * 1000),
        notOnOrAfter: new Date(Date.now() - 60 * 1000),
      }),
    );
  });

  it("refuses an assertion whose bearer subject confirmation has no NotOnOrAfter", async () => {
    const html = await expectRefused((requestId) => buildResponse({ requestId, confirmationNotOnOrAfter: null }));
    expect(html).toContain("SubjectConfirmationData has no NotOnOrAfter");
    await expectRefused((requestId) => buildResponse({ requestId, sign: "response", confirmationNotOnOrAfter: null }));
  });

  it("refuses a response that is not yet valid", async () => {
    await expectRefused((requestId) =>
      buildResponse({
        requestId,
        notBefore: new Date(Date.now() + 60 * 1000),
        notOnOrAfter: new Date(Date.now() + 10 * 60 * 1000),
      }),
    );
  });

  it("refuses a response to an unknown request, to no request, or to another browser's request", async () => {
    await expectRefused(() => buildResponse({ requestId: "_unknown" }));
    await expectRefused(() => buildResponse({ requestId: null }));

    const otherSession = await signIn(app, "hubot");
    const { requestId } = await startSso(app, otherSession);
    const res = await consume(app, sessionId, buildResponse({ requestId }));
    expect(res.status).toBe(403);
  });

  it("refuses a replayed response", async () => {
    const { requestId } = await startSso(app, sessionId);
    const xml = buildResponse({ requestId });
    expect((await consume(app, sessionId, xml)).status).toBe(302);
    expect((await consume(app, sessionId, xml)).status).toBe(403);
  });

  async function linkFirstIdentity() {
    const first = await startSso(app, sessionId);
    expect((await consume(app, sessionId, buildResponse({ requestId: first.requestId }))).status).toBe(302);
    sessionId = await signIn(app, "octocat");
  }

  async function startRelink(relayState?: string): Promise<string> {
    const { requestId } = await startSso(app, sessionId);
    const res = await consume(app, sessionId, buildResponse({ requestId, nameId: "new@acme.test" }), relayState);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("You are about to relink your account.");
    expect(html).toContain('action="/orgs/acme/saml/relink"');
    return hiddenField(html, "relink_token")!;
  }

  function confirmRelink(browserSession: string, token: string) {
    return app.request(`${base}/orgs/acme/saml/relink`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: `_emu_session=${browserSession}` },
      body: new URLSearchParams({ relink_token: token }),
    });
  }

  it("warns before relinking the account to a different NameID", async () => {
    await linkFirstIdentity();
    const token = await startRelink();
    expect(token).toMatch(/^[0-9a-f]+$/);
    expect(getLinkedSamlIdentity(store, acme(store).id, userId(store, "octocat"))).toBe("octocat@acme.test");
    expect(getActiveSamlSession(store, sessionId, acme(store).id)).toBeNull();
  });

  it("relinks the account and opens the SAML session when the user continues", async () => {
    await linkFirstIdentity();
    const token = await startRelink("/acme/repo");
    const res = await confirmRelink(sessionId, token);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/acme/repo");
    expect(getLinkedSamlIdentity(store, acme(store).id, userId(store, "octocat"))).toBe("new@acme.test");
    expect(getActiveSamlSession(store, sessionId, acme(store).id)?.name_id).toBe("new@acme.test");
    expect((await confirmRelink(sessionId, token)).status).toBe(403);
  });

  it("relinks after a response posted without the session cookie, from GitHub's own page", async () => {
    await linkFirstIdentity();
    const { requestId } = await startSso(app, sessionId);
    const warning = await consume(app, null, buildResponse({ requestId, nameId: "new@acme.test" }));
    expect(warning.status).toBe(200);
    const token = hiddenField(await warning.text(), "relink_token")!;
    expect((await confirmRelink("unknown-session", token)).status).toBe(403);
    expect((await confirmRelink(sessionId, token)).status).toBe(302);
    expect(getActiveSamlSession(store, sessionId, acme(store).id)?.name_id).toBe("new@acme.test");
  });

  it("changes nothing without the user's confirmation", async () => {
    await linkFirstIdentity();
    const token = await startRelink();
    const otherBrowser = await signIn(app, "octocat");
    expect((await confirmRelink(otherBrowser, token)).status).toBe(403);
    expect((await confirmRelink(sessionId, "unknown")).status).toBe(403);
    expect(getLinkedSamlIdentity(store, acme(store).id, userId(store, "octocat"))).toBe("octocat@acme.test");
    expect(getActiveSamlSession(store, sessionId, acme(store).id)).toBeNull();
    expect(getActiveSamlSession(store, otherBrowser, acme(store).id)).toBeNull();
  });

  it("refuses a NameID linked to another account", async () => {
    const first = await startSso(app, sessionId);
    expect((await consume(app, sessionId, buildResponse({ requestId: first.requestId }))).status).toBe(302);

    sessionId = await signIn(app, "hubot");
    await expectRefused((requestId) => buildResponse({ requestId }));
    expect(getLinkedSamlIdentity(store, acme(store).id, userId(store, "hubot"))).toBeNull();
  });

  it("accepts a cross-site POST without the session cookie for the browser that sent the request", async () => {
    const otherSession = await signIn(app, "hubot");
    const { requestId } = await startSso(app, sessionId);
    const res = await consume(app, null, buildResponse({ requestId }), "/acme/repo");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/acme/repo");

    expect(getActiveSamlSession(store, sessionId, acme(store).id)?.user_id).toBe(userId(store, "octocat"));
    expect(getActiveSamlSession(store, otherSession, acme(store).id)).toBeNull();
    expect(getLinkedSamlIdentity(store, acme(store).id, userId(store, "octocat"))).toBe("octocat@acme.test");
    expect(getLinkedSamlIdentity(store, acme(store).id, userId(store, "hubot"))).toBeNull();
    expect((await consume(app, null, buildResponse({ requestId }))).status).toBe(403);
  });

  it("does not open a session for the browser that posts a response to another browser's request", async () => {
    const posterSession = await signIn(app, "hubot");
    const { requestId } = await startSso(app, sessionId);
    const res = await consume(app, posterSession, buildResponse({ requestId }));
    expect(res.status).toBe(403);
    expect(getActiveSamlSession(store, posterSession, acme(store).id)).toBeNull();
    expect(getActiveSamlSession(store, sessionId, acme(store).id)).toBeNull();
    expect(getLinkedSamlIdentity(store, acme(store).id, userId(store, "hubot"))).toBeNull();
  });

  it("refuses a response that is not SAML", async () => {
    await startSso(app, sessionId);
    const res = await consume(app, sessionId, "not xml");
    expect(res.status).toBe(400);
  });

  it("ends the SAML session 24 hours after authentication", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { requestId } = await startSso(app, sessionId);
    expect((await consume(app, sessionId, buildResponse({ requestId }))).status).toBe(302);

    vi.setSystemTime(new Date("2026-01-01T23:59:59Z"));
    expect(getActiveSamlSession(store, sessionId, acme(store).id)).not.toBeNull();
    vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
    expect(getActiveSamlSession(store, sessionId, acme(store).id)).toBeNull();
    expect(getLinkedSamlIdentity(store, acme(store).id, userId(store, "octocat"))).toBe("octocat@acme.test");
  });

  it("ends the SAML session at SessionNotOnOrAfter", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { requestId } = await startSso(app, sessionId);
    const sessionNotOnOrAfter = new Date("2026-01-01T04:00:00Z");
    expect((await consume(app, sessionId, buildResponse({ requestId, sessionNotOnOrAfter }))).status).toBe(302);

    vi.setSystemTime(new Date("2026-01-01T03:59:59Z"));
    expect(getActiveSamlSession(store, sessionId, acme(store).id)).not.toBeNull();
    vi.setSystemTime(sessionNotOnOrAfter);
    expect(getActiveSamlSession(store, sessionId, acme(store).id)).toBeNull();
  });

  it("checks the issuer when the organization configures one", async () => {
    ({ app, store } = createTestApp({ issuer: idpIssuer }));
    sessionId = await signIn(app, "octocat");
    await expectRefused((requestId) => buildResponse({ requestId, issuer: "http://www.okta.com/other" }));

    const { requestId } = await startSso(app, sessionId);
    expect((await consume(app, sessionId, buildResponse({ requestId }))).status).toBe(302);
  });
});

describe("GitHub organization SAML seed config", () => {
  it("requires the sign-on URL and the public certificate", () => {
    const { store } = createServer(githubPlugin, { baseUrl: base });
    expect(() =>
      seedFromConfig(store, base, {
        orgs: [{ login: "acme", saml: { sign_on_url: idpUrl, public_certificate: "" } }],
      }),
    ).toThrow(/public_certificate/);
  });
});
