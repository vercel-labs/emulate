import { afterEach, describe, expect, it, vi } from "vitest";
import { DOMParser, type Element } from "@xmldom/xmldom";
import { SignedXml } from "xml-crypto";
import { createServer, type Hono } from "@emulators/core";
import { googlePlugin, seedFromConfig, type GoogleSsoProfileSeed } from "../index.js";

const base = "http://localhost:4000";
const entityId = `${base}/samlrp/okta`;
const acsUrl = `${base}/samlrp/okta/acs`;
const idpUrl = "http://localhost:4100/app/google/exk1/sso/saml";
const SAMLP_NS = "urn:oasis:names:tc:SAML:2.0:protocol";
const SAML_NS = "urn:oasis:names:tc:SAML:2.0:assertion";
const EMAIL_FORMAT = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";
const client = { client_id: "google-client", client_secret: "google-secret" };
const redirectUri = "http://localhost:3000/callback";

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

function createTestApp(profiles: GoogleSsoProfileSeed[] | null = null) {
  const users = [
    { email: "alice@acme.test", name: "Alice" },
    { email: "bob@acme.test", name: "Bob" },
    { email: "carol@acme.test", name: "Carol" },
    { email: "root@acme.test", name: "Root", is_admin: true },
  ];
  // Built the way the CLI builds it: a fallback user, then the default seed and the seed config.
  const { app, store } = createServer(googlePlugin, {
    baseUrl: base,
    fallbackUser: { login: users[0].email, id: 1, scopes: ["openid", "email", "profile"] },
  });
  googlePlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users,
    oauth_clients: [{ ...client, redirect_uris: [redirectUri] }],
    sso_profiles: profiles ?? [
      {
        id: "okta",
        name: "Okta",
        idp_entity_id: "http://www.okta.com/exk1",
        sign_in_page_url: idpUrl,
        certificates: [idpKey.certificate],
        users: ["alice@acme.test", "root@acme.test"],
      },
      {
        id: "other",
        sign_in_page_url: "http://localhost:4200/sso",
        certificates: [otherKey.certificate],
        users: ["bob@acme.test"],
      },
    ],
  });
  return { app, store };
}

function hiddenField(html: string, name: string): string | null {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  return match ? match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&") : null;
}

