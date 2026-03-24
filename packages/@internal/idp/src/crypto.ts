import "reflect-metadata";
import { createHash, generateKeyPairSync, createPublicKey, randomBytes, webcrypto } from "crypto";
import type { Store } from "@internal/core";
import { SignJWT, importPKCS8 } from "jose";
import type { IdpUser } from "./entities.js";
import type { IdpSigningKey } from "./entities.js";

export function generateSigningKeySync(kid?: string): Omit<IdpSigningKey, "id" | "created_at" | "updated_at"> {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const pubKeyObj = createPublicKey(publicKey as string);
  const jwk = pubKeyObj.export({ format: "jwk" }) as Record<string, unknown>;
  const resolvedKid = kid ?? `emulate-${randomBytes(8).toString("hex")}`;

  return {
    kid: resolvedKid,
    alg: "RS256",
    private_key_pem: privateKey as string,
    public_key_jwk: { ...jwk, kid: resolvedKid, alg: "RS256", use: "sig" },
    active: true,
  };
}

export function importSigningKey(
  pem: string,
  kid?: string,
  alg = "RS256",
): Omit<IdpSigningKey, "id" | "created_at" | "updated_at"> {
  const pubKeyObj = createPublicKey(pem);
  const jwk = pubKeyObj.export({ format: "jwk" }) as Record<string, unknown>;
  const resolvedKid = kid ?? `emulate-${randomBytes(8).toString("hex")}`;

  return {
    kid: resolvedKid,
    alg,
    private_key_pem: pem,
    public_key_jwk: { ...jwk, kid: resolvedKid, alg, use: "sig" },
    active: true,
  };
}

export function resolvePath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export async function createIdToken(
  user: IdpUser,
  clientId: string,
  nonce: string | null,
  issuer: string,
  signingKey: Pick<IdpSigningKey, "kid" | "private_key_pem">,
  ttl: number,
  claimMappings: Record<string, string>,
): Promise<string> {
  const key = await importPKCS8(signingKey.private_key_pem, "RS256");

  const claims: Record<string, unknown> = {
    sub: user.uid,
    email: user.email,
    email_verified: user.email_verified,
    name: user.name,
    given_name: user.given_name,
    family_name: user.family_name,
    picture: user.picture,
    locale: user.locale,
    ...(nonce ? { nonce } : {}),
  };

  for (const [claimName, path] of Object.entries(claimMappings)) {
    const value = resolvePath(user, path);
    if (value !== undefined) {
      claims[claimName] = value;
    }
  }

  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: signingKey.kid, typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(clientId)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(key);
}

export function verifyPkce(
  codeVerifier: string,
  codeChallenge: string,
  method: string,
): boolean {
  const m = method.toLowerCase();
  if (m === "s256") {
    const expected = createHash("sha256").update(codeVerifier).digest("base64url");
    return expected === codeChallenge;
  }
  if (m === "plain") {
    return codeVerifier === codeChallenge;
  }
  return false;
}

export async function generateSelfSignedCert(privateKeyPem: string): Promise<string> {
  // Import the private key as a CryptoKey for @peculiar/x509
  const { X509CertificateGenerator, Extension } = await import("@peculiar/x509");

  // Set the crypto provider to Node's webcrypto
  const x509Module = await import("@peculiar/x509");
  x509Module.cryptoProvider.set(webcrypto as unknown as Crypto);

  // Import the RSA key pair
  const privateKeyDer = pemToDer(privateKeyPem);
  const cryptoPrivateKey = await webcrypto.subtle.importKey(
    "pkcs8",
    privateKeyDer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    true,
    ["sign"]
  );

  // Extract public key from private
  const publicKeyJwk = await webcrypto.subtle.exportKey("jwk", cryptoPrivateKey);
  delete publicKeyJwk.d;
  delete publicKeyJwk.p;
  delete publicKeyJwk.q;
  delete publicKeyJwk.dp;
  delete publicKeyJwk.dq;
  delete publicKeyJwk.qi;
  publicKeyJwk.key_ops = ["verify"];
  const cryptoPublicKey = await webcrypto.subtle.importKey(
    "jwk",
    publicKeyJwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    true,
    ["verify"]
  );

  const now = new Date();
  const notAfter = new Date(now);
  notAfter.setFullYear(notAfter.getFullYear() + 10);

  const cert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=emulate-idp",
    notBefore: now,
    notAfter,
    signingAlgorithm: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    keys: { privateKey: cryptoPrivateKey, publicKey: cryptoPublicKey },
    extensions: [
      new Extension("2.5.29.19", true, new Uint8Array([0x30, 0x00])), // Basic Constraints: CA=false
    ],
  });

  return cert.toString("pem");
}

function pemToDer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s/g, "");
  const binary = Buffer.from(base64, "base64");
  return binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength);
}

export function getPublicCertBase64(certPem: string): string {
  return certPem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s/g, "");
}

export function getCertificatePem(store: Store): string | null {
  return store.getData<string>("idp.saml.certificatePem") ?? null;
}
