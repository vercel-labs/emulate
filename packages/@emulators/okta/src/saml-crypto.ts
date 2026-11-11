// Required by @peculiar/x509's tsyringe dependency injection
import "reflect-metadata";
import { generateKeyPairSync, webcrypto } from "node:crypto";
import type { Store } from "@emulators/core";

export interface SamlSigningMaterial {
  privateKeyPem: string;
  certBase64: string;
}

const SIGNING_MATERIAL_KEY = "okta.saml.signingMaterial";
const inFlight = new WeakMap<Store, Promise<SamlSigningMaterial>>();

// One signing key and certificate per emulator instance, kept in the store so snapshots preserve it.
export function getSamlSigningMaterial(store: Store): Promise<SamlSigningMaterial> {
  const existing = store.getData<SamlSigningMaterial>(SIGNING_MATERIAL_KEY);
  if (existing?.privateKeyPem && existing.certBase64) return Promise.resolve(existing);

  let pending = inFlight.get(store);
  if (!pending) {
    pending = createSigningMaterial().then((material) => {
      store.setData(SIGNING_MATERIAL_KEY, material);
      inFlight.delete(store);
      return material;
    });
    inFlight.set(store, pending);
  }
  return pending;
}

async function createSigningMaterial(): Promise<SamlSigningMaterial> {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const certPem = await generateSelfSignedCert(privateKey);
  return { privateKeyPem: privateKey, certBase64: getPublicCertBase64(certPem) };
}

export async function generateSelfSignedCert(privateKeyPem: string): Promise<string> {
  const x509 = await import("@peculiar/x509");
  x509.cryptoProvider.set(webcrypto as unknown as ReturnType<typeof x509.cryptoProvider.get>);

  const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  const cryptoPrivateKey = await webcrypto.subtle.importKey("pkcs8", pemToDer(privateKeyPem), algorithm, true, [
    "sign",
  ]);

  const publicKeyJwk = await webcrypto.subtle.exportKey("jwk", cryptoPrivateKey);
  delete publicKeyJwk.d;
  delete publicKeyJwk.p;
  delete publicKeyJwk.q;
  delete publicKeyJwk.dp;
  delete publicKeyJwk.dq;
  delete publicKeyJwk.qi;
  publicKeyJwk.key_ops = ["verify"];
  const cryptoPublicKey = await webcrypto.subtle.importKey("jwk", publicKeyJwk, algorithm, true, ["verify"]);

  const now = new Date();
  const notAfter = new Date(now);
  notAfter.setFullYear(notAfter.getFullYear() + 10);

  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=emulate-okta",
    notBefore: now,
    notAfter,
    signingAlgorithm: algorithm,
    keys: { privateKey: cryptoPrivateKey, publicKey: cryptoPublicKey },
    extensions: [
      new x509.Extension("2.5.29.19", true, new Uint8Array([0x30, 0x00])), // Basic Constraints: CA=false
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
