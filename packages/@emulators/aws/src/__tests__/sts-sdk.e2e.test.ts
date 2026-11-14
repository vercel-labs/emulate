import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@emulators/core";
import type { AddressInfo } from "node:net";
import { STSClient, AssumeRoleWithWebIdentityCommand } from "@aws-sdk/client-sts";
import { seedFromConfig } from "../index.js";
import { createTestApp } from "./helpers.js";

function idToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}.signature`;
}

describe("AWS plugin - real @aws-sdk/client-sts E2E", () => {
  let sts: STSClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const server = serve({ fetch: (request) => app.fetch(request), port: 0 });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    close = () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { app, store } = createTestApp(baseUrl);
    seedFromConfig(store, baseUrl, { iam: { roles: [{ role_name: "github-actions" }] } });
    // No credentials: the SDK sends AssumeRoleWithWebIdentity unsigned.
    sts = new STSClient({ endpoint: `${baseUrl}/sts`, region: "us-east-1", maxAttempts: 1 });
  });

  afterAll(async () => {
    sts?.destroy();
    await close?.();
  });

  it("exchanges an ID token for credentials without signing the request", async () => {
    const result = await sts.send(
      new AssumeRoleWithWebIdentityCommand({
        RoleArn: "arn:aws:iam::123456789012:role/github-actions",
        RoleSessionName: "ci-run",
        WebIdentityToken: idToken({
          iss: "https://token.actions.githubusercontent.com",
          sub: "repo:octo-org/app:ref:refs/heads/main",
          aud: "sts.amazonaws.com",
          exp: Math.floor(Date.now() / 1000) + 600,
        }),
        DurationSeconds: 1800,
      }),
    );
    expect(result.Credentials?.AccessKeyId).toMatch(/^ASIA/);
    expect(result.Credentials?.SecretAccessKey).toBeTruthy();
    expect(result.Credentials?.SessionToken).toBeTruthy();
    expect(result.Credentials?.Expiration).toBeInstanceOf(Date);
    expect(result.Credentials!.Expiration!.getTime()).toBeGreaterThan(Date.now() + 1_700_000);
    expect(result.AssumedRoleUser?.Arn).toBe("arn:aws:sts::123456789012:assumed-role/github-actions/ci-run");
    expect(result.SubjectFromWebIdentityToken).toBe("repo:octo-org/app:ref:refs/heads/main");
    expect(result.Audience).toBe("sts.amazonaws.com");
    expect(result.Provider).toBe("https://token.actions.githubusercontent.com");
    expect(result.$metadata.requestId).toBeTruthy();
  });

  it("surfaces modeled STS errors", async () => {
    await expect(
      sts.send(
        new AssumeRoleWithWebIdentityCommand({
          RoleArn: "arn:aws:iam::123456789012:role/github-actions",
          RoleSessionName: "ci-run",
          WebIdentityToken: "not-a-jwt",
        }),
      ),
    ).rejects.toMatchObject({ name: "InvalidIdentityTokenException", $metadata: { httpStatusCode: 400 } });
    await expect(
      sts.send(
        new AssumeRoleWithWebIdentityCommand({
          RoleArn: "arn:aws:iam::123456789012:role/unknown",
          RoleSessionName: "ci-run",
          WebIdentityToken: idToken({ iss: "https://issuer.test", sub: "user-1", aud: "client" }),
        }),
      ),
    ).rejects.toMatchObject({ name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
  });
});
