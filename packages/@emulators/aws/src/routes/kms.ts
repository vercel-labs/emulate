import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "crypto";
import type { Context, RouteContext } from "@emulators/core";
import type { KmsKey } from "../entities.js";
import { getAwsStore, type AwsStore } from "../store.js";
import {
  checkMemberLength,
  generateMessageId,
  getAccountId,
  getDefaultRegion,
  validationErrorMessage,
} from "../helpers.js";

const TARGET_PREFIX = "TrentService.";
const ENCRYPTION_ALGORITHMS = ["SYMMETRIC_DEFAULT", "RSAES_OAEP_SHA_1", "RSAES_OAEP_SHA_256", "SM2PKE"];
const KEY_USAGES = [
  "SIGN_VERIFY",
  "ENCRYPT_DECRYPT",
  "GENERATE_VERIFY_MAC",
  "KEY_AGREEMENT",
  "ENCAPSULATE_DECAPSULATE",
];
const ORIGINS = ["AWS_KMS", "EXTERNAL", "AWS_CLOUDHSM", "EXTERNAL_KEY_STORE"];

// Ciphertext blob layout: version | key id length | key id | IV | GCM tag | ciphertext.
// The key id lets Decrypt find the key without a KeyId parameter, as KMS does
// with the metadata in its own symmetric ciphertext blobs.
const BLOB_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

class KmsError extends Error {
  constructor(
    public type: string,
    message: string,
  ) {
    super(message);
  }
}

function fail(type: string, message: string): never {
  throw new KmsError(type, message);
}

export function createKmsKey(
  aws: AwsStore,
  options: { keyId?: string; description?: string; region?: string } = {},
): KmsKey {
  const keyId = options.keyId ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(keyId)) {
    throw new Error(`KMS key_id must be a lowercase UUID: ${keyId}`);
  }
  return aws.kmsKeys.insert({
    key_id: keyId,
    arn: `arn:aws:kms:${options.region ?? getDefaultRegion()}:${getAccountId()}:key/${keyId}`,
    description: options.description ?? "",
    key_material: randomBytes(32).toString("base64"),
    key_material_id: randomBytes(32).toString("hex"),
  });
}

export function createKmsAlias(aws: AwsStore, key: KmsKey, name: string): void {
  const aliasName = name.startsWith("alias/") ? name : `alias/${name}`;
  if (aws.kmsAliases.findOneBy("alias_name", aliasName)) return;
  aws.kmsAliases.insert({
    alias_name: aliasName,
    alias_arn: key.arn.replace(/:key\/.*$/, `:${aliasName}`),
    target_key_id: key.key_id,
  });
}

function keyMetadata(key: KmsKey) {
  return {
    AWSAccountId: getAccountId(),
    KeyId: key.key_id,
    Arn: key.arn,
    CreationDate: Date.parse(key.created_at) / 1000,
    Enabled: true,
    Description: key.description,
    KeyUsage: "ENCRYPT_DECRYPT",
    KeyState: "Enabled",
    Origin: "AWS_KMS",
    KeyManager: "CUSTOMER",
    CustomerMasterKeySpec: "SYMMETRIC_DEFAULT",
    KeySpec: "SYMMETRIC_DEFAULT",
    EncryptionAlgorithms: ["SYMMETRIC_DEFAULT"],
    MultiRegion: false,
    CurrentKeyMaterialId: key.key_material_id,
  };
}

// Encryption context pairs are additional authenticated data. Pair order has no
// meaning, so both operations authenticate the same sorted encoding.
function contextAad(context: Record<string, string>): Buffer {
  const pairs = Object.entries(context).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Buffer.from(JSON.stringify(pairs), "utf8");
}

