import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@emulators/core";
import type { AddressInfo } from "node:net";
import {
  KMSClient,
  CreateKeyCommand,
  DecryptCommand,
  DescribeKeyCommand,
  EncryptCommand,
  ListKeysCommand,
} from "@aws-sdk/client-kms";
import { createTestApp } from "./helpers.js";

describe("AWS plugin - real @aws-sdk/client-kms E2E", () => {
  let kms: KMSClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const server = serve({ fetch: (request) => app.fetch(request), port: 0 });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    close = () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { app } = createTestApp(baseUrl);
    kms = new KMSClient({
      endpoint: `${baseUrl}/kms`,
      region: "us-east-1",
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
      maxAttempts: 1,
    });
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
