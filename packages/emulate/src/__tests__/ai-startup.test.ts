import { describe, expect, it } from "vitest";
import { aiNetworkWarning } from "../ai-network.js";
import { aiSetupLines } from "../commands/start.js";

const serviceUrl = "http://localhost:4000";

describe("AI startup output", () => {
  it.each(["localhost", "127.0.0.1", "::1"])("prints the base URL with /v1 and no warning for %s", (host) => {
    const output = aiSetupLines(serviceUrl, host).join("\n");

    expect(output).toContain(`${serviceUrl}/v1`);
    expect(output).not.toContain("Warning:");
  });

  it("prints the base URL with /v1 and no warning when no host is set", () => {
    const output = aiSetupLines(serviceUrl).join("\n");

    expect(output).toContain(`${serviceUrl}/v1`);
    expect(output).toContain(`new Anthropic({ baseURL: "${serviceUrl}", apiKey: "test" })`);
    expect(output).not.toContain("Warning:");
  });

  it("warns when the service listens beyond loopback", () => {
    const output = aiSetupLines(serviceUrl, "0.0.0.0").join("\n");

    expect(output).toContain(`${serviceUrl}/v1`);
    expect(output).toContain(aiNetworkWarning("0.0.0.0"));
  });
});