function seal(key: KmsKey, plaintext: Buffer, context: Record<string, string>): Buffer {
  const keyId = Buffer.from(key.key_id, "utf8");
  const header = Buffer.concat([Buffer.from([BLOB_VERSION, keyId.length]), keyId]);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key.key_material, "base64"), iv);
  cipher.setAAD(Buffer.concat([header, contextAad(context)]));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([header, iv, cipher.getAuthTag(), ciphertext]);
}

function blobKeyId(blob: Buffer): string | undefined {
  if (blob.length < 2 || blob[0] !== BLOB_VERSION) return undefined;
  const end = 2 + blob[1];
  if (blob.length < end + IV_BYTES + TAG_BYTES) return undefined;
  return blob.subarray(2, end).toString("utf8");
}

function open(key: KmsKey, blob: Buffer, context: Record<string, string>): Buffer | undefined {
  const headerEnd = 2 + blob[1];
  const iv = blob.subarray(headerEnd, headerEnd + IV_BYTES);
  const tag = blob.subarray(headerEnd + IV_BYTES, headerEnd + IV_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key.key_material, "base64"), iv);
    decipher.setAAD(Buffer.concat([blob.subarray(0, headerEnd), contextAad(context)]));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(blob.subarray(headerEnd + IV_BYTES + TAG_BYTES)), decipher.final()]);
  } catch {
    return undefined;
  }
}

function optionalString(input: Record<string, unknown>, member: string): string | undefined {
  const value = input[member];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") fail("SerializationException", `${member} must be a string.`);
  return value;
}

function optionalBlob(input: Record<string, unknown>, member: string): Buffer | undefined {
  const value = optionalString(input, member);
  if (value === undefined) return undefined;
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    fail("SerializationException", `${member} must be base64 encoded.`);
  }
  return Buffer.from(value, "base64");
}

function encryptionContext(input: Record<string, unknown>): Record<string, string> {
  const value = input["EncryptionContext"];
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value) || Object.values(value).some((v) => typeof v !== "string")) {
    fail("SerializationException", "EncryptionContext must be a map of strings.");
  }
  return value as Record<string, string>;
}

function checkEnum(failures: string[], member: string, value: string | undefined, allowed: string[]) {
  if (value !== undefined && !allowed.includes(value)) {
    failures.push(
      `Value '${value}' at '${member}' failed to satisfy constraint: Member must satisfy enum value set: [${allowed.join(", ")}]`,
    );
  }
}

function checkFailures(failures: string[]) {
  if (failures.length > 0) fail("ValidationException", validationErrorMessage(failures));
}

function checkDryRun(input: Record<string, unknown>) {
  if (input["DryRun"] === true) {
    fail("DryRunOperationException", "The request would have succeeded, but the DryRun option is set.");
  }
}