function authorizeCallback(app: Hono, email: string, cookie?: string) {
  return app.request(`${base}/o/oauth2/v2/auth/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { Cookie: cookie } : {}) },
    body: new URLSearchParams({
      email,
      redirect_uri: redirectUri,
      scope: "openid email profile",
      state: "xyz",
      client_id: client.client_id,
    }),
  });
}

const authorizePath = `/o/oauth2/v2/auth?client_id=${client.client_id}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=openid+email+profile&state=xyz`;

async function startSso(app: Hono, email = "alice@acme.test") {
  const res = await authorizeCallback(app, email);
  expect(res.status).toBe(200);
  const html = await res.text();
  const samlRequest = hiddenField(html, "SAMLRequest");
  expect(samlRequest).not.toBeNull();
  const xml = Buffer.from(samlRequest!, "base64").toString("utf8");
  const request = new DOMParser().parseFromString(xml, "text/xml").documentElement as Element;
  return { html, xml, request, requestId: request.getAttribute("ID")! };
}

interface ResponseOptions {
  requestId?: string | null;
  nameId?: string;
  nameIdFormat?: string;
  audience?: string;
  recipient?: string;
  destination?: string | null;
  notBefore?: Date;
  notOnOrAfter?: Date;
  assertionId?: string;
  sign?: "response" | "assertion" | "both" | "none";
  key?: TestKey;
  signatureAlgorithm?: string;
}

function signElement(xml: string, target: "Response" | "Assertion", key: TestKey, signatureAlgorithm: string): string {
  const signer = new SignedXml({
    privateKey: key.privateKey,
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
    signatureAlgorithm,
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
  const issuer = "http://www.okta.com/exk1";
  const inResponseTo = options.requestId ? ` InResponseTo="${options.requestId}"` : "";
  const notBefore = (options.notBefore ?? new Date(now - 5 * 60 * 1000)).toISOString();
  const notOnOrAfter = (options.notOnOrAfter ?? new Date(now + 5 * 60 * 1000)).toISOString();
  const issueInstant = new Date(now).toISOString();
  const destination = options.destination === null ? "" : ` Destination="${options.destination ?? acsUrl}"`;
  const xml =
    `<samlp:Response xmlns:samlp="${SAMLP_NS}" xmlns:saml="${SAML_NS}" ID="_response1" Version="2.0"` +
    ` IssueInstant="${issueInstant}"${destination}${inResponseTo}>` +
    `<saml:Issuer>${issuer}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    `<saml:Assertion ID="${options.assertionId ?? `_a${Math.random().toString(16).slice(2)}`}" Version="2.0" IssueInstant="${issueInstant}">` +
    `<saml:Issuer>${issuer}</saml:Issuer>` +
    `<saml:Subject>` +
    `<saml:NameID Format="${options.nameIdFormat ?? EMAIL_FORMAT}">${options.nameId ?? "alice@acme.test"}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
    `<saml:SubjectConfirmationData${inResponseTo} NotOnOrAfter="${notOnOrAfter}" Recipient="${options.recipient ?? acsUrl}"/>` +
    `</saml:SubjectConfirmation>` +
    `</saml:Subject>` +
    `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">` +
    `<saml:AudienceRestriction><saml:Audience>${options.audience ?? entityId}</saml:Audience></saml:AudienceRestriction>` +
    `</saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${issueInstant}">` +
    `<saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext>` +
    `</saml:AuthnStatement>` +
    `</saml:Assertion>` +
    `</samlp:Response>`;

  const sign = options.sign ?? "assertion";
  const key = options.key ?? idpKey;
  const algorithm = options.signatureAlgorithm ?? "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
  if (sign === "none") return xml;
  if (sign === "assertion") return signElement(xml, "Assertion", key, algorithm);
  if (sign === "response") return signElement(xml, "Response", key, algorithm);
  return signElement(signElement(xml, "Assertion", key, algorithm), "Response", key, algorithm);
}

function consume(app: Hono, xml: string, url = acsUrl) {
  return app.request(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ SAMLResponse: Buffer.from(xml, "utf8").toString("base64"), RelayState: "relay" }),
  });
}

function sessionCookie(res: Response): string {
  const match = /(_emu_google_session=[^;]+)/.exec(res.headers.get("Set-Cookie") ?? "");
  expect(match).not.toBeNull();
  return match![1];
}

async function expectRefused(res: Response, message: string, status = 403) {
  expect(res.status).toBe(status);
  expect(res.headers.get("Set-Cookie")).toBeNull();
  const html = await res.text();
  expect(html).toContain("SAML sign-in failed");
  expect(html).toContain(message);
}

async function signInWithSaml(app: Hono, options: ResponseOptions = {}) {
  const { requestId } = await startSso(app);
  const res = await consume(app, buildResponse({ requestId, ...options }));
  expect(res.status).toBe(302);
  return { res, cookie: sessionCookie(res) };
}

function expectCode(res: Response) {
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("Location")!);
  expect(`${location.origin}${location.pathname}`).toBe(redirectUri);
  expect(location.searchParams.get("state")).toBe("xyz");
  return location.searchParams.get("code")!;
}

