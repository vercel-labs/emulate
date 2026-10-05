import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw/http";
import { NetworkReadyState } from "msw/experimental";
import { Octokit } from "@octokit/rest";
import twilio from "twilio";
import Stripe from "stripe";
import { setupEmulatorNetwork } from "../index.js";

const emulate = await setupEmulatorNetwork({
  services: {
    github: { seed: { users: [{ login: "octocat" }], repos: [{ owner: "octocat", name: "hello-world" }] } },
    twilio: true,
    stripe: true,
  },
  tokens: { octocat_token: { login: "octocat", scopes: ["repo", "user", "admin:repo_hook"] } },
  handlers: [http.get("https://app.example.test/api/health", () => HttpResponse.json({ ok: true }))],
  onUnhandledFrame: "error",
});

beforeAll(() => emulate.enable());
afterEach(() => emulate.reset());
afterAll(() => emulate.close());

const octokit = new Octokit({ auth: "octocat_token" });
const repo = { owner: "octocat", repo: "hello-world" };

describe("setupEmulatorNetwork", () => {
  it("answers SDKs through socket-level interception", async () => {
    const { data: issue } = await octokit.rest.issues.create({ ...repo, title: "Through the network" });
    expect(issue.number).toBeGreaterThan(0);

    const verify = twilio("AC00000000000000000000000000000000", "twilio_test_auth_token").verify.v2.services(
      "VA00000000000000000000000000000000",
    );
    await verify.verifications.create({ to: "+15557654321", channel: "sms" });
    const check = await verify.verificationChecks.create({ to: "+15557654321", code: "123456" });
    expect(check.status).toBe("approved");

    const customer = await new Stripe("sk_test_emulated").customers.create({ email: "ada@example.com" });
    expect(customer.id).toMatch(/^cus_/);
  });

  it("runs its own handlers before the emulators", async () => {
    const res = await fetch("https://app.example.test/api/health");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("clears per-test overrides and emulator state with one reset", async () => {
    emulate.use(
      http.get("https://api.github.com/user", () => HttpResponse.json({ message: "Bad credentials" }, { status: 401 })),
    );
    await expect(octokit.rest.users.getAuthenticated()).rejects.toMatchObject({ status: 401 });
    await octokit.rest.issues.create({ ...repo, title: "Will be reset" });

    emulate.reset();

    const { data: me } = await octokit.rest.users.getAuthenticated();
    expect(me.login).toBe("octocat");
    const { data: issues } = await octokit.rest.issues.listForRepo(repo);
    expect(issues).toHaveLength(0);
  });

  it("routes emulator webhook deliveries through the network", async () => {
    const events: Array<string | null> = [];
    emulate.use(
      http.post("https://app.example.test/webhooks/github", ({ request }) => {
        events.push(request.headers.get("x-github-event"));
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await octokit.rest.repos.createWebhook({
      ...repo,
      events: ["issues"],
      config: { url: "https://app.example.test/webhooks/github", content_type: "json" },
    });
    await octokit.rest.issues.create({ ...repo, title: "Webhook" });

    await vi.waitFor(() => expect(events).toContain("issues"));
  });

  it("rejects requests that no handler or emulator serves", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(fetch("https://unmocked.example.test/")).rejects.toThrow();
    error.mockRestore();
  });

  it("exposes the underlying network", () => {
    expect(emulate.network.readyState).toBe(NetworkReadyState.ENABLED);
    expect(emulate.emulators.github.url).toBe("https://api.github.com");
  });
});
