import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getResponse } from "msw";
import { http, HttpResponse } from "msw/http";
import { setupServer } from "msw/node";
import { Octokit } from "@octokit/rest";
import { WebClient } from "@slack/web-api";
import twilio from "twilio";
import Stripe from "stripe";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Resend } from "resend";
import { createEmulatorHandlers } from "../index.js";

// Every client below keeps its production URLs. No base URL, endpoint, or
// rewriting HTTP client points it at the emulator; MSW routes the real hosts.
const emulators = await createEmulatorHandlers({
  services: {
    github: {
      seed: {
        users: [{ login: "octocat" }],
        repos: [{ owner: "octocat", name: "hello-world", auto_init: true }],
      },
    },
    slack: {},
    twilio: {},
    stripe: {},
    aws: {},
    resend: {},
    google: {},
  },
  tokens: { octocat_token: { login: "octocat", scopes: ["repo", "user", "admin:repo_hook"] } },
});
const server = setupServer(...emulators.handlers);

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
  server.resetHandlers();
  emulators.reset();
});
afterAll(async () => {
  server.close();
  await emulators.close();
});

describe("GitHub via Octokit", () => {
  const octokit = new Octokit({ auth: "octocat_token" });
  const repo = { owner: "octocat", repo: "hello-world" };

  it("keeps state across real api.github.com requests", async () => {
    const { data: me } = await octokit.rest.users.getAuthenticated();
    expect(me.login).toBe("octocat");

    const { data: issue } = await octokit.rest.issues.create({ ...repo, title: "Emulated bug" });
    const { data: issues } = await octokit.rest.issues.listForRepo(repo);
    expect(issues.map((item) => item.number)).toContain(issue.number);
    expect(issue.url).toBe(`https://api.github.com/repos/octocat/hello-world/issues/${issue.number}`);
  });

  it("resets state between tests", async () => {
    const { data: issues } = await octokit.rest.issues.listForRepo(repo);
    expect(issues).toHaveLength(0);
  });

  it("lets per-test MSW overrides take priority", async () => {
    server.use(
      http.post(
        "https://api.github.com/repos/:owner/:repo/issues",
        () => HttpResponse.json({ message: "API rate limit exceeded" }, { status: 403 }),
        { once: true },
      ),
    );

    await expect(octokit.rest.issues.create({ ...repo, title: "Blocked" })).rejects.toMatchObject({ status: 403 });
    const { data: issue } = await octokit.rest.issues.create({ ...repo, title: "Allowed" });
    expect(issue.title).toBe("Allowed");
  });

  it("delivers webhooks through MSW so tests can route them in process", async () => {
    const deliveries: Array<{ event: string | null; signature: string | null; action?: string }> = [];
    server.use(
      http.post("https://app.example.test/webhooks/github", async ({ request }) => {
        const body = (await request.json()) as { action?: string };
        deliveries.push({
          event: request.headers.get("x-github-event"),
          signature: request.headers.get("x-hub-signature-256"),
          action: body.action,
        });
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await octokit.rest.repos.createWebhook({
      ...repo,
      events: ["issues"],
      config: { url: "https://app.example.test/webhooks/github", content_type: "json", secret: "shh" },
    });
    await octokit.rest.issues.create({ ...repo, title: "Triggers a webhook" });

    await vi.waitFor(() =>
      expect(deliveries).toContainEqual(expect.objectContaining({ event: "issues", action: "opened" })),
    );
    expect(deliveries.find((item) => item.event === "issues")?.signature).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});

describe("Slack via WebClient", () => {
  it("posts and reads messages on slack.com", async () => {
    const slack = new WebClient("xoxb-emulated");
    const { channels } = await slack.conversations.list();
    const general = channels?.find((channel) => channel.name === "general");
    expect(general?.id).toBeTruthy();

    await slack.chat.postMessage({ channel: general!.id!, text: "hello from msw" });
    const history = await slack.conversations.history({ channel: general!.id! });
    expect(history.messages?.map((message) => message.text)).toContain("hello from msw");
  });
});

describe("Twilio via the official SDK", () => {
  const client = twilio("AC00000000000000000000000000000000", "twilio_test_auth_token");

  it("sends messages on api.twilio.com", async () => {
    const message = await client.messages.create({ from: "+15551234567", to: "+15557654321", body: "hi" });
    expect(message.sid).toMatch(/^SM/);
    expect((await client.messages(message.sid).fetch()).body).toBe("hi");
  });

  it("runs Verify on verify.twilio.com without a custom HTTP client", async () => {
    const service = client.verify.v2.services("VA00000000000000000000000000000000");
    const verification = await service.verifications.create({ to: "+15557654321", channel: "sms" });
    expect(verification.status).toBe("pending");

    const check = await service.verificationChecks.create({ to: "+15557654321", code: "123456" });
    expect(check.status).toBe("approved");
  });
});

describe("Stripe via the official SDK", () => {
  it("creates and retrieves customers on api.stripe.com", async () => {
    const stripe = new Stripe("sk_test_emulated");
    const customer = await stripe.customers.create({ email: "ada@example.com" });
    expect((await stripe.customers.retrieve(customer.id)) as Stripe.Customer).toMatchObject({
      email: "ada@example.com",
    });
  });
});

describe("S3 via the AWS SDK", () => {
  it("round-trips an object through a virtual-hosted bucket URL", async () => {
    const s3 = new S3Client({
      region: "us-east-1",
      credentials: {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
    });

    await s3.send(new PutObjectCommand({ Bucket: "emulate-default", Key: "notes/hello.txt", Body: "hello s3" }));
    const object = await s3.send(new GetObjectCommand({ Bucket: "emulate-default", Key: "notes/hello.txt" }));
    expect(await object.Body?.transformToString()).toBe("hello s3");
  });
});

describe("Resend via the official SDK", () => {
  it("sends and reads email on api.resend.com", async () => {
    const resend = new Resend("re_test_key");
    const { data, error } = await resend.emails.send({
      from: "app@example.com",
      to: "ada@example.com",
      subject: "Welcome",
      html: "<p>Hi</p>",
    });
    expect(error).toBeNull();
    const { data: email } = await resend.emails.get(data!.id);
    expect(email?.subject).toBe("Welcome");
  });
});

describe("Google hosts", () => {
  it("advertises accounts.google.com as the issuer", async () => {
    const discovery = (await (await fetch("https://accounts.google.com/.well-known/openid-configuration")).json()) as {
      issuer: string;
    };
    expect(discovery.issuer).toBe("https://accounts.google.com");
  });

  it("maps the root token endpoint on oauth2.googleapis.com onto the emulator", async () => {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: "not-a-real-code" }),
    });
    expect(res.status).not.toBe(404);
    expect(((await res.json()) as { error?: string }).error).toBeTruthy();
  });
});

describe("handler matching", () => {
  it("ignores lookalike hosts", async () => {
    const response = await getResponse(emulators.handlers, new Request("https://api.github.com.evil.test/user"));
    expect(response).toBeUndefined();
  });
});
