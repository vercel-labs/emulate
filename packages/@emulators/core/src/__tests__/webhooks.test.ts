import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "crypto";
import { WebhookDispatcher } from "../webhooks.js";

describe("WebhookDispatcher", () => {
  describe("register", () => {
    it("assigns auto-incrementing ids and returns the subscription", () => {
      const d = new WebhookDispatcher();
      const a = d.register({
        url: "https://a.example/hook",
        events: ["push"],
        active: true,
        owner: "o1",
      });
      const b = d.register({
        url: "https://b.example/hook",
        events: ["issues"],
        active: true,
        owner: "o2",
      });
      expect(a.id).toBe(1);
      expect(b.id).toBe(2);
      expect(a.url).toBe("https://a.example/hook");
    });

    it("accepts an explicit id and advances the internal counter", () => {
      const d = new WebhookDispatcher();
      const sub = d.register({
        id: 100,
        url: "https://x.example/hook",
        events: ["*"],
        active: true,
        owner: "o",
      });
      expect(sub.id).toBe(100);
      const next = d.register({
        url: "https://y.example/hook",
        events: ["push"],
        active: true,
        owner: "o",
      });
      expect(next.id).toBe(101);
    });
  });

  describe("unregister", () => {
    it("removes a subscription by id and returns false for missing ids", () => {
      const d = new WebhookDispatcher();
      const { id } = d.register({
        url: "https://a.example/hook",
        events: ["push"],
        active: true,
        owner: "o",
      });
      expect(d.unregister(id)).toBe(true);
      expect(d.getSubscription(id)).toBeUndefined();
      expect(d.unregister(id)).toBe(false);
      expect(d.unregister(999)).toBe(false);
    });
  });

  describe("getSubscription", () => {
    it("finds a subscription by id and returns undefined when missing", () => {
      const d = new WebhookDispatcher();
      const sub = d.register({
        url: "https://a.example/hook",
        events: ["push"],
        active: true,
        owner: "o",
      });
      expect(d.getSubscription(sub.id)).toEqual(sub);
      expect(d.getSubscription(404)).toBeUndefined();
    });
  });

  describe("getSubscriptions", () => {
    it("filters by owner", () => {
      const d = new WebhookDispatcher();
      d.register({
        url: "https://a.example/h1",
        events: ["push"],
        active: true,
        owner: "alice",
      });
      d.register({
        url: "https://b.example/h2",
        events: ["push"],
        active: true,
        owner: "bob",
      });

      const alice = d.getSubscriptions("alice");
      expect(alice).toHaveLength(1);
      expect(alice[0]!.owner).toBe("alice");
    });

    it("filters by owner and repo", () => {
      const d = new WebhookDispatcher();
      d.register({
        url: "https://a.example/r1",
        events: ["push"],
        active: true,
        owner: "org",
        repo: "r1",
      });
      d.register({
        url: "https://a.example/r2",
        events: ["push"],
        active: true,
        owner: "org",
        repo: "r2",
      });

      const r1 = d.getSubscriptions("org", "r1");
      expect(r1).toHaveLength(1);
      expect(r1[0]!.repo).toBe("r1");
    });
  });

  describe("updateSubscription", () => {
    it("updates allowed fields and returns undefined for missing ids", () => {
      const d = new WebhookDispatcher();
      const sub = d.register({
        url: "https://old.example/hook",
        events: ["push"],
        active: true,
        owner: "o",
      });

      const updated = d.updateSubscription(sub.id, {
        url: "https://new.example/hook",
        events: ["issues", "pull_request"],
        active: false,
        secret: "s",
      });
      expect(updated).toBeDefined();
      expect(updated!.url).toBe("https://new.example/hook");
      expect(updated!.events).toEqual(["issues", "pull_request"]);
      expect(updated!.active).toBe(false);
      expect(updated!.secret).toBe("s");

      expect(d.updateSubscription(999, { active: false })).toBeUndefined();
    });
  });

  describe("dispatch", () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    beforeEach(() => {
      mockFetch.mockClear();
      vi.stubGlobal("fetch", mockFetch);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("calls fetch for matching subscriptions", async () => {
      const d = new WebhookDispatcher();
      d.register({
        url: "https://hooks.example/1",
        events: ["push"],
        active: true,
        owner: "acme",
      });
      d.register({
        url: "https://hooks.example/2",
        events: ["push"],
        active: true,
        owner: "acme",
      });

      await d.dispatch("push", undefined, { ref: "main" }, "acme");

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls.map((c) => c[0])).toEqual(["https://hooks.example/1", "https://hooks.example/2"]);
    });

    it("respects event filtering (and allows ping for any subscription)", async () => {
      const d = new WebhookDispatcher();
      d.register({
        url: "https://hooks.example/push-only",
        events: ["push"],
        active: true,
        owner: "o",
      });

      await d.dispatch("issues", "opened", {}, "o");
      expect(mockFetch).not.toHaveBeenCalled();

      await d.dispatch("push", undefined, {}, "o");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      mockFetch.mockClear();
      d.register({
        url: "https://hooks.example/wildcard",
        events: ["*"],
        active: true,
        owner: "o2",
      });
      await d.dispatch("issues", "opened", {}, "o2");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      mockFetch.mockClear();
      d.register({
        url: "https://hooks.example/ping",
        events: ["push"],
        active: true,
        owner: "o3",
      });
      await d.dispatch("ping", undefined, {}, "o3");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("skips inactive subscriptions", async () => {
      const d = new WebhookDispatcher();
      d.register({
        url: "https://hooks.example/off",
        events: ["push"],
        active: false,
        owner: "o",
      });
      await d.dispatch("push", undefined, {}, "o");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("records deliveries with status and success from the response", async () => {
      const d = new WebhookDispatcher();
      const sub = d.register({
        url: "https://hooks.example/ok",
        events: ["push"],
        active: true,
        owner: "o",
      });

      await d.dispatch("push", undefined, { x: 1 }, "o");

      const deliveries = d.getDeliveries();
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]!.hook_id).toBe(sub.id);
      expect(deliveries[0]!.event).toBe("push");
      expect(deliveries[0]!.payload).toEqual({ x: 1 });
      expect(deliveries[0]!.status_code).toBe(200);
      expect(deliveries[0]!.success).toBe(true);
      expect(deliveries[0]!.duration).not.toBeNull();
    });

    it("records a failed delivery when the header factory throws", async () => {
      const d = new WebhookDispatcher();
      const sub = d.register({
        url: "https://hooks.example/fail",
        events: ["push"],
        active: true,
        owner: "o",
      });
      d.setHeaderFactory(() => {
        throw new Error("signing failed");
      });

      await d.dispatch("push", undefined, { x: 1 }, "o");

      expect(mockFetch).not.toHaveBeenCalled();
      expect(d.getDeliveries()).toEqual([
        expect.objectContaining({
          hook_id: sub.id,
          status_code: null,
          duration: 0,
          success: false,
        }),
      ]);
    });

    it("sets X-Hub-Signature-256 from HMAC-SHA256 when secret is set", async () => {
      const d = new WebhookDispatcher();
      const secret = "my-secret";
      d.register({
        url: "https://hooks.example/signed",
        events: ["push"],
        active: true,
        owner: "o",
        secret,
      });

      const payload = { action: "opened", number: 1 };
      await d.dispatch("push", undefined, payload, "o");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, init] = mockFetch.mock.calls[0]!;
      const body = (init as RequestInit).body as string;
      const headers = (init as RequestInit).headers as Record<string, string>;
      const expectedHmac = createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
      expect(headers["X-Hub-Signature-256"]).toBe(`sha256=${expectedHmac}`);
      expect(body).toBe(JSON.stringify(payload));
    });

    it("matches repo only when owner and repo align with the dispatch call", async () => {
      const d = new WebhookDispatcher();
      d.register({
        url: "https://hooks.example/repo-specific",
        events: ["push"],
        active: true,
        owner: "org",
        repo: "app",
      });

      await d.dispatch("push", undefined, {}, "org", "other");
      expect(mockFetch).not.toHaveBeenCalled();

      await d.dispatch("push", undefined, {}, "org", "app");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      mockFetch.mockClear();
      d.register({
        url: "https://hooks.example/no-repo-field",
        events: ["push"],
        active: true,
        owner: "org2",
      });
      await d.dispatch("push", undefined, {}, "org2");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("redeliver", () => {
    const mockFetch = vi.fn();

    beforeEach(() => {
      mockFetch.mockReset().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", mockFetch);
    });
    afterEach(() => vi.unstubAllGlobals());

    function setup() {
      const dispatcher = new WebhookDispatcher();
      const subscription = dispatcher.register({
        url: "https://hooks.example/original",
        events: ["issues"],
        active: true,
        owner: "acme",
        secret: "secret",
      });
      return { dispatcher, subscription };
    }

    it("replays the recorded payload only to its subscription and signs a new delivery", async () => {
      const { dispatcher, subscription } = setup();
      const payload = { action: "opened", issue: { title: "Original" } };
      await dispatcher.dispatch("issues", "opened", payload, "acme");
      payload.issue.title = "Changed after dispatch";
      dispatcher.register({ url: "https://hooks.example/new", events: ["*"], active: true, owner: "acme" });
      dispatcher.updateSubscription(subscription.id, { events: [] });

      const retry = await dispatcher.redeliver(1, { headers: { "X-Retry": "1" } });
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [url, request] = mockFetch.mock.calls[1]!;
      expect(url).toBe(subscription.url);
      expect(request.body).toBe(mockFetch.mock.calls[0]![1].body);
      expect(request.headers).toMatchObject({
        "X-GitHub-Event": "issues",
        "X-GitHub-Delivery": "2",
        "X-Retry": "1",
        "X-Hub-Signature-256": `sha256=${createHmac("sha256", "secret").update(request.body).digest("hex")}`,
      });
      expect(retry).toMatchObject({
        id: 2,
        hook_id: subscription.id,
        event: "issues",
        action: "opened",
        redelivery_of: 1,
        redelivery_count: 1,
        success: true,
      });
      expect(dispatcher.getDeliveries()[0]).not.toHaveProperty("redelivery_of");
    });

    it("runs the current custom header factory for each retry", async () => {
      const { dispatcher } = setup();
      const factory = vi.fn(({ deliveryId }) => ({
        "Content-Type": "application/json",
        "X-Attempt": String(deliveryId),
      }));
      dispatcher.setHeaderFactory(factory);
      await dispatcher.dispatch("issues", "opened", {}, "acme");
      await dispatcher.redeliver(1);
      await dispatcher.redeliver(2);
      expect(factory).toHaveBeenCalledTimes(3);
      expect(mockFetch.mock.calls[2]![1].headers["X-Attempt"]).toBe("3");
      expect(dispatcher.getDeliveries()[2]).toMatchObject({ redelivery_of: 2, redelivery_count: 2 });
    });

    it("does not send for unknown deliveries or inactive or deleted subscriptions", async () => {
      const { dispatcher, subscription } = setup();
      expect(await dispatcher.redeliver(999)).toBeUndefined();
      await dispatcher.dispatch("issues", undefined, {}, "acme");
      dispatcher.updateSubscription(subscription.id, { active: false });
      expect(await dispatcher.redeliver(1)).toBeUndefined();
      dispatcher.unregister(subscription.id);
      expect(await dispatcher.redeliver(1)).toBeUndefined();
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(dispatcher.getDeliveries()).toHaveLength(1);
    });

    it("records HTTP and transport failures without changing the original", async () => {
      const { dispatcher } = setup();
      await dispatcher.dispatch("issues", undefined, {}, "acme");
      mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
      expect(await dispatcher.redeliver(1)).toMatchObject({ id: 2, success: false, status_code: 503 });
      mockFetch.mockRejectedValueOnce(new Error("offline"));
      expect(await dispatcher.redeliver(2)).toMatchObject({
        id: 3,
        success: false,
        status_code: null,
        redelivery_count: 2,
      });
      expect(dispatcher.getDeliveries()[0]).toMatchObject({ success: true, status_code: 200 });
    });

    it("exposes a reserved attempt while delivery is still pending", async () => {
      const { dispatcher } = setup();
      await dispatcher.dispatch("issues", undefined, {}, "acme");
      let finish!: (value: { ok: boolean; status: number }) => void;
      mockFetch.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const pending = dispatcher.redeliver(1);
      expect(dispatcher.getDeliveries()[1]).toMatchObject({ id: 2, redelivery_count: 1, status_code: null });
      finish({ ok: true, status: 200 });
      expect(await pending).toMatchObject({ id: 2, success: true });
    });

    it("bounds retry history without resetting the retry count", async () => {
      const { dispatcher } = setup();
      await dispatcher.dispatch("issues", undefined, {}, "acme");
      for (let id = 1; id <= 1001; id++) await dispatcher.redeliver(id);
      expect(dispatcher.getDeliveries()).toHaveLength(1000);
      expect(dispatcher.getDeliveries().at(-1)).toMatchObject({ id: 1002, redelivery_count: 1001 });
      expect(await dispatcher.redeliver(1)).toBeUndefined();
    });
  });

  describe("getDeliveries", () => {
    it("returns all deliveries or filters by hook id", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", mockFetch);

      const d = new WebhookDispatcher();
      const a = d.register({
        url: "https://a.example/h",
        events: ["push"],
        active: true,
        owner: "o",
      });
      const b = d.register({
        url: "https://b.example/h",
        events: ["push"],
        active: true,
        owner: "o",
      });

      await d.dispatch("push", undefined, {}, "o");
      expect(d.getDeliveries()).toHaveLength(2);

      const forA = d.getDeliveries(a.id);
      expect(forA).toHaveLength(1);
      expect(forA[0]!.hook_id).toBe(a.id);

      const forB = d.getDeliveries(b.id);
      expect(forB).toHaveLength(1);
      expect(forB[0]!.hook_id).toBe(b.id);

      vi.unstubAllGlobals();
    });
  });

  describe("clear", () => {
    it("resets subscriptions, deliveries, and id counters", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", mockFetch);

      const d = new WebhookDispatcher();
      d.register({
        url: "https://a.example/h",
        events: ["push"],
        active: true,
        owner: "o",
      });
      await d.dispatch("push", undefined, {}, "o");

      d.clear();
      expect(d.getSubscriptions()).toHaveLength(0);
      expect(d.getDeliveries()).toHaveLength(0);

      const sub = d.register({
        url: "https://new.example/h",
        events: ["push"],
        active: true,
        owner: "o",
      });
      expect(sub.id).toBe(1);

      vi.unstubAllGlobals();
    });
  });

  describe("instance-scoped counters", () => {
    it("keeps subscription and delivery counters independent per instance", () => {
      const a = new WebhookDispatcher();
      const b = new WebhookDispatcher();

      expect(
        a.register({
          url: "https://a.example",
          events: ["push"],
          active: true,
          owner: "o",
        }).id,
      ).toBe(1);
      expect(
        b.register({
          url: "https://b.example",
          events: ["push"],
          active: true,
          owner: "o",
        }).id,
      ).toBe(1);

      a.clear();
      expect(
        a.register({
          url: "https://a2.example",
          events: ["push"],
          active: true,
          owner: "o",
        }).id,
      ).toBe(1);

      expect(
        b.register({
          url: "https://b2.example",
          events: ["push"],
          active: true,
          owner: "o",
        }).id,
      ).toBe(2);
    });
  });
});