async function exchange(app: Hono, code: string) {
  const res = await app.request(`${base}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...client, grant_type: "authorization_code", code, redirect_uri: redirectUri }),
  });
  expect(res.status).toBe(200);
  const { access_token } = (await res.json()) as { access_token: string };
  const userinfo = await app.request(`${base}/oauth2/v2/userinfo`, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  return ((await userinfo.json()) as { email: string }).email;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Google Workspace SAML single sign-on", () => {
  describe("SP-initiated sign-in", () => {
    it("posts an unsigned AuthnRequest from the profile's entity ID to the sign-in page URL with the HTTP POST binding", async () => {
      const { app } = createTestApp();
      const { html, xml, request } = await startSso(app);

      expect(html).toContain(`action="${idpUrl}"`);
      expect(html).toContain('method="POST"');
      expect(hiddenField(html, "RelayState")).toMatch(/^[0-9a-f]{32}$/);
      expect(request.namespaceURI).toBe(SAMLP_NS);
      expect(request.localName).toBe("AuthnRequest");
      expect(request.getAttribute("Version")).toBe("2.0");
      expect(request.getAttribute("ID")).toMatch(/^_[0-9a-f]{40}$/);
      expect(request.getAttribute("Destination")).toBe(idpUrl);
      expect(request.getAttribute("AssertionConsumerServiceURL")).toBe(acsUrl);
      expect(request.getAttribute("ProtocolBinding")).toBe("urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST");
      expect(request.getElementsByTagNameNS(SAML_NS, "Issuer")[0].textContent).toBe(entityId);
      expect(xml).not.toContain("Signature");
    });

    it("uses each profile's own entity ID, ACS URL and sign-in page URL", async () => {
      const { app } = createTestApp();
      const { html, request } = await startSso(app, "bob@acme.test");

      expect(html).toContain('action="http://localhost:4200/sso"');
      expect(request.getAttribute("AssertionConsumerServiceURL")).toBe(`${base}/samlrp/other/acs`);
      expect(request.getElementsByTagNameNS(SAML_NS, "Issuer")[0].textContent).toBe(`${base}/samlrp/other`);
    });
  });

  describe("ACS", () => {
    it("opens a 14-day web session and returns to the authorization page, which then authorizes the signed-in user", async () => {
      const { app } = createTestApp();
      const { res, cookie } = await signInWithSaml(app);

      expect(res.headers.get("Location")).toBe(authorizePath);
      expect(res.headers.get("Set-Cookie")).toContain("Max-Age=1209600");
      expect(res.headers.get("Set-Cookie")).toContain("HttpOnly");

      const page = await app.request(`${base}${authorizePath}`, { headers: { Cookie: cookie } });
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("alice@acme.test");
      expect(html).not.toContain("carol@acme.test");
      expect(html).not.toContain("root@acme.test");

      const code = expectCode(await authorizeCallback(app, "alice@acme.test", cookie));
      expect(await exchange(app, code)).toBe("alice@acme.test");
    });

    it("accepts an assertion covered by a signed response, or signed twice", async () => {
      for (const sign of ["response", "both"] as const) {
        const { app } = createTestApp();
        const { cookie } = await signInWithSaml(app, { sign });
        expect(expectCode(await authorizeCallback(app, "alice@acme.test", cookie))).toBeTruthy();
      }
    });

    it("accepts a response without a Destination, which is optional", async () => {
      const { app } = createTestApp();
      await signInWithSaml(app, { destination: null });
    });

    it("accepts the profile's second certificate", async () => {
      const { app } = createTestApp([
        {
          id: "okta",
          sign_in_page_url: idpUrl,
          certificates: [otherKey.certificate, idpKey.certificate],
          users: ["alice@acme.test"],
        },
      ]);
      await signInWithSaml(app);
    });

    it("ends the web session after 14 days", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const { app } = createTestApp();
      const { cookie } = await signInWithSaml(app);

      vi.setSystemTime(Date.now() + 14 * 24 * 60 * 60 * 1000 - 1000);
      expectCode(await authorizeCallback(app, "alice@acme.test", cookie));

      vi.setSystemTime(Date.now() + 2000);
      const page = await (await app.request(`${base}${authorizePath}`, { headers: { Cookie: cookie } })).text();
      expect(page).toContain("carol@acme.test");
      const again = await authorizeCallback(app, "alice@acme.test", cookie);
      expect(again.status).toBe(200);
      expect(hiddenField(await again.text(), "SAMLRequest")).not.toBeNull();
    });

    describe("refuses", () => {
      it("an unsigned response", async () => {
        const { app } = createTestApp();
        const { requestId } = await startSso(app);
        await expectRefused(await consume(app, buildResponse({ requestId, sign: "none" })), "is not signed");
      });

      it("a response signed with another key", async () => {
        const { app } = createTestApp();
        const { requestId } = await startSso(app);
        await expectRefused(await consume(app, buildResponse({ requestId, key: otherKey })), "is not signed");
      });

      it("a signature that is not RSA-SHA256", async () => {
        const { app } = createTestApp();
        const { requestId } = await startSso(app);
        const xml = buildResponse({ requestId, signatureAlgorithm: "http://www.w3.org/2000/09/xmldsig#rsa-sha1" });
        await expectRefused(await consume(app, xml), "RSA-SHA256");
      });

      it("a tampered assertion", async () => {
        const { app } = createTestApp();
        const { requestId } = await startSso(app);
        const xml = buildResponse({ requestId }).replace(">alice@acme.test<", ">bob@acme.test<");
        await expectRefused(await consume(app, xml), "is not signed");
      });

      it("another audience", async () => {
        const { app } = createTestApp();
        const { requestId } = await startSso(app);
        await expectRefused(await consume(app, buildResponse({ requestId, audience: "google.com" })), "Audience");
      });

      it("another recipient", async () => {
        const { app } = createTestApp();
        const { requestId } = await startSso(app);
        const xml = buildResponse({ requestId, recipient: `${base}/samlrp/other/acs` });
        await expectRefused(await consume(app, xml), "Recipient");
      });

      it("another destination", async () => {
        const { app } = createTestApp();
        const { requestId } = await startSso(app);
        const xml = buildResponse({ requestId, sign: "response", destination: `${base}/samlrp/other/acs` });
        await expectRefused(await consume(app, xml), "Destination");
      });

      it("an expired assertion", async () => {
        const { app } = createTestApp();
        const { requestId } = await startSso(app);
        const past = new Date(Date.now() - 60 * 1000);
        const xml = buildResponse({ requestId, notBefore: new Date(Date.now() - 10 * 60 * 1000), notOnOrAfter: past });
        await expectRefused(await consume(app, xml), "has expired");
      });

      it("a response to a request Google did not send", async () => {
        const { app } = createTestApp();
        await startSso(app);
        await expectRefused(await consume(app, buildResponse({ requestId: "_unknown" })), "did not request");
      });

      it("a response to another profile's request", async () => {
        const { app } = createTestApp();
        const { requestId } = await startSso(app, "bob@acme.test");
        await expectRefused(await consume(app, buildResponse({ requestId })), "did not request");
      });

      it("an identity-provider-initiated response", async () => {
        const { app } = createTestApp();
        await expectRefused(await consume(app, buildResponse({ requestId: null, sign: "both" })), "did not request");
      });

      it("a NameID that differs from the primary email in case", async () => {
        const { app } = createTestApp();
        const { requestId } = await startSso(app);
        await expectRefused(await consume(app, buildResponse({ requestId, nameId: "Alice@acme.test" })), "NameID");
      });

      it("the NameID of a user the profile is not assigned to", async () => {
        for (const nameId of ["bob@acme.test", "carol@acme.test", "nobody@acme.test"]) {
          const { app } = createTestApp();
          const { requestId } = await startSso(app);
          await expectRefused(await consume(app, buildResponse({ requestId, nameId })), "NameID");
        }
      });

      it("the NameID of a super administrator", async () => {
        const { app } = createTestApp();
        const { requestId } = await startSso(app);
        await expectRefused(await consume(app, buildResponse({ requestId, nameId: "root@acme.test" })), "NameID");
      });

      it("a NameID that is not in the emailAddress format", async () => {
        const { app } = createTestApp();
        const { requestId } = await startSso(app);
        const xml = buildResponse({ requestId, nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent" });
        await expectRefused(await consume(app, xml), "NameID");
      });

      it("a replayed assertion", async () => {
        const { app } = createTestApp();
        const first = await startSso(app);
        await consume(app, buildResponse({ requestId: first.requestId, assertionId: "_once" }));
        const second = await startSso(app);
        const res = await consume(app, buildResponse({ requestId: second.requestId, assertionId: "_once" }));
        await expectRefused(res, "already been used");
      });

      it("a request answered twice", async () => {
        const { app } = createTestApp();
        const { requestId } = await startSso(app);
        expect((await consume(app, buildResponse({ requestId }))).status).toBe(302);
        await expectRefused(await consume(app, buildResponse({ requestId })), "did not request");
      });

      it("a response with a DOCTYPE", async () => {
        const { app } = createTestApp();
        const { requestId } = await startSso(app);
        const xml = `<!DOCTYPE r [<!ENTITY x "y">]>${buildResponse({ requestId })}`;
        await expectRefused(await consume(app, xml), "not valid XML", 400);
      });

      it("a response posted to an unknown profile", async () => {
        const { app } = createTestApp();
        const res = await consume(app, buildResponse(), `${base}/samlrp/missing/acs`);
        expect(res.status).toBe(404);
        expect(await res.text()).toContain("There is no SSO profile with this ID.");
      });
    });
  });

  describe("authorization without SSO", () => {
    it("keeps the picker for users without a profile and for super administrators", async () => {
      const { app } = createTestApp();
      const page = await (await app.request(`${base}${authorizePath}`)).text();
      for (const email of ["alice@acme.test", "bob@acme.test", "carol@acme.test", "root@acme.test"]) {
        expect(page).toContain(email);
      }

      expect(await exchange(app, expectCode(await authorizeCallback(app, "carol@acme.test")))).toBe("carol@acme.test");
      expect(await exchange(app, expectCode(await authorizeCallback(app, "root@acme.test")))).toBe("root@acme.test");
      expect((await authorizeCallback(app, "alice@acme.test")).status).toBe(200);
    });

    it("does not authorize a user with a profile without a session, or with another user's session", async () => {
      const { app } = createTestApp();
      const { cookie } = await signInWithSaml(app);
      for (const [email, header] of [
        ["alice@acme.test", undefined],
        ["bob@acme.test", cookie],
      ] as const) {
        const res = await authorizeCallback(app, email, header);
        expect(res.status).toBe(200);
        expect(res.headers.get("Location")).toBeNull();
        expect(hiddenField(await res.text(), "SAMLRequest")).not.toBeNull();
      }
    });
  });

  describe("seed config", () => {
    it("refuses a certificate whose key is neither DSA nor RSA, and unknown or doubly assigned users", () => {
      // A self-signed P-256 certificate (openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256).
      const ec = `-----BEGIN CERTIFICATE-----
MIIBgjCCASmgAwIBAgIUBMlpMl3yOENO1VdSMk7uLt+lCwswCgYIKoZIzj0EAwIw
FjEUMBIGA1UEAwwLVGVzdCBFQyBJZFAwIBcNMjYxMTExMTkxNTA2WhgPMjEyNjEw
MTgxOTE1MDZaMBYxFDASBgNVBAMMC1Rlc3QgRUMgSWRQMFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAEYj3P9MWKtVzgAog6uEHF6olQVHZMvr44IxZ1yMqPfthM0Cis
Xqo94lVCjWsK1COXJF9sIes57mOXe1vy8PDinaNTMFEwHQYDVR0OBBYEFOmg+vNZ
h+5ZUtKwyCrtqs7zzXxdMB8GA1UdIwQYMBaAFOmg+vNZh+5ZUtKwyCrtqs7zzXxd
MA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDRwAwRAIgLtP/L6xO2AF0o8HH
yPNvwWOgm9FmqqMS9uDyOGdWBCgCIHzeImStncvEeeEHviV6M8jSCqIkqFsGDkdD
5D2Hsrwn
-----END CERTIFICATE-----`;
      const profile = { id: "okta", sign_in_page_url: idpUrl, certificates: [idpKey.certificate], users: [] };
      expect(() => createTestApp([{ ...profile, certificates: [ec] }])).toThrow(/DSA or RSA/);
      expect(() => createTestApp([{ ...profile, certificates: ["not a certificate"] }])).toThrow(/X\.509/);
      expect(() => createTestApp([{ ...profile, users: ["nobody@acme.test"] }])).toThrow(/not a seeded user/);
      expect(() =>
        createTestApp([
          { ...profile, users: ["alice@acme.test"] },
          { ...profile, id: "second", users: ["alice@acme.test"] },
        ]),
      ).toThrow(/assigned to both/);
    });
  });
});
