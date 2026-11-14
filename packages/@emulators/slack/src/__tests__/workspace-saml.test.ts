import { describe, it, expect } from "vitest";
import { DOMParser, type Element } from "@xmldom/xmldom";
import { SignedXml } from "xml-crypto";
import { createServer, type Hono } from "@emulators/core";
import { getSlackStore, seedFromConfig, slackPlugin, type SlackSsoRequirement } from "../index.js";

const base = "http://localhost:4000";
const acsUrl = `${base}/sso/saml`;
const idpUrl = "http://localhost:4100/app/acme_slack/exk1/sso/saml";
const idpIssuer = "http://www.okta.com/exk1";
const SAMLP_NS = "urn:oasis:names:tc:SAML:2.0:protocol";
const SAML_NS = "urn:oasis:names:tc:SAML:2.0:assertion";
const PERSISTENT = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";
const redirectUri = "http://localhost:3000/callback";

interface TestKey {
  certificate: string;
  privateKey: string;
}

// Self-signed test certificates and keys (openssl req -x509 -newkey rsa:2048 -sha256 -days 36500).
export const idpKey: TestKey = {
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

export const otherKey: TestKey = {
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

interface SamlOptions {
  sso_requirement?: SlackSsoRequirement;
  responses_signed?: boolean;
  assertions_signed?: boolean;
}

function createTestApp(saml: SamlOptions | null = {}) {
  // Built the way the CLI builds it: a fallback user, then the default seed and the seed config.
  const { app, store } = createServer(slackPlugin, {
    baseUrl: base,
    fallbackUser: { login: "U000000001", id: 1, scopes: [] },
  });
  slackPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    team: {
      name: "Acme",
      domain: "acme",
      ...(saml
        ? { saml: { endpoint_url: idpUrl, idp_issuer: idpIssuer, public_certificate: idpKey.certificate, ...saml } }
        : {}),
    },
    users: [
      { name: "alice", email: "alice@acme.test" },
      { name: "olivia", email: "olivia@acme.test", is_owner: true },
      { name: "gina", email: "gina@acme.test", is_restricted: true },
    ],
    oauth_apps: [{ client_id: "client-1", client_secret: "secret-1", name: "Acme Bot", redirect_uris: [redirectUri] }],
  });
  return { app, store };
}

function userId(store: ReturnType<typeof createTestApp>["store"], name: string): string {
  return getSlackStore(store).users.findOneBy("name", name)!.user_id;
}

