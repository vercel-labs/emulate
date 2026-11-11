import { describe, expect, it } from "vitest";
import { getResponse } from "msw";
import { createEmulatorHandlers } from "../index.js";

describe("createEmulatorHandlers options", () => {
  it("defaults the advertised base URL to the primary real host", async () => {
    const { emulators, close } = await createEmulatorHandlers({ services: { twilio: true, github: {} } });
    expect(emulators.twilio.url).toBe("https://api.twilio.com");
    expect(emulators.github.url).toBe("https://api.github.com");
    await close();
  });

  it("routes a custom base URL for services whose host carries data", async () => {
    const { handlers, emulators, close } = await createEmulatorHandlers({
      services: { okta: { baseUrl: "https://dev-123.okta.com" } },
    });
    expect(emulators.okta.url).toBe("https://dev-123.okta.com");

    const response = await getResponse(
      handlers,
      new Request("https://dev-123.okta.com/oauth2/default/.well-known/openid-configuration"),
    );
    expect(response?.status).toBe(200);
    expect(((await response!.json()) as { issuer: string }).issuer).toBe("https://dev-123.okta.com/oauth2/default");
    await close();
  });

  it("routes a local advertised origin when a service has no primary host", async () => {
    const { handlers, emulators, close } = await createEmulatorHandlers({ services: { aws: {} } });
    expect(emulators.aws.url).toBe("http://aws.localhost");

    const response = await getResponse(handlers, new Request("http://aws.localhost/s3/"));
    expect(response?.status).toBe(200);
    await close();
  });

  it("rejects a translated host as the base URL", async () => {
    await expect(
      createEmulatorHandlers({ services: { twilio: { baseUrl: "https://verify.twilio.com" } } }),
    ).rejects.toThrow("translated host");
  });
});
