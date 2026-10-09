import { describe, it, expect } from "vitest";
import { findServiceHost, matchesHost, primaryHost, toEmulatorPath, type ServiceHost } from "../hosts.js";

const twilio: ServiceHost[] = [{ host: "api.twilio.com" }, { host: "verify.twilio.com", prefix: "/verify" }];

const s3: ServiceHost[] = [
  { host: "s3.*.amazonaws.com", toPath: (url) => `/s3${url.pathname}` },
  { host: "*.s3.*.amazonaws.com", toPath: (url) => `/s3/${url.hostname.split(".")[0]}${url.pathname}` },
];

describe("matchesHost", () => {
  it("matches exact hostnames case-insensitively", () => {
    expect(matchesHost("api.github.com", "api.github.com")).toBe(true);
    expect(matchesHost("api.github.com", "API.GitHub.com")).toBe(true);
    expect(matchesHost("api.github.com", "github.com")).toBe(false);
    expect(matchesHost("api.github.com", "api.github.com.evil.test")).toBe(false);
  });

  it("matches one or more labels for a wildcard", () => {
    expect(matchesHost("*.okta.com", "dev-123.okta.com")).toBe(true);
    expect(matchesHost("*.okta.com", "a.b.okta.com")).toBe(true);
    expect(matchesHost("*.okta.com", "okta.com")).toBe(false);
    expect(matchesHost("*.okta.com", "dev-123.okta.com.evil.test")).toBe(false);
  });

  it("does not treat dots as wildcards", () => {
    expect(matchesHost("api.github.com", "apixgithub.com")).toBe(false);
  });
});

describe("toEmulatorPath", () => {
  it("adds the host prefix and keeps the query string", () => {
    expect(toEmulatorPath(twilio, "https://verify.twilio.com/v2/Services?PageSize=5")).toBe(
      "/verify/v2/Services?PageSize=5",
    );
    expect(toEmulatorPath(twilio, "https://api.twilio.com/2010-04-01/Accounts.json")).toBe("/2010-04-01/Accounts.json");
  });

  it("uses toPath when the hostname carries data", () => {
    expect(toEmulatorPath(s3, "https://photos.s3.us-east-1.amazonaws.com/cat.png?x-id=GetObject")).toBe(
      "/s3/photos/cat.png?x-id=GetObject",
    );
    expect(toEmulatorPath(s3, "https://s3.us-east-1.amazonaws.com/photos/cat.png")).toBe("/s3/photos/cat.png");
  });

  it("returns undefined for unknown hosts", () => {
    expect(toEmulatorPath(twilio, "https://api.stripe.com/v1/customers")).toBeUndefined();
  });

  it("picks the first matching entry", () => {
    expect(findServiceHost(s3, "https://s3.us-east-1.amazonaws.com/photos")?.host).toBe("s3.*.amazonaws.com");
  });
});

describe("primaryHost", () => {
  it("returns the first untranslated exact host", () => {
    expect(primaryHost([{ host: "verify.twilio.com", prefix: "/verify" }, ...twilio])).toBe("api.twilio.com");
  });

  it("returns undefined when every host is translated or a wildcard", () => {
    expect(primaryHost(s3)).toBeUndefined();
    expect(primaryHost([{ host: "*.okta.com" }])).toBeUndefined();
  });
});