function hiddenField(html: string, name: string): string | null {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  return match
    ? match[1]
        .replace(/&#x2F;|&#47;/g, "/")
        .replace(/&#x3D;|&#61;/g, "=")
        .replace(/&#x3F;|&#63;/g, "?")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
    : null;
}

async function startSso(app: Hono, redir?: string): Promise<{ html: string; requestId: string; request: Element }> {
  const query = redir ? `?redir=${encodeURIComponent(redir)}` : "";
  const res = await app.request(`${base}/sso/saml/start${query}`);
  expect(res.status).toBe(200);
  const html = await res.text();
  const samlRequest = hiddenField(html, "SAMLRequest");
  expect(samlRequest).not.toBeNull();
  const doc = new DOMParser().parseFromString(Buffer.from(samlRequest!, "base64").toString("utf8"), "text/xml");
  const request = doc.documentElement!;
  return { html, requestId: request.getAttribute("ID")!, request };
}

interface ResponseOptions {
  requestId?: string | null;
  nameId?: string;
  nameIdFormat?: string;
  nameQualifier?: string;
  spNameQualifier?: string;
  email?: string | null;
  username?: string;
  firstName?: string;
  lastName?: string;
  audience?: string;
  recipient?: string;
  destination?: string;
  issuer?: string;
  version?: string;
  notBefore?: Date;
  notOnOrAfter?: Date;
  omitNotOnOrAfter?: "confirmation" | "conditions" | "both";
  assertionId?: string;
  sign?: "response" | "assertion" | "both" | "none";
  key?: TestKey;
}

function attribute(name: string, value: string | undefined | null): string {
  if (value === undefined || value === null) return "";
  return (
    `<saml:Attribute Name="${name}" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:unspecified">` +
    `<saml:AttributeValue>${value}</saml:AttributeValue></saml:Attribute>`
  );
}

function signElement(xml: string, target: "Response" | "Assertion", key: TestKey): string {
  const signer = new SignedXml({
    privateKey: key.privateKey,
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

function buildResponse(options: ResponseOptions = {}): string {
  const now = Date.now();
  const issuer = options.issuer ?? idpIssuer;
  const inResponseTo = options.requestId ? ` InResponseTo="${options.requestId}"` : "";
  const notBefore = (options.notBefore ?? new Date(now - 5 * 60 * 1000)).toISOString();
  const notOnOrAfter = (options.notOnOrAfter ?? new Date(now + 5 * 60 * 1000)).toISOString();
  const issueInstant = new Date(now).toISOString();
  const qualifiers =
    (options.nameQualifier ? ` NameQualifier="${options.nameQualifier}"` : "") +
    (options.spNameQualifier ? ` SPNameQualifier="${options.spNameQualifier}"` : "");
  const version = options.version ?? "2.0";
  const omit = options.omitNotOnOrAfter;
  const confirmationLimit = omit === "confirmation" || omit === "both" ? "" : ` NotOnOrAfter="${notOnOrAfter}"`;
  const conditionsLimit = omit === "conditions" || omit === "both" ? "" : ` NotOnOrAfter="${notOnOrAfter}"`;
  const xml =
    `<samlp:Response xmlns:samlp="${SAMLP_NS}" xmlns:saml="${SAML_NS}" ID="_response1" Version="${version}"` +
    ` IssueInstant="${issueInstant}" Destination="${options.destination ?? acsUrl}"${inResponseTo}>` +
    `<saml:Issuer>${issuer}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    `<saml:Assertion ID="${options.assertionId ?? `_a${Math.random().toString(16).slice(2)}`}" Version="${version}" IssueInstant="${issueInstant}">` +
    `<saml:Issuer>${issuer}</saml:Issuer>` +
    `<saml:Subject>` +
    `<saml:NameID Format="${options.nameIdFormat ?? PERSISTENT}"${qualifiers}>${options.nameId ?? "00u-alice"}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
    `<saml:SubjectConfirmationData${inResponseTo}${confirmationLimit} Recipient="${options.recipient ?? acsUrl}"/>` +
    `</saml:SubjectConfirmation>` +
    `</saml:Subject>` +
    `<saml:Conditions NotBefore="${notBefore}"${conditionsLimit}>` +
    `<saml:AudienceRestriction><saml:Audience>${options.audience ?? "https://slack.com"}</saml:Audience></saml:AudienceRestriction>` +
    `</saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${issueInstant}">` +
    `<saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext>` +
    `</saml:AuthnStatement>` +
    `<saml:AttributeStatement>` +
    attribute("User.Email", options.email === undefined ? "alice@acme.test" : options.email) +
    attribute("User.Username", options.username) +
    attribute("first_name", options.firstName) +
    attribute("last_name", options.lastName) +
    `</saml:AttributeStatement>` +
    `</saml:Assertion>` +
    `</samlp:Response>`;

  const sign = options.sign ?? "response";
  const key = options.key ?? idpKey;
  if (sign === "none") return xml;
  if (sign === "assertion") return signElement(xml, "Assertion", key);
  if (sign === "response") return signElement(xml, "Response", key);
  return signElement(signElement(xml, "Assertion", key), "Response", key);
}

function consume(app: Hono, xml: string, relayState?: string) {
  const form = new URLSearchParams({ SAMLResponse: Buffer.from(xml, "utf8").toString("base64") });
  if (relayState !== undefined) form.set("RelayState", relayState);
  return app.request(acsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
}

function sessionCookie(res: Response): string {
  const match = /(_emu_slack_session=[^;]+)/.exec(res.headers.get("Set-Cookie") ?? "");
  expect(match).not.toBeNull();
  return match![1];
}

async function expectRefused(res: Response, status: number, message: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("Set-Cookie")).toBeNull();
  const html = await res.text();
  expect(html).toContain("SAML sign-in failed");
  expect(html).toContain(message);
}

const authorizePath = `/oauth/v2/authorize?client_id=client-1&redirect_uri=${encodeURIComponent(redirectUri)}&scope=chat:write&user_scope=users:read&state=xyz`;

function authorizeCallback(app: Hono, user_id: string, cookie?: string) {
  return app.request(`${base}/oauth/v2/authorize/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { Cookie: cookie } : {}) },
    body: new URLSearchParams({
      user_id,
      redirect_uri: redirectUri,
      scope: "chat:write",
      user_scope: "users:read",
      state: "xyz",
      client_id: "client-1",
    }),
  });
}

async function signInWithSaml(app: Hono, redir?: string, options: ResponseOptions = {}) {
  const { requestId } = await startSso(app, redir);
  const res = await consume(app, buildResponse({ requestId, ...options }));
  return { res, cookie: sessionCookie(res) };
}

describe("Slack workspace SAML single sign-on", () => {
  describe("SP-initiated sign-in", () => {
    it("posts an AuthnRequest from https://slack.com to the identity provider with the HTTP-POST binding", async () => {
      const { app } = createTestApp();
      const { html, request } = await startSso(app, "/oauth/v2/authorize?client_id=client-1");

      expect(html).toContain(`action="${idpUrl}"`);
      expect(hiddenField(html, "RelayState")).toBe("/oauth/v2/authorize?client_id=client-1");
      expect(request.localName).toBe("AuthnRequest");
      expect(request.getAttribute("Destination")).toBe(idpUrl);
      expect(request.getAttribute("AssertionConsumerServiceURL")).toBe(acsUrl);
      expect(request.getAttribute("ProtocolBinding")).toBe("urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST");
      expect(request.getElementsByTagNameNS(SAML_NS, "Issuer")[0].textContent).toBe("https://slack.com");
    });

    it("is not served for a workspace without SAML", async () => {
      const { app } = createTestApp(null);
      expect((await app.request(`${base}/sso/saml/start`)).status).toBe(404);
      expect((await consume(app, buildResponse())).status).toBe(404);
    });
  });

  describe("assertion consumer service", () => {
    it("opens a web session for the member with the User.Email address and returns to the requested page", async () => {
      const { app, store } = createTestApp();
      const { res, cookie } = await signInWithSaml(app, "/oauth/v2/authorize?client_id=client-1");

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/oauth/v2/authorize?client_id=client-1");
      expect(res.headers.get("Set-Cookie")).toContain("HttpOnly");

      const page = await app.request(`${base}${authorizePath}`, { headers: { Cookie: cookie } });
      const html = await page.text();
      expect(html).toContain(`value="${userId(store, "alice")}"`);
      expect(html).not.toContain(`value="${userId(store, "olivia")}"`);
    });

    it("accepts an identity provider initiated response and follows a local RelayState", async () => {
      const { app } = createTestApp();
      const res = await consume(app, buildResponse({ requestId: null }), "/oauth/v2/authorize?client_id=client-1");
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/oauth/v2/authorize?client_id=client-1");
      sessionCookie(res);

      const offsite = await consume(app, buildResponse({ requestId: null }), "https://evil.test/");
      expect(offsite.status).toBe(200);
      expect(await offsite.text()).toContain("You are signed in to <strong>Acme</strong> as <strong>alice</strong>");
    });

    it("does not redirect to another host from RelayState or redir", async () => {
      const { app } = createTestApp();
      for (const relayState of [
        "/\t/evil.test/",
        "/ /evil.test",
        "//evil.test",
        "/\\evil.test",
        "/a/..//evil.test/",
        "/a/../..//evil.test/",
      ]) {
        const res = await consume(app, buildResponse({ requestId: null }), relayState);
        expect(res.status, relayState).toBe(200);
        expect(res.headers.get("Location"), relayState).toBeNull();

        const { html } = await startSso(app, relayState);
        expect(hiddenField(html, "RelayState"), relayState).toBeNull();
      }
    });

    it("refuses a response sent with the HTTP-Redirect binding", async () => {
      const { app } = createTestApp();
      const res = await app.request(`${acsUrl}?SAMLResponse=abc`);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("was not sent through a HTTP_POST Binding");
    });

    it("refuses an unsigned response", async () => {
      const { app } = createTestApp();
      const { requestId } = await startSso(app);
      await expectRefused(
        await consume(app, buildResponse({ requestId, sign: "none" })),
        403,
        "Neither the SAML Response nor Assertion of the SAML Response are signed.",
      );
    });

    it("requires the Response signature unless Responses Signed is unchecked", async () => {
      const { app } = createTestApp();
      const { requestId } = await startSso(app);
      await expectRefused(
        await consume(app, buildResponse({ requestId, sign: "assertion" })),
        403,
        "The SAML Response is not signed.",
      );

      const lenient = createTestApp({ responses_signed: false });
      const second = await startSso(lenient.app);
      const res = await consume(lenient.app, buildResponse({ requestId: second.requestId, sign: "assertion" }));
      expect(res.status).toBe(200);
    });

    it("requires the Assertion signature when Assertions Signed is checked", async () => {
      const { app } = createTestApp({ assertions_signed: true });
      const first = await startSso(app);
      await expectRefused(
        await consume(app, buildResponse({ requestId: first.requestId, sign: "response" })),
        403,
        "The Assertion of the SAML Response is not signed.",
      );
      const second = await startSso(app);
      expect((await consume(app, buildResponse({ requestId: second.requestId, sign: "both" }))).status).toBe(200);
    });

    it("refuses a response signed by another key", async () => {
      const { app } = createTestApp();
      const { requestId } = await startSso(app);
      await expectRefused(
        await consume(app, buildResponse({ requestId, key: otherKey })),
        403,
        "it looks like the signature validation failed",
      );
    });

    it("refuses an assertion changed after signing", async () => {
      const { app } = createTestApp();
      const { requestId } = await startSso(app);
      const tampered = buildResponse({ requestId }).replace("alice@acme.test", "olivia@acme.test");
      await expectRefused(await consume(app, tampered), 403, "it looks like the signature validation failed");
    });

    it("refuses another identity provider issuer", async () => {
      const { app } = createTestApp();
      const { requestId } = await startSso(app);
      await expectRefused(
        await consume(app, buildResponse({ requestId, issuer: "http://www.okta.com/other" })),
        403,
        "does not contain the correct Identity Provider Issuer",
      );
    });

    it("refuses an audience other than https://slack.com", async () => {
      const { app } = createTestApp();
      const { requestId } = await startSso(app);
      await expectRefused(
        await consume(app, buildResponse({ requestId, audience: "https://other.example" })),
        403,
        "does not contain the correct Audience",
      );
    });

    it("refuses a wrong recipient", async () => {
      const { app } = createTestApp();
      const { requestId } = await startSso(app);
      await expectRefused(
        await consume(app, buildResponse({ requestId, recipient: "https://other.example/sso/saml" })),
        403,
        "does not contain the correct Recipient",
      );
    });

    it("refuses a wrong destination", async () => {
      const { app } = createTestApp();
      const { requestId } = await startSso(app);
      await expectRefused(
        await consume(app, buildResponse({ requestId, destination: "https://other.example/sso/saml" })),
        403,
        `does not contain the correct Destination, which should look something like ${acsUrl}`,
      );
    });

    it("refuses an expired response and one not valid yet", async () => {
      const { app } = createTestApp();
      const first = await startSso(app);
      const past = new Date(Date.now() - 60 * 1000);
      await expectRefused(
        await consume(
          app,
          buildResponse({ requestId: first.requestId, notBefore: new Date(Date.now() - 600000), notOnOrAfter: past }),
        ),
        403,
        "The SAML Response has expired.",
      );
      const second = await startSso(app);
      await expectRefused(
        await consume(app, buildResponse({ requestId: second.requestId, notBefore: new Date(Date.now() + 60000) })),
        403,
        "The SAML Response is not valid yet.",
      );
    });

    it("refuses a bearer confirmation without NotOnOrAfter", async () => {
      const { app } = createTestApp();
      for (const omitNotOnOrAfter of ["confirmation", "both"] as const) {
        const { requestId } = await startSso(app);
        await expectRefused(
          await consume(app, buildResponse({ requestId, omitNotOnOrAfter })),
          403,
          "The SAML Response does not limit when it can be delivered",
        );
      }
      const { requestId } = await startSso(app);
      const res = await consume(app, buildResponse({ requestId, omitNotOnOrAfter: "conditions" }));
      expect(res.status).toBe(200);
    });

    it("refuses a response to a request the emulator never sent, or already answered", async () => {
      const { app } = createTestApp();
      await expectRefused(
        await consume(app, buildResponse({ requestId: "_unknown" })),
        403,
        "does not answer a sign-in request from Slack",
      );

      const { requestId } = await startSso(app);
      expect((await consume(app, buildResponse({ requestId }))).status).toBe(200);
      await expectRefused(
        await consume(app, buildResponse({ requestId })),
        403,
        "does not answer a sign-in request from Slack",
      );
    });

    it("refuses an identity provider initiated assertion replayed", async () => {
      const { app } = createTestApp();
      const xml = buildResponse({ requestId: null, assertionId: "_replayed" });
      expect((await consume(app, xml)).status).toBe(200);
      await expectRefused(await consume(app, xml), 403, "This SAML Response has already been used.");
    });

    it("refuses a response without User.Email", async () => {
      const { app } = createTestApp();
      const { requestId } = await startSso(app);
      await expectRefused(
        await consume(app, buildResponse({ requestId, email: null })),
        403,
        "missing the User.Email attribute",
      );
    });

    it("requires a persistent NameID", async () => {
      const { app } = createTestApp();
      const { requestId } = await startSso(app);
      await expectRefused(
        await consume(
          app,
          buildResponse({ requestId, nameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress" }),
        ),
        403,
        "The SAML Response is missing the ID attribute.",
      );
    });

    it("accepts the documented NameQualifier and SPNameQualifier and refuses other values", async () => {
      const { app } = createTestApp();
      const first = await startSso(app);
      const accepted = await consume(
        app,
        buildResponse({
          requestId: first.requestId,
          nameQualifier: "ACME.slack.com",
          spNameQualifier: "https://slack.com",
        }),
      );
      expect(accepted.status).toBe(200);

      const second = await startSso(app);
      await expectRefused(
        await consume(app, buildResponse({ requestId: second.requestId, nameQualifier: "other.slack.com" })),
        403,
        "The NameQualifier of the NameID must be acme.slack.com.",
      );
      const third = await startSso(app);
      await expectRefused(
        await consume(app, buildResponse({ requestId: third.requestId, spNameQualifier: "https://other.example" })),
        403,
        "The SPNameQualifier of the NameID must be https://slack.com.",
      );
    });

    it("refuses a response that is not SAML 2.0", async () => {
      const { app } = createTestApp();
      const { requestId } = await startSso(app);
      await expectRefused(
        await consume(app, buildResponse({ requestId, version: "1.1" })),
        400,
        "The SAML Response is not version 2.0.",
      );
    });
  });

  describe("member mapping", () => {
    it("links the NameID to the member on first sign-in and keeps it", async () => {
      const { app, store } = createTestApp();
      await signInWithSaml(app, undefined, { nameId: "00u-alice" });

      // The linked NameID signs in the same member, and another NameID cannot take the account.
      const { res, cookie } = await signInWithSaml(app, authorizePath, {
        nameId: "00u-alice",
        email: "renamed@acme.test",
      });
      expect(res.status).toBe(302);
      const page = await (await app.request(`${base}${authorizePath}`, { headers: { Cookie: cookie } })).text();
      expect(page).toContain(`value="${userId(store, "alice")}"`);

      const { requestId } = await startSso(app);
      await expectRefused(
        await consume(app, buildResponse({ requestId, nameId: "00u-intruder" })),
        403,
        "already linked to another identity",
      );
    });

    it("creates a member Just In Time for an unknown email address", async () => {
      const { app, store } = createTestApp();
      const before = getSlackStore(store).users.all().length;
      const { res } = await signInWithSaml(app, undefined, {
        nameId: "00u-new",
        email: "new.hire@acme.test",
        username: "newhire",
        firstName: "New",
        lastName: "Hire",
      });
      expect(res.status).toBe(200);

      const users = getSlackStore(store).users.all();
      expect(users).toHaveLength(before + 1);
      const created = users.find((user) => user.email === "new.hire@acme.test")!;
      expect(created).toMatchObject({ name: "newhire", real_name: "New Hire", is_admin: false, is_bot: false });
      expect(created.profile).toMatchObject({ first_name: "New", last_name: "Hire", email: "new.hire@acme.test" });

      await signInWithSaml(app, undefined, { nameId: "00u-new", email: "new.hire@acme.test" });
      expect(getSlackStore(store).users.all()).toHaveLength(before + 1);
    });
  });

  describe("OAuth authorization", () => {
    it("with SSO required, signs in with SAML first and authorizes the signed-in member", async () => {
      const { app, store } = createTestApp({ sso_requirement: "required" });
      const alice = userId(store, "alice");

      const page = await app.request(`${base}${authorizePath}`);
      const html = await page.text();
      expect(html).toContain('action="/sso/saml/start"');
      expect(hiddenField(html, "redir")).toBe(authorizePath);
      expect(html).not.toContain(`value="${alice}"`);
      expect((await authorizeCallback(app, alice)).status).toBe(403);

      const { res, cookie } = await signInWithSaml(app, hiddenField(html, "redir")!);
      expect(res.headers.get("Location")).toBe(authorizePath);
      const signedIn = await (await app.request(`${base}${authorizePath}`, { headers: { Cookie: cookie } })).text();
      expect(signedIn).toContain(`value="${alice}"`);
      expect(signedIn).not.toContain('action="/sso/saml/start"');

      expect((await authorizeCallback(app, userId(store, "gina"), cookie)).status).toBe(403);
      const callback = await authorizeCallback(app, alice, cookie);
      expect(callback.status).toBe(302);
      const code = new URL(callback.headers.get("Location")!).searchParams.get("code")!;
      const token = await app.request(`${base}/api/oauth.v2.access`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: "client-1",
          client_secret: "secret-1",
          redirect_uri: redirectUri,
        }),
      });
      const body = (await token.json()) as { ok: boolean; authed_user: { id: string } };
      expect(body.ok).toBe(true);
      expect(body.authed_user.id).toBe(alice);
    });

    it("with SSO required, lets Workspace Owners sign in without SSO", async () => {
      const { app, store } = createTestApp({ sso_requirement: "required" });
      const olivia = userId(store, "olivia");
      const html = await (await app.request(`${base}${authorizePath}`)).text();
      expect(html).toContain(`value="${olivia}"`);
      expect(html).not.toContain(`value="${userId(store, "gina")}"`);
      expect((await authorizeCallback(app, olivia)).status).toBe(302);
    });

    it("with SSO required except guests, lets guests and owners sign in without SSO", async () => {
      const { app, store } = createTestApp({ sso_requirement: "required_except_guests" });
      const html = await (await app.request(`${base}${authorizePath}`)).text();
      expect(html).toContain(`value="${userId(store, "gina")}"`);
      expect(html).toContain(`value="${userId(store, "olivia")}"`);
      expect(html).not.toContain(`value="${userId(store, "alice")}"`);
      expect((await authorizeCallback(app, userId(store, "gina"))).status).toBe(302);
      expect((await authorizeCallback(app, userId(store, "alice"))).status).toBe(403);
    });

    it("with SSO optional, keeps the picker and offers SAML sign-in", async () => {
      const { app, store } = createTestApp({ sso_requirement: "optional" });
      const html = await (await app.request(`${base}${authorizePath}`)).text();
      expect(html).toContain('action="/sso/saml/start"');
      for (const name of ["admin", "alice", "olivia", "gina"]) expect(html).toContain(`value="${userId(store, name)}"`);
      expect((await authorizeCallback(app, userId(store, "alice"))).status).toBe(302);
    });

    it("keeps the picker unchanged for a workspace without SAML", async () => {
      const { app, store } = createTestApp(null);
      const html = await (await app.request(`${base}${authorizePath}`)).text();
      expect(html).not.toContain("/sso/saml/start");
      expect(html).toContain(`value="${userId(store, "alice")}"`);
      expect((await authorizeCallback(app, userId(store, "alice"))).status).toBe(302);
    });
  });
});
