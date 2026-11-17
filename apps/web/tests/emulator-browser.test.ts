import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Buffer as NodeBuffer } from "node:buffer";
import { test } from "node:test";
import { createContext as nodeCreateContext, Script as NodeScript } from "node:vm";
import { Buffer } from "../lib/emulator-browser/buffer.ts";
import shimCryptoDefault, * as shimCrypto from "../lib/emulator-browser/crypto.ts";
import { createContext, Script } from "../lib/emulator-browser/vm.ts";

const hashAlgorithms = ["md5", "sha1", "sha224", "sha256", "sha384", "sha512"];
const hmacAlgorithms = ["md5", "sha1", "sha256", "sha512"];
const text = "héllo wörld 🚀";
const bytes = new Uint8Array([0, 1, 2, 250, 255]);
const digestEncodings = ["hex", "base64", "base64url"] as const;
const bigBytes = crypto.randomBytes(3 * 1024 * 1024);

test("createHash matches node for every algorithm, encoding and multi-part update", () => {
  assert.equal(shimCryptoDefault.createHash, shimCrypto.createHash);
  for (const algorithm of hashAlgorithms) {
    for (const encoding of digestEncodings) {
      const expected = crypto.createHash(algorithm).update(text).update(bytes).digest(encoding);
      const actual = shimCrypto.createHash(algorithm).update(text).update(bytes).digest(encoding);
      assert.equal(actual, expected, `${algorithm} ${encoding}`);
    }
    const expectedRaw = crypto.createHash(algorithm).update(text).update(bytes).digest();
    const actualRaw = shimCrypto.createHash(algorithm).update(text).update(bytes).digest();
    assert.deepEqual(Array.from(actualRaw), Array.from(expectedRaw), `${algorithm} raw`);
  }
});

test("createHash and createHmac accept input encodings like node", () => {
  assert.equal(
    shimCrypto.createHash("sha256").update("00ff", "hex").digest("hex"),
    crypto.createHash("sha256").update("00ff", "hex").digest("hex"),
  );
  for (const algorithm of hmacAlgorithms) {
    for (const key of ["secret", bytes]) {
      for (const encoding of digestEncodings) {
        const expected = crypto.createHmac(algorithm, key).update(text).update(bytes).digest(encoding);
        const actual = shimCrypto.createHmac(algorithm, key).update(text).update(bytes).digest(encoding);
        assert.equal(actual, expected, `hmac ${algorithm} ${encoding}`);
      }
      const expectedRaw = crypto.createHmac(algorithm, key).update(text).update(bytes).digest();
      const actualRaw = shimCrypto.createHmac(algorithm, key).update(text).update(bytes).digest();
      assert.deepEqual(Array.from(actualRaw), Array.from(expectedRaw), `hmac ${algorithm} raw`);
    }
  }
});

test("unsupported algorithms and cipher APIs fail with a clear message", () => {
  assert.throws(
    () => shimCrypto.createHash("sha3-256"),
    /crypto\.createHash\(sha3-256\) is not available in the browser playground/,
  );
  assert.throws(() => shimCrypto.createCipheriv(), /crypto\.createCipheriv is not available in the browser playground/);
});

test("scryptSync matches node with defaults and with explicit cost", () => {
  assert.equal(
    shimCrypto.scryptSync("password", "salt", 32).toString("hex"),
    crypto.scryptSync("password", "salt", 32).toString("hex"),
  );
  const options = { cost: 1024, blockSize: 8, parallelization: 2 };
  assert.equal(
    shimCrypto.scryptSync("password", "salt", 64, options).toString("hex"),
    crypto.scryptSync("password", "salt", 64, options).toString("hex"),
  );
});

test("timingSafeEqual compares bytes and rejects length mismatches like node", () => {
  const a = Buffer.from("secret-value");
  assert.equal(shimCrypto.timingSafeEqual(a, Buffer.from("secret-value")), true);
  assert.equal(shimCrypto.timingSafeEqual(a, Buffer.from("secret-valuX")), false);
  assert.throws(() => shimCrypto.timingSafeEqual(a, Buffer.from("short")), RangeError);
  assert.throws(() => crypto.timingSafeEqual(NodeBuffer.from("secret-value"), NodeBuffer.from("short")), RangeError);
});

test("randomBytes returns the requested length and randomUUID is a v4 UUID", () => {
  assert.equal(shimCrypto.randomBytes(32).length, 32);
  assert.equal(shimCrypto.randomBytes(70000).length, 70000);
  assert.match(shimCrypto.randomUUID(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("Buffer encodes and decodes utf8, hex, base64 and base64url like node, including 3 MB inputs", () => {
  const utf8 = "aé🚀 ".repeat(400_000);
  assert.equal(Buffer.from(utf8).toString("hex"), NodeBuffer.from(utf8).toString("hex"));
  assert.equal(Buffer.from(Buffer.from(utf8).toString("utf8")).toString("hex"), NodeBuffer.from(utf8).toString("hex"));

  for (const encoding of ["hex", "base64", "base64url"] as const) {
    const encoded = Buffer.from(bigBytes).toString(encoding);
    assert.equal(encoded, bigBytes.toString(encoding), encoding);
    assert.equal(Buffer.from(encoded, encoding).toString("hex"), bigBytes.toString("hex"), `${encoding} decode`);
    assert.equal(
      Buffer.byteLength(encoded, encoding),
      NodeBuffer.byteLength(encoded, encoding),
      `${encoding} byteLength`,
    );
  }
  assert.equal(Buffer.from("-_8", "base64url").toString("hex"), NodeBuffer.from("-_8", "base64url").toString("hex"));
});

test("a vm Script runs an expression against its context like Node", () => {
  const code =
    "(() => { let regex; try { regex = new RegExp(pattern, 'u'); } catch { return null; } return regex.test(value); })()";
  for (const values of [
    { pattern: "^a+$", value: "aaa" },
    { pattern: "^a+$", value: "b" },
    { pattern: "(", value: "x" },
  ]) {
    const expected = new NodeScript(code).runInContext(nodeCreateContext({ ...values }));
    assert.equal(new Script(code).runInContext(createContext({ ...values })), expected, JSON.stringify(values));
  }
});
