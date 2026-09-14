import type { RouteContext } from "@emulators/core";
import type { Context } from "@emulators/core";
import { awsJsonResponse, awsErrorJson, decodeBase64 } from "../helpers.js";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const TARGET_PREFIX = "TrentService.";

// Ciphertext stored by callers must survive emulator restarts and store resets.
// This fixed, public key provides repeatable local emulation, not data security.
const EMULATOR_KEY = createHash("sha256").update("emulate:aws:kms:wrapping-key:v1").digest();

const BLOB_MAGIC = Buffer.from("EMUKMS01", "ascii");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_KEY_ID_BYTES = 255;

interface KmsBlob {
  keyId: string;
  plaintext: Buffer;
}

// Layout: magic | keyIdLength (1 byte) | keyId | iv | auth tag | ciphertext.
// The key id travels inside the blob so Decrypt can report which key wrapped it
// without consulting any stored state.
function wrap(keyId: string, plaintext: Buffer, context: string): Buffer {
  const keyIdBytes = Buffer.from(keyId, "utf8");
  const iv = randomBytes(IV_BYTES);
  const header = Buffer.concat([BLOB_MAGIC, Buffer.from([keyIdBytes.length]), keyIdBytes]);
  const cipher = createCipheriv("aes-256-gcm", EMULATOR_KEY, iv);
  cipher.setAAD(Buffer.concat([header, Buffer.from(context)]));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([header, iv, cipher.getAuthTag(), ciphertext]);
}

function unwrap(blob: Buffer, context: string): KmsBlob | null {
  if (blob.length < BLOB_MAGIC.length + 1) return null;
  if (!blob.subarray(0, BLOB_MAGIC.length).equals(BLOB_MAGIC)) return null;

  let offset = BLOB_MAGIC.length;
  const keyIdLength = blob.readUInt8(offset);
  offset += 1;
  if (blob.length < offset + keyIdLength + IV_BYTES + TAG_BYTES) return null;

  const keyId = blob.subarray(offset, offset + keyIdLength).toString("utf8");
  offset += keyIdLength;
  const header = blob.subarray(0, offset);
  const iv = blob.subarray(offset, offset + IV_BYTES);
  offset += IV_BYTES;
  const tag = blob.subarray(offset, offset + TAG_BYTES);
  offset += TAG_BYTES;
  const ciphertext = blob.subarray(offset);

  try {
    const decipher = createDecipheriv("aes-256-gcm", EMULATOR_KEY, iv);
    decipher.setAAD(Buffer.concat([header, Buffer.from(context)]));
    decipher.setAuthTag(tag);
    return { keyId, plaintext: Buffer.concat([decipher.update(ciphertext), decipher.final()]) };
  } catch {
    return null;
  }
}

export function kmsRoutes(ctx: RouteContext): void {
  const { app } = ctx;

  // The AWS SDKs resolve a configured endpoint of ".../kms" and then post to it
  // directly, so the path arrives without a trailing slash. Register both.
  const handler = async (c: Context) => {
    const target = c.req.header("X-Amz-Target") ?? "";
    const action = target.startsWith(TARGET_PREFIX) ? target.slice(TARGET_PREFIX.length) : "";

    let params: Record<string, unknown>;
    try {
      const raw: unknown = await c.req.json();
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not an object");
      params = raw as Record<string, unknown>;
    } catch {
      return awsErrorJson(c, "SerializationException", "The request body could not be parsed as JSON.", 400);
    }

    if (params["EncryptionAlgorithm"] !== undefined && params["EncryptionAlgorithm"] !== "SYMMETRIC_DEFAULT") {
      return awsErrorJson(c, "ValidationException", "Only SYMMETRIC_DEFAULT is supported.", 400);
    }
    const encryptionContext = params["EncryptionContext"] === undefined ? {} : params["EncryptionContext"];
    if (
      encryptionContext === null ||
      typeof encryptionContext !== "object" ||
      Array.isArray(encryptionContext) ||
      Object.values(encryptionContext).some((value) => typeof value !== "string")
    ) {
      return awsErrorJson(c, "ValidationException", "EncryptionContext must be a map of strings.", 400);
    }
    // Key order has no meaning in an encryption context. Authenticate the same
    // canonical bytes on Encrypt and Decrypt without storing the context.
    const context = JSON.stringify(Object.entries(encryptionContext).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

    switch (action) {
      case "Encrypt":
        return encrypt(c, params, context);
      case "Decrypt":
        return decrypt(c, params, context);
      default:
        return awsErrorJson(
          c,
          "UnknownOperationException",
          `The operation ${target || "(none)"} is not supported by this endpoint.`,
          400,
        );
    }
  };

  app.post("/kms", handler);
  app.post("/kms/", handler);

  function encrypt(c: Context, params: Record<string, unknown>, context: string) {
    const keyId = typeof params["KeyId"] === "string" ? params["KeyId"].trim() : "";
    if (!keyId) {
      return awsErrorJson(c, "ValidationException", "The request must contain the parameter KeyId.", 400);
    }
    if (Buffer.byteLength(keyId, "utf8") > MAX_KEY_ID_BYTES) {
      return awsErrorJson(c, "ValidationException", `KeyId must be at most ${MAX_KEY_ID_BYTES} bytes.`, 400);
    }

    const plaintext = typeof params["Plaintext"] === "string" ? params["Plaintext"] : "";
    if (!plaintext) {
      return awsErrorJson(c, "ValidationException", "The request must contain the parameter Plaintext.", 400);
    }

    const decoded = decodeBase64(plaintext);
    if (!decoded || decoded.length === 0) {
      return awsErrorJson(c, "ValidationException", "Plaintext must be base64 encoded.", 400);
    }

    if (decoded.length > 4096) {
      return awsErrorJson(c, "ValidationException", "Plaintext must be at most 4096 bytes.", 400);
    }
    return awsJsonResponse(c, {
      CiphertextBlob: wrap(keyId, decoded, context).toString("base64"),
      KeyId: keyId,
      EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
    });
  }

  function decrypt(c: Context, params: Record<string, unknown>, context: string) {
    const blob = typeof params["CiphertextBlob"] === "string" ? params["CiphertextBlob"] : "";
    if (!blob) {
      return awsErrorJson(c, "ValidationException", "The request must contain the parameter CiphertextBlob.", 400);
    }

    const decoded = decodeBase64(blob);
    const unwrapped = decoded ? unwrap(decoded, context) : null;
    if (!unwrapped) {
      return awsErrorJson(c, "InvalidCiphertextException", "The ciphertext or encryption context is invalid.", 400);
    }

    if (params["KeyId"] !== undefined && typeof params["KeyId"] !== "string") {
      return awsErrorJson(c, "ValidationException", "KeyId must be a string.", 400);
    }
    if (params["KeyId"] !== undefined && params["KeyId"] !== unwrapped.keyId) {
      return awsErrorJson(
        c,
        "IncorrectKeyException",
        "KeyId does not match the key used to encrypt the ciphertext.",
        400,
      );
    }
    return awsJsonResponse(c, {
      Plaintext: unwrapped.plaintext.toString("base64"),
      KeyId: unwrapped.keyId,
      EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
    });
  }
}
