import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "@emulators/core";
import type { AppEnv } from "@emulators/core";
import { createTestApp, testAuthHeaders as authHeaders, testBaseUrl as base } from "./helpers.js";

function xmlValue(xml: string, tagName: string): string | undefined {
  return xml.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`))?.[1];
}

describe("AWS plugin - STS dedicated route", () => {
  let app: Hono<AppEnv>;

  beforeEach(() => {
    app = createTestApp().app;
  });

  describe("AssumeRole", () => {
    it("returns 200 with synthetic credentials for an unseeded role ARN", async () => {
      const roleArn = "arn:aws:iam::000000000000:role/nirva-upload";
      const res = await app.request(`${base}/sts/`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
        body: `Action=AssumeRole&RoleArn=${encodeURIComponent(roleArn)}&RoleSessionName=test-session&Version=2011-06-15`,
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("<AssumeRoleResponse");
      expect(text).toContain("<AccessKeyId>");
      expect(text).toContain("<SecretAccessKey>");
      expect(text).toContain("<SessionToken>");
      expect(text).toContain("<Expiration>");

      const accessKeyId = xmlValue(text, "AccessKeyId");
      expect(accessKeyId).toBeDefined();
      expect(accessKeyId!.startsWith("ASIA")).toBe(true);

      const expiration = xmlValue(text, "Expiration");
      expect(expiration).toBeDefined();
      expect(Number.isFinite(Date.parse(expiration!))).toBe(true);

      const arn = xmlValue(text, "Arn");
      expect(arn).toBe(`${roleArn}/test-session`);
    });

    it("honors an in-range DurationSeconds", async () => {
      const before = Date.now();
      const res = await app.request(`${base}/sts/`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
        body:
          "Action=AssumeRole" +
          "&RoleArn=" +
          encodeURIComponent("arn:aws:iam::000000000000:role/short") +
          "&RoleSessionName=quick" +
          "&DurationSeconds=900",
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      const expiration = Date.parse(xmlValue(text, "Expiration") ?? "");
      // 900s is the STS minimum; expiration should be ~15 minutes from now.
      const minutes = (expiration - before) / 60000;
      expect(minutes).toBeGreaterThanOrEqual(14.5);
      expect(minutes).toBeLessThanOrEqual(15.5);
    });

    it("rejects out-of-range DurationSeconds with a ValidationError", async () => {
      // AWS rejects out-of-range durations rather than clamping them, so a
      // caller asking for less than 900s or more than 43200s gets a 400.
      const assume = (duration: string) =>
        app.request(`${base}/sts/`, {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
          body:
            "Action=AssumeRole" +
            "&RoleArn=" +
            encodeURIComponent("arn:aws:iam::000000000000:role/short") +
            "&RoleSessionName=quick" +
            `&DurationSeconds=${duration}`,
        });

      const tooLow = await assume("60");
      expect(tooLow.status).toBe(400);
      expect(await tooLow.text()).toContain("ValidationError");

      const tooHigh = await assume("99999");
      expect(tooHigh.status).toBe(400);
      const tooHighText = await tooHigh.text();
      expect(tooHighText).toContain("ValidationError");
      expect(tooHighText).toContain("43200");

      const notInteger = await assume("abc");
      expect(notInteger.status).toBe(400);
      expect(await notInteger.text()).toContain("ValidationError");

      // Boundary values are accepted.
      const minOk = await assume("900");
      expect(minOk.status).toBe(200);
      const maxOk = await assume("43200");
      expect(maxOk.status).toBe(200);
    });

    it("rejects missing RoleArn / RoleSessionName", async () => {
      const res = await app.request(`${base}/sts/`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
        body: "Action=AssumeRole",
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("ValidationError");
    });

    it("works at the AWS-SDK wire-format root path POST /", async () => {
      const roleArn = "arn:aws:iam::000000000000:role/sdk-style";
      const res = await app.request(`${base}/`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
        body: `Action=AssumeRole&RoleArn=${encodeURIComponent(roleArn)}&RoleSessionName=sdk-test&Version=2011-06-15`,
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("<AssumeRoleResponse");
      expect(xmlValue(text, "AccessKeyId")).toMatch(/^ASIA/);
    });
  });

  describe("GetCallerIdentity", () => {
    it("returns the synthetic caller envelope at /sts/", async () => {
      const res = await app.request(`${base}/sts/`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
        body: "Action=GetCallerIdentity&Version=2011-06-15",
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("<GetCallerIdentityResponse");
      expect(xmlValue(text, "Account")).toBe("123456789012");
      expect(xmlValue(text, "Arn")).toBe("arn:aws:iam::123456789012:user/admin");
      expect(xmlValue(text, "UserId")).toBeDefined();
    });

    it("works at the AWS-SDK wire-format root path POST /", async () => {
      const res = await app.request(`${base}/`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
        body: "Action=GetCallerIdentity&Version=2011-06-15",
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("<GetCallerIdentityResponse");
    });
  });

  describe("Action validation", () => {
    it("returns InvalidAction for unknown actions on /sts/", async () => {
      const res = await app.request(`${base}/sts/`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
        body: "Action=DoesNotExist",
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("InvalidAction");
    });

    it("does not hijack non-STS POST / requests", async () => {
      // POST / with no STS action should not be claimed by STS dispatch.
      const res = await app.request(`${base}/`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
        body: "Action=ListBuckets",
      });
      expect(res.status).toBe(404);
    });

    it("does not hijack POST / with non-form content types", async () => {
      const res = await app.request(`${base}/`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: '{"Action":"AssumeRole"}',
      });
      expect(res.status).toBe(404);
    });
  });

  describe("Boto3-style response parsing", () => {
    it("AssumeRole XML parses into the structure boto3 expects", async () => {
      const res = await app.request(`${base}/`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
        body: `Action=AssumeRole&RoleArn=${encodeURIComponent("arn:aws:iam::000000000000:role/p")}&RoleSessionName=p-session`,
      });
      expect(res.status).toBe(200);
      const text = await res.text();

      // Mirror the dict shape boto3 surfaces from the AWS XML response. Boto3's
      // botocore parser maps these tags into Credentials.{AccessKeyId,
      // SecretAccessKey, SessionToken, Expiration} and AssumedRoleUser.{Arn,
      // AssumedRoleId}.
      const credentials = {
        AccessKeyId: xmlValue(text, "AccessKeyId"),
        SecretAccessKey: xmlValue(text, "SecretAccessKey"),
        SessionToken: xmlValue(text, "SessionToken"),
        Expiration: xmlValue(text, "Expiration"),
      };
      expect(credentials.AccessKeyId).toBeTruthy();
      expect(credentials.SecretAccessKey).toBeTruthy();
      expect(credentials.SessionToken).toBeTruthy();
      expect(credentials.Expiration).toBeTruthy();
    });
  });
});
