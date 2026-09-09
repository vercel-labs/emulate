import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Mailgun from "mailgun.js";
import { DEFAULT_API_KEY, DEFAULT_DOMAIN, DEFAULT_LIST_ADDRESS } from "../index.js";
import { createMailgunTestApp, mailgunTestBaseUrl, type MailgunTestApp } from "./helpers.js";

describe("mailgun.js SDK against the emulator", () => {
  let ctx: MailgunTestApp;
  let mailgun: ReturnType<InstanceType<typeof Mailgun>["client"]>;

  beforeEach(() => {
    ctx = createMailgunTestApp();
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
      ctx.app.request(input instanceof Request ? input : String(input), init),
    );
    mailgun = new Mailgun(FormData).client({
      username: "api",
      key: DEFAULT_API_KEY,
      url: mailgunTestBaseUrl,
      useFetch: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gets, creates, updates, and destroys mailing lists like CyberHub", async () => {
    await expect(mailgun.lists.get("soc-acme@mail.example.com")).rejects.toMatchObject({ status: 404 });

    const list = await mailgun.lists.create({
      name: "SOC · Provider · Client",
      address: "soc-acme@mail.example.com",
      access_level: "everyone",
    });
    expect(list).toMatchObject({ address: "soc-acme@mail.example.com", access_level: "everyone", members_count: 0 });

    const member = await mailgun.lists.members.createMember(list.address, {
      name: "CYNA · cybersecurity",
      address: "soc@cyna.test",
    });
    expect(member).toMatchObject({ address: "soc@cyna.test", name: "CYNA · cybersecurity", subscribed: true });

    const fetched = await mailgun.lists.members.getMember(list.address, "soc@cyna.test");
    expect(fetched.address).toBe("soc@cyna.test");

    const updatedMember = await mailgun.lists.members.updateMember(list.address, "soc@cyna.test", {
      name: "SOC",
      address: "soc@cyna.test",
    });
    expect(updatedMember.name).toBe("SOC");

    const updated = await mailgun.lists.update(list.address, { access_level: "members", address: list.address });
    expect(updated.access_level).toBe("members");

    const pages = await mailgun.lists.list({ limit: 10 });
    expect(pages.items.map((item) => item.address).sort()).toEqual(["soc-acme@mail.example.com", DEFAULT_LIST_ADDRESS]);

    const members = await mailgun.lists.members.listMembers(list.address, { limit: 10 });
    expect(members.items).toHaveLength(1);

    await mailgun.lists.members.destroyMember(list.address, "soc@cyna.test");
    const destroyed = await mailgun.lists.destroy(list.address);
    expect(destroyed).toMatchObject({ address: list.address, message: "Mailing list has been removed" });
  });

  it("sends messages and reads events", async () => {
    const result = await mailgun.messages.create(DEFAULT_DOMAIN, {
      from: "Emulate <noreply@mail.example.com>",
      to: ["someone@example.com"],
      subject: "SDK hello",
      text: "Sent through mailgun.js",
      "o:tag": ["sdk"],
      "v:ticket": "42",
    });
    expect(result.message).toBe("Queued. Thank you.");
    expect(result.id).toMatch(/^<.+>$/);

    const events = await mailgun.events.get(DEFAULT_DOMAIN, { event: "delivered" });
    expect(events.items).toHaveLength(1);
    expect(events.items[0]).toMatchObject({ event: "delivered", recipient: "someone@example.com", tags: ["sdk"] });
    expect(events.items[0]["user-variables"]).toEqual({ ticket: "42" });

    const stored = await (
      mailgun.messages as unknown as {
        retrieveStoredEmail(domain: string, key: string): Promise<Record<string, unknown>>;
      }
    ).retrieveStoredEmail(
      DEFAULT_DOMAIN,
      String((events.items[0] as unknown as { storage: { key: string } }).storage.key),
    );
    expect(stored.subject).toBe("SDK hello");
  });

  it("surfaces Mailgun-shaped errors", async () => {
    await expect(
      mailgun.messages.create(DEFAULT_DOMAIN, { to: "a@example.com", text: "x" } as never),
    ).rejects.toMatchObject({
      status: 400,
      details: "'from' parameter is missing",
    });
    await expect(mailgun.domains.get("unknown.example.com")).rejects.toMatchObject({ status: 404 });
  });

  it("manages suppressions and domains", async () => {
    await mailgun.suppressions.create(DEFAULT_DOMAIN, "bounces", {
      address: "dead@example.com",
      code: 550,
      error: "mailbox unavailable",
    });
    const bounces = await mailgun.suppressions.list(DEFAULT_DOMAIN, "bounces");
    expect(bounces.items.map((item) => (item as { address?: string }).address)).toEqual(["dead@example.com"]);
    const bounce = await mailgun.suppressions.get(DEFAULT_DOMAIN, "bounces", "dead@example.com");
    expect(bounce).toMatchObject({ address: "dead@example.com", code: 550 });
    await mailgun.suppressions.destroy(DEFAULT_DOMAIN, "bounces", "dead@example.com");
    expect((await mailgun.suppressions.list(DEFAULT_DOMAIN, "bounces")).items).toHaveLength(0);

    const domains = await mailgun.domains.list();
    expect(domains.map((domain) => domain.name)).toContain(DEFAULT_DOMAIN);
    const domain = await mailgun.domains.get(DEFAULT_DOMAIN);
    expect(domain.smtp_login).toBe(`postmaster@${DEFAULT_DOMAIN}`);
  });
});
