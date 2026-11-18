/** Node crypto subset for the browser playground, built on @noble/hashes and the Web Crypto API. Load buffer.ts first so base64url works on digests. */
import { hmac } from "@noble/hashes/hmac.js";
import { md5, sha1 } from "@noble/hashes/legacy.js";
import { scrypt } from "@noble/hashes/scrypt.js";
import { sha224, sha256, sha384, sha512 } from "@noble/hashes/sha2.js";
import type { CHash } from "@noble/hashes/utils.js";
import { Buffer } from "buffer/index.js";

type Input = string | ArrayBufferView;
type Hasher = { update(data: Uint8Array): unknown; digest(): Uint8Array };
type ScryptOptions = { cost?: number; blockSize?: number; parallelization?: number; maxmem?: number };

const hashes = new Map<string, CHash>([
  ["md5", md5],
  ["sha1", sha1],
  ["sha224", sha224],
  ["sha256", sha256],
  ["sha384", sha384],
  ["sha512", sha512],
]);

function unsupported(name: string): Error {
  return new Error(`${name} is not available in the browser playground`);
}

function unsupportedFunction(name: string): () => never {
  return () => {
    throw unsupported(name);
  };
}

function hashFor(fn: string, algorithm: string): CHash {
  const hash = hashes.get(algorithm.toLowerCase());
  if (!hash) throw unsupported(`${fn}(${algorithm})`);
  return hash;
}

function bytesOf(data: Input, encoding?: string): Uint8Array {
  return typeof data === "string"
    ? Buffer.from(data, encoding)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

class Digest {
  private readonly hasher: Hasher;

  constructor(hasher: Hasher) {
    this.hasher = hasher;
  }

  update(data: Input, inputEncoding?: string): this {
    this.hasher.update(bytesOf(data, inputEncoding));
    return this;
  }

  digest(): Buffer;
  digest(encoding: string): string;
  digest(encoding?: string): Buffer | string {
    const bytes = Buffer.from(this.hasher.digest());
    return encoding === undefined ? bytes : bytes.toString(encoding);
  }
}

export function createHash(algorithm: string): Digest {
  return new Digest(hashFor("crypto.createHash", algorithm).create());
}

export function createHmac(algorithm: string, key: Input): Digest {
  return new Digest(hmac.create(hashFor("crypto.createHmac", algorithm), bytesOf(key)));
}

export function randomBytes(size: number): Buffer {
  const out = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += 65536)
    globalThis.crypto.getRandomValues(out.subarray(offset, offset + 65536));
  return Buffer.from(out);
}

export function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}

export function timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean {
  if (a.byteLength !== b.byteLength) throw new RangeError("Input buffers must have the same byte length");
  const left = bytesOf(a);
  const right = bytesOf(b);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

export function scryptSync(password: Input, salt: Input, keylen: number, options: ScryptOptions = {}): Buffer {
  const { cost = 16384, blockSize = 8, parallelization = 1, maxmem = 32 * 1024 * 1024 } = options;
  return Buffer.from(
    scrypt(bytesOf(password), bytesOf(salt), { N: cost, r: blockSize, p: parallelization, dkLen: keylen, maxmem }),
  );
}

export const createCipheriv = unsupportedFunction("crypto.createCipheriv");
export const createDecipheriv = unsupportedFunction("crypto.createDecipheriv");
export const createPublicKey = unsupportedFunction("crypto.createPublicKey");
export const createPrivateKey = unsupportedFunction("crypto.createPrivateKey");
export const generateKeyPair = unsupportedFunction("crypto.generateKeyPair");
export const generateKeyPairSync = unsupportedFunction("crypto.generateKeyPairSync");
export const sign = unsupportedFunction("crypto.sign");
export const verify = unsupportedFunction("crypto.verify");
export const createSign = unsupportedFunction("crypto.createSign");
export const createVerify = unsupportedFunction("crypto.createVerify");

const nodeCrypto = {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  scryptSync,
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  createPrivateKey,
  generateKeyPair,
  generateKeyPairSync,
  sign,
  verify,
  createSign,
  createVerify,
};

export default nodeCrypto;
