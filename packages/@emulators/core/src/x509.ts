import { createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";

// A minimal DER encoder for one self-signed RSA certificate. SAML metadata publishes the signing key as an
// X.509 certificate, and Node can verify certificates but not create them.

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, ...contents: Buffer[]): Buffer {
  const body = Buffer.concat(contents);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const sequence = (...items: Buffer[]) => der(0x30, ...items);

function objectIdentifier(oid: string): Buffer {
  const [first, second, ...rest] = oid.split(".").map(Number);
  const bytes = [first! * 40 + second!];
  for (const part of rest) {
    const chunk = [part & 0x7f];
    for (let value = part >> 7; value > 0; value >>= 7) chunk.unshift((value & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}

function positiveInteger(bytes: Buffer): Buffer {
  return der(0x02, bytes[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
}

function time(date: Date): Buffer {
  // RFC 5280 section 4.1.2.5: UTCTime through 2049, GeneralizedTime from 2050.
  const iso = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return date.getUTCFullYear() < 2050 ? der(0x17, Buffer.from(`${iso.slice(2)}Z`)) : der(0x18, Buffer.from(`${iso}Z`));
}

function distinguishedName(commonName: string): Buffer {
  return sequence(der(0x31, sequence(objectIdentifier("2.5.4.3"), der(0x0c, Buffer.from(commonName, "utf-8")))));
}

export interface SelfSignedCertificate {
  /** PKCS #8 PEM private key. */
  privateKeyPem: string;
  /** Base64 DER certificate, the form SAML metadata and `ds:X509Certificate` use. */
  certificate: string;
}

export function createSelfSignedCertificate(
  commonName: string,
  options: { validDays?: number; now?: Date } = {},
): SelfSignedCertificate {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const now = options.now ?? new Date();
  const notAfter = new Date(now.getTime() + (options.validDays ?? 3650) * 24 * 60 * 60 * 1000);
  const sha256WithRsa = sequence(objectIdentifier("1.2.840.113549.1.1.11"), der(0x05));
  const serial = randomBytes(16);
  serial[0]! &= 0x7f;
  serial[0]! |= 0x01;

  const name = distinguishedName(commonName);
  const tbsCertificate = sequence(
    der(0xa0, positiveInteger(Buffer.from([2]))),
    positiveInteger(serial),
    sha256WithRsa,
    name,
    sequence(time(now), time(notAfter)),
    name,
    publicKey.export({ type: "spki", format: "der" }),
  );
  const signature = sign("sha256", tbsCertificate, privateKey);
  const certificate = sequence(tbsCertificate, sha256WithRsa, der(0x03, Buffer.from([0]), signature));

  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    certificate: certificate.toString("base64"),
  };
}

/** Wraps a base64 DER certificate in PEM armor, accepting a value that is already PEM. */
export function certificateToPem(certificate: string): string {
  if (certificate.includes("-----BEGIN CERTIFICATE-----")) return certificate;
  const body = certificate.replace(/\s+/g, "");
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

/** True when `certificate` parses and was signed by the given private key's public half. */
export function certificateMatchesKey(certificate: string, privateKeyPem: string): boolean {
  try {
    const cert = new X509Certificate(certificateToPem(certificate));
    return cert.checkPrivateKey(createPrivateKey(privateKeyPem));
  } catch {
    return false;
  }
}
