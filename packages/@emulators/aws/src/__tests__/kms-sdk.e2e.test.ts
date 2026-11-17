import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  KMSClient,
  CreateAliasCommand,
  CreateKeyCommand,
  DecryptCommand,
  DescribeKeyCommand,
  EncryptCommand,
  ListKeysCommand,
} from "@aws-sdk/client-kms";
import { startAwsTarget } from "./helpers.js";

describe("AWS plugin - real @aws-sdk/client-kms E2E", () => {
  let kms: KMSClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const target = await startAwsTarget();
    close = target.close;
    kms = new KMSClient({
      endpoint: target.endpoint("kms"),
      region: "us-east-1",
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
      maxAttempts: 1,
    });
    if (target.external) {
      // External targets may lack emulate's seed; create the default alias the suite relies on.
      const existing = await kms.send(new DescribeKeyCommand({ KeyId: "alias/emulate-default" })).catch((error) => {
        if (error.name !== "NotFoundException") throw error;
      });
      if (!existing) {
        const { KeyMetadata } = await kms.send(new CreateKeyCommand({ Description: "emulate default" }));
        await kms.send(new CreateAliasCommand({ AliasName: "alias/emulate-default", TargetKeyId: KeyMetadata!.KeyId }));
      }
    }
  });

  afterAll(async () => {
    kms?.destroy();
    await close?.();
  });

  it("round-trips arbitrary bytes through Encrypt and Decrypt", async () => {
    const { KeyMetadata } = await kms.send(new CreateKeyCommand({ Description: "sdk key" }));
    expect(KeyMetadata?.CreationDate).toBeInstanceOf(Date);
    const plaintext = new Uint8Array([0, 1, 2, 128, 255]);
    const encrypted = await kms.send(
      new EncryptCommand({ KeyId: KeyMetadata!.KeyId, Plaintext: plaintext, EncryptionContext: { app: "sdk" } }),
    );
    expect(encrypted.KeyId).toBe(KeyMetadata!.Arn);
    expect(encrypted.CiphertextBlob).toBeInstanceOf(Uint8Array);
    expect(encrypted.$metadata.requestId).toBeTruthy();

    const decrypted = await kms.send(
      new DecryptCommand({ CiphertextBlob: encrypted.CiphertextBlob, EncryptionContext: { app: "sdk" } }),
    );
    expect(Array.from(decrypted.Plaintext!)).toEqual(Array.from(plaintext));
    expect(decrypted.KeyId).toBe(KeyMetadata!.Arn);

    await expect(
      kms.send(new DecryptCommand({ CiphertextBlob: encrypted.CiphertextBlob, EncryptionContext: { app: "other" } })),
    ).rejects.toMatchObject({ name: "InvalidCiphertextException", $metadata: { httpStatusCode: 400 } });
  });

  it("resolves the default alias and lists keys", async () => {
    const { KeyMetadata } = await kms.send(new DescribeKeyCommand({ KeyId: "alias/emulate-default" }));
    const { Keys } = await kms.send(new ListKeysCommand({}));
    expect(Keys).toContainEqual({ KeyId: KeyMetadata!.KeyId, KeyArn: KeyMetadata!.Arn });
    await expect(kms.send(new DescribeKeyCommand({ KeyId: "alias/missing" }))).rejects.toMatchObject({
      name: "NotFoundException",
    });
  });
});
