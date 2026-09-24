import { describe, it, expect, beforeEach } from "vitest";
import { Hono, type AppEnv } from "@emulators/core";
import { createTestApp, testAuthHeaders as authHeaders, testBaseUrl as base } from "./helpers.js";

describe("AWS plugin - KMS", () => {
  let app: Hono<AppEnv>;

  beforeEach(() => {
    app = createTestApp().app;
  });

  function kms(target: Hono<AppEnv>, action: string, payload: unknown, path = "/kms") {
    return target.request(`${base}${path}`, {
      method: "POST",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": `TrentService.${action}`,
      },
      body: JSON.stringify(payload),
    });
  }

  const dataKey = Buffer.alloc(32, 0xa5).toString("base64");

  it("round-trips Encrypt and Decrypt", async () => {
    const encRes = await kms(app, "Encrypt", { KeyId: "alias/data-encryption", Plaintext: dataKey });
    expect(encRes.status).toBe(200);
    expect(encRes.headers.get("Content-Type")).toContain("application/x-amz-json-1.1");
    const enc = (await encRes.json()) as { CiphertextBlob: string; KeyId: string };
    expect(enc.KeyId).toBe("alias/data-encryption");
    expect(enc.CiphertextBlob).not.toBe(dataKey);

    const decRes = await kms(app, "Decrypt", { CiphertextBlob: enc.CiphertextBlob });
    expect(decRes.status).toBe(200);
    const dec = (await decRes.json()) as { Plaintext: string; KeyId: string };
    expect(dec.Plaintext).toBe(dataKey);
    expect(dec.KeyId).toBe("alias/data-encryption");
  });

  it("decrypts a blob against a freshly constructed store", async () => {
    const encRes = await kms(app, "Encrypt", { KeyId: "alias/data-encryption", Plaintext: dataKey });
    const enc = (await encRes.json()) as { CiphertextBlob: string };

    // A blob is written to the caller's own database and outlives the emulator,
    // so a brand new app with an empty store must still decrypt it.
    const fresh = createTestApp().app;
    const decRes = await kms(fresh, "Decrypt", { CiphertextBlob: enc.CiphertextBlob });
    expect(decRes.status).toBe(200);
    const dec = (await decRes.json()) as { Plaintext: string; KeyId: string };
    expect(dec.Plaintext).toBe(dataKey);
    expect(dec.KeyId).toBe("alias/data-encryption");
  });

  it("produces a different blob each time and decrypts both", async () => {
    const first = (await (await kms(app, "Encrypt", { KeyId: "k", Plaintext: dataKey })).json()) as {
      CiphertextBlob: string;
    };
    const second = (await (await kms(app, "Encrypt", { KeyId: "k", Plaintext: dataKey })).json()) as {
      CiphertextBlob: string;
    };
    expect(first.CiphertextBlob).not.toBe(second.CiphertextBlob);

    for (const blob of [first.CiphertextBlob, second.CiphertextBlob]) {
      const dec = (await (await kms(app, "Decrypt", { CiphertextBlob: blob })).json()) as { Plaintext: string };
      expect(dec.Plaintext).toBe(dataKey);
    }
  });

  it("echoes back an arn or a raw key id", async () => {
    const arn = "arn:aws:kms:us-east-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab";
    for (const keyId of [arn, "1234abcd-12ab-34cd-56ef-1234567890ab", "alias/data-encryption"]) {
      const enc = (await (await kms(app, "Encrypt", { KeyId: keyId, Plaintext: dataKey })).json()) as {
        CiphertextBlob: string;
        KeyId: string;
      };
      expect(enc.KeyId).toBe(keyId);
      const dec = (await (await kms(app, "Decrypt", { CiphertextBlob: enc.CiphertextBlob })).json()) as {
        KeyId: string;
      };
      expect(dec.KeyId).toBe(keyId);
    }
  });

  it("serves the path with a trailing slash too", async () => {
    const res = await kms(app, "Encrypt", { KeyId: "alias/data-encryption", Plaintext: dataKey }, "/kms/");
    expect(res.status).toBe(200);
  });

  it("returns a well-formed AWS JSON error for an unknown target", async () => {
    const res = await kms(app, "GenerateDataKey", { KeyId: "alias/data-encryption" });
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toContain("application/x-amz-json-1.1");
    expect(res.headers.get("x-amzn-ErrorType")).toBe("UnknownOperationException");
    const body = (await res.json()) as { __type: string; message: string };
    expect(body.__type).toBe("UnknownOperationException");
    expect(body.message).toContain("TrentService.GenerateDataKey");
  });

  it("returns a well-formed error when the target header is missing", async () => {
    const res = await app.request(`${base}/kms`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/x-amz-json-1.1" },
      body: JSON.stringify({ KeyId: "alias/data-encryption" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { __type: string };
    expect(body.__type).toBe("UnknownOperationException");
  });

  it("rejects a body that is not JSON", async () => {
    const res = await app.request(`${base}/kms`, {
      method: "POST",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "TrentService.Encrypt",
      },
      body: "not json at all",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { __type: string };
    expect(body.__type).toBe("SerializationException");
  });

  it("rejects Encrypt without a KeyId or Plaintext", async () => {
    const noKey = await kms(app, "Encrypt", { Plaintext: dataKey });
    expect(noKey.status).toBe(400);
    expect(((await noKey.json()) as { __type: string }).__type).toBe("ValidationException");

    const noPlaintext = await kms(app, "Encrypt", { KeyId: "alias/data-encryption" });
    expect(noPlaintext.status).toBe(400);
    expect(((await noPlaintext.json()) as { __type: string }).__type).toBe("ValidationException");
  });

  it("rejects Plaintext that is not base64", async () => {
    const res = await kms(app, "Encrypt", { KeyId: "alias/data-encryption", Plaintext: "not base64 !!!" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { __type: string }).__type).toBe("ValidationException");
  });

  it("rejects a ciphertext blob it did not produce", async () => {
    const res = await kms(app, "Decrypt", { CiphertextBlob: Buffer.from("some other blob").toString("base64") });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { __type: string };
    expect(body.__type).toBe("InvalidCiphertextException");
  });

  it("rejects a tampered ciphertext blob", async () => {
    const enc = (await (await kms(app, "Encrypt", { KeyId: "k", Plaintext: dataKey })).json()) as {
      CiphertextBlob: string;
    };
    const raw = Buffer.from(enc.CiphertextBlob, "base64");
    raw[raw.length - 1] ^= 0xff;

    const res = await kms(app, "Decrypt", { CiphertextBlob: raw.toString("base64") });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { __type: string }).__type).toBe("InvalidCiphertextException");
  });

  it("rejects Decrypt without a ciphertext blob", async () => {
    const res = await kms(app, "Decrypt", {});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { __type: string }).__type).toBe("ValidationException");
  });
  it("preserves arbitrary binary plaintext and authenticates encryption context", async () => {
    const plaintext = Buffer.from(Array.from({ length: 256 }, (_, i) => i)).toString("base64");
    const encrypted = await kms(app, "Encrypt", {
      KeyId: "alias/test",
      Plaintext: plaintext,
      EncryptionContext: { purpose: "test", tenant: "example" },
    });
    const { CiphertextBlob } = (await encrypted.json()) as { CiphertextBlob: string };
    const decrypted = await kms(app, "Decrypt", {
      CiphertextBlob,
      EncryptionContext: { tenant: "example", purpose: "test" },
    });
    expect(decrypted.status).toBe(200);
    expect(((await decrypted.json()) as { Plaintext: string }).Plaintext).toBe(plaintext);
    for (const context of [undefined, { purpose: "other", tenant: "example" }]) {
      const invalid = await kms(app, "Decrypt", { CiphertextBlob, EncryptionContext: context });
      expect(invalid.status).toBe(400);
      expect(((await invalid.json()) as { __type: string }).__type).toBe("InvalidCiphertextException");
    }
  });

  it("authenticates the key identity embedded in a ciphertext blob", async () => {
    const encrypted = await kms(app, "Encrypt", { KeyId: "alias/test", Plaintext: dataKey });
    const { CiphertextBlob } = (await encrypted.json()) as { CiphertextBlob: string };
    const raw = Buffer.from(CiphertextBlob, "base64");
    const keyOffset = raw.indexOf(Buffer.from("alias/test"));
    expect(keyOffset).toBeGreaterThan(0);
    raw[keyOffset] ^= 1;
    const invalid = await kms(app, "Decrypt", { CiphertextBlob: raw.toString("base64") });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { __type: string }).__type).toBe("InvalidCiphertextException");
  });

  it("checks an explicitly supplied decryption key", async () => {
    const encrypted = await kms(app, "Encrypt", { KeyId: "alias/test", Plaintext: dataKey });
    const { CiphertextBlob } = (await encrypted.json()) as { CiphertextBlob: string };
    expect((await kms(app, "Decrypt", { CiphertextBlob, KeyId: "alias/test" })).status).toBe(200);
    const invalid = await kms(app, "Decrypt", { CiphertextBlob, KeyId: "alias/other" });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { __type: string }).__type).toBe("IncorrectKeyException");
  });

  it("rejects unsupported algorithms, malformed contexts, and oversized plaintext", async () => {
    for (const extra of [
      { EncryptionAlgorithm: "RSAES_OAEP_SHA_256" },
      { EncryptionContext: { key: 1 } },
      { EncryptionContext: [] },
      { EncryptionContext: null },
      { Plaintext: Buffer.alloc(4097).toString("base64") },
    ]) {
      const invalid = await kms(app, "Encrypt", { KeyId: "alias/test", Plaintext: dataKey, ...extra });
      expect(invalid.status).toBe(400);
      expect(((await invalid.json()) as { __type: string }).__type).toBe("ValidationException");
    }
  });
});
