import { describe, it, expect } from "vitest";
import { createEmulator } from "../api.js";

describe("createEmulator", () => {
  it("starts github and returns a url", async () => {
    const github = await createEmulator({ service: "github", port: 14000 });

    expect(github.url).toBe("http://localhost:14000");

    const res = await fetch(`${github.url}/user`, {
      headers: { Authorization: "token test_token_admin" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { login: string };
    expect(body.login).toBe("admin");

    await github.close();
  });

  it("starts multiple services independently", async () => {
    const [github, vercel] = await Promise.all([
      createEmulator({ service: "github", port: 14010 }),
      createEmulator({ service: "vercel", port: 14011 }),
    ]);

    expect(github.url).toBe("http://localhost:14010");
    expect(vercel.url).toBe("http://localhost:14011");

    await Promise.all([github.close(), vercel.close()]);
  });

  it("reset wipes and re-seeds stores", async () => {
    const github = await createEmulator({
      service: "github",
      port: 14020,
      seed: { github: { users: [{ login: "test-user" }] } },
    });

    const createRes = await fetch(`${github.url}/user/repos`, {
      method: "POST",
      headers: {
        Authorization: "token test_token_admin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "my-repo", private: false }),
    });
    expect(createRes.status).toBe(201);

    github.reset();

    const listRes = await fetch(`${github.url}/user/repos`, {
      headers: { Authorization: "token test_token_admin" },
    });
    expect(listRes.status).toBe(200);
    const repos = (await listRes.json()) as unknown[];
    expect(repos).toHaveLength(0);

    await github.close();
  });

  it("twilio sends SMS and lists messages", async () => {
    const twilio = await createEmulator({ service: "twilio", port: 14300 });

    const sendRes = await fetch(`${twilio.url}/2010-04-01/Accounts/AC_test/Messages.json`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "To=+15559876543&From=+15551234567&Body=Hello from emulate",
    });
    expect(sendRes.status).toBe(201);
    const msg = (await sendRes.json()) as { sid: string; body: string; status: string };
    expect(msg.sid).toMatch(/^SM/);
    expect(msg.body).toBe("Hello from emulate");
    expect(msg.status).toBe("delivered");

    const listRes = await fetch(`${twilio.url}/2010-04-01/Accounts/AC_test/Messages.json`);
    const list = (await listRes.json()) as { messages: Array<{ sid: string }> };
    expect(list.messages.length).toBeGreaterThanOrEqual(1);

    await twilio.close();
  });

  it("twilio verify sends code and checks it", async () => {
    const twilio = await createEmulator({ service: "twilio", port: 14310 });

    const sendRes = await fetch(`${twilio.url}/v2/Services/VA_default_service/Verifications`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "To=+15559876543&Channel=sms",
    });
    expect(sendRes.status).toBe(201);
    const verification = (await sendRes.json()) as { sid: string; status: string };
    expect(verification.sid).toMatch(/^VE/);
    expect(verification.status).toBe("pending");

    // Get the code from the verifications tab
    const inboxRes = await fetch(`${twilio.url}/?tab=verifications`);
    const html = await inboxRes.text();
    const codeMatch = html.match(/<code>(\d{6})<\/code>/);
    expect(codeMatch).toBeTruthy();

    const checkRes = await fetch(`${twilio.url}/v2/Services/VA_default_service/VerificationCheck`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `To=+15559876543&Code=${codeMatch![1]}`,
    });
    const result = (await checkRes.json()) as { status: string };
    expect(result.status).toBe("approved");

    await twilio.close();
  });

  it("throws on unknown service", async () => {
    // @ts-expect-error testing invalid service name
    await expect(createEmulator({ service: "unknown-svc" })).rejects.toThrow("Unknown service");
  });
});