export function kmsRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const aws = () => getAwsStore(store);

  // Accepts a key ID, key ARN, alias name, or alias ARN.
  function resolveKey(identifier: string): KmsKey {
    const prefix = `arn:aws:kms:${getDefaultRegion()}:${getAccountId()}`;
    if (identifier.startsWith("alias/")) {
      const alias = aws().kmsAliases.findOneBy("alias_name", identifier);
      const key = alias && aws().kmsKeys.findOneBy("key_id", alias.target_key_id);
      if (!key) fail("NotFoundException", `Alias ${prefix}:${identifier} is not found.`);
      return key;
    }
    if (/^arn:[^:]+:kms:[^:]*:[^:]*:alias\//.test(identifier)) {
      const alias = aws()
        .kmsAliases.all()
        .find((item) => item.alias_arn === identifier);
      const key = alias && aws().kmsKeys.findOneBy("key_id", alias.target_key_id);
      if (!key) fail("NotFoundException", `Alias ${identifier} is not found.`);
      return key;
    }
    const key = identifier.startsWith("arn:")
      ? aws().kmsKeys.findOneBy("arn", identifier)
      : aws().kmsKeys.findOneBy("key_id", identifier);
    if (!key) {
      const keyArn = identifier.startsWith("arn:") ? identifier : `${prefix}:key/${identifier}`;
      fail("NotFoundException", `Key '${keyArn}' does not exist`);
    }
    return key;
  }

  function createKey(input: Record<string, unknown>) {
    const description = optionalString(input, "Description");
    const keyUsage = optionalString(input, "KeyUsage");
    const keySpec = optionalString(input, "KeySpec") ?? optionalString(input, "CustomerMasterKeySpec");
    const origin = optionalString(input, "Origin");
    const failures: string[] = [];
    if (description !== undefined) checkMemberLength(failures, "description", description, 0, 8192);
    checkEnum(failures, "keyUsage", keyUsage, KEY_USAGES);
    checkEnum(failures, "origin", origin, ORIGINS);
    checkFailures(failures);

    // Only symmetric encryption keys are emulated.
    if (keyUsage !== undefined && keyUsage !== "ENCRYPT_DECRYPT") {
      fail("UnsupportedOperationException", `KeyUsage ${keyUsage} is not supported by the emulator.`);
    }
    if (keySpec !== undefined && keySpec !== "SYMMETRIC_DEFAULT") {
      fail("UnsupportedOperationException", `KeySpec ${keySpec} is not supported by the emulator.`);
    }
    if (origin !== undefined && origin !== "AWS_KMS") {
      fail("UnsupportedOperationException", `Origin ${origin} is not supported by the emulator.`);
    }
    if (input["MultiRegion"] === true) {
      fail("UnsupportedOperationException", "Multi-Region keys are not supported by the emulator.");
    }

    return { KeyMetadata: keyMetadata(createKmsKey(aws(), { description })) };
  }

  function describeKey(input: Record<string, unknown>) {
    const keyId = optionalString(input, "KeyId");
    const failures: string[] = [];
    checkMemberLength(failures, "keyId", keyId, 1, 2048);
    checkFailures(failures);
    return { KeyMetadata: keyMetadata(resolveKey(keyId!)) };
  }

  function listKeys(input: Record<string, unknown>) {
    const limit = input["Limit"] ?? 100;
    const marker = optionalString(input, "Marker");
    if (typeof limit !== "number" || !Number.isInteger(limit))
      fail("SerializationException", "Limit must be an integer.");
    const failures: string[] = [];
    if (limit < 1) {
      failures.push(
        `Value '${limit}' at 'limit' failed to satisfy constraint: Member must have value greater than or equal to 1`,
      );
    } else if (limit > 1000) {
      failures.push(
        `Value '${limit}' at 'limit' failed to satisfy constraint: Member must have value less than or equal to 1000`,
      );
    }
    if (marker !== undefined) checkMemberLength(failures, "marker", marker, 1, 1024);
    checkFailures(failures);

    const keys = aws().kmsKeys.all();
    let start = 0;
    if (marker !== undefined) {
      start = keys.findIndex((key) => key.key_id === marker);
      if (start === -1) fail("InvalidMarkerException", "Invalid marker.");
    }
    const page = keys.slice(start, start + limit);
    const next = keys[start + limit];
    return {
      Keys: page.map((key) => ({ KeyId: key.key_id, KeyArn: key.arn })),
      Truncated: next !== undefined,
      ...(next ? { NextMarker: next.key_id } : {}),
    };
  }

  function encrypt(input: Record<string, unknown>) {
    const keyId = optionalString(input, "KeyId");
    const plaintext = optionalBlob(input, "Plaintext");
    const algorithm = optionalString(input, "EncryptionAlgorithm");
    const context = encryptionContext(input);
    const failures: string[] = [];
    checkMemberLength(failures, "keyId", keyId, 1, 2048);
    checkMemberLength(failures, "plaintext", plaintext, 1, 4096);
    checkEnum(failures, "encryptionAlgorithm", algorithm, ENCRYPTION_ALGORITHMS);
    checkFailures(failures);

    const key = resolveKey(keyId!);
    if (algorithm !== undefined && algorithm !== "SYMMETRIC_DEFAULT") {
      fail("InvalidKeyUsageException", `The encryption algorithm ${algorithm} is not valid for this key.`);
    }
    checkDryRun(input);
    return {
      CiphertextBlob: seal(key, plaintext!, context).toString("base64"),
      KeyId: key.arn,
      EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
    };
  }

  function decrypt(input: Record<string, unknown>) {
    const blob = optionalBlob(input, "CiphertextBlob");
    const keyId = optionalString(input, "KeyId");
    const algorithm = optionalString(input, "EncryptionAlgorithm");
    const context = encryptionContext(input);
    const failures: string[] = [];
    checkMemberLength(failures, "ciphertextBlob", blob, 1, 6144);
    if (keyId !== undefined) checkMemberLength(failures, "keyId", keyId, 1, 2048);
    checkEnum(failures, "encryptionAlgorithm", algorithm, ENCRYPTION_ALGORITHMS);
    checkFailures(failures);

    const requested = keyId === undefined ? undefined : resolveKey(keyId);
    const embeddedKeyId = blobKeyId(blob!);
    if (embeddedKeyId === undefined) fail("InvalidCiphertextException", "The ciphertext is invalid.");
    const key = aws().kmsKeys.findOneBy("key_id", embeddedKeyId);
    if (!key) {
      const keyArn = `arn:aws:kms:${getDefaultRegion()}:${getAccountId()}:key/${embeddedKeyId}`;
      fail("NotFoundException", `Key '${keyArn}' does not exist`);
    }
    if (requested && requested.key_id !== key.key_id) {
      fail(
        "IncorrectKeyException",
        "The key ID in the request does not identify a CMK that can perform this operation.",
      );
    }
    if (algorithm !== undefined && algorithm !== "SYMMETRIC_DEFAULT") {
      fail("InvalidKeyUsageException", `The encryption algorithm ${algorithm} is not valid for this key.`);
    }
    const plaintext = open(key, blob!, context);
    if (!plaintext) fail("InvalidCiphertextException", "The ciphertext or encryption context is invalid.");
    checkDryRun(input);
    return {
      KeyId: key.arn,
      Plaintext: plaintext.toString("base64"),
      EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
      KeyMaterialId: key.key_material_id,
    };
  }

  const operations: Record<string, (input: Record<string, unknown>) => unknown> = {
    CreateKey: createKey,
    DescribeKey: describeKey,
    ListKeys: listKeys,
    Encrypt: encrypt,
    Decrypt: decrypt,
  };

  // AWS JSON 1.1: the operation comes from X-Amz-Target and errors carry __type.
  async function handleRequest(c: Context) {
    const requestId = generateMessageId();
    const headers = { "Content-Type": "application/x-amz-json-1.1", "x-amzn-RequestId": requestId };
    try {
      const target = c.req.header("X-Amz-Target") ?? "";
      const operation = target.startsWith(TARGET_PREFIX) ? operations[target.slice(TARGET_PREFIX.length)] : undefined;
      if (!operation) fail("UnknownOperationException", `The operation ${target || "(none)"} is not supported.`);
      let input: unknown;
      try {
        const body = await c.req.text();
        input = body.trim() === "" ? {} : JSON.parse(body);
      } catch {
        fail("SerializationException", "The request body is not valid JSON.");
      }
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        fail("SerializationException", "The request body must be a JSON object.");
      }
      return c.body(JSON.stringify(operation(input as Record<string, unknown>)), 200, headers);
    } catch (error) {
      if (!(error instanceof KmsError)) throw error;
      return c.body(JSON.stringify({ __type: error.type, message: error.message }), 400, {
        ...headers,
        "x-amzn-ErrorType": error.type,
      });
    }
  }

  app.post("/kms", handleRequest);
  app.post("/kms/", handleRequest);
}
