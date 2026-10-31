import { createAdapterRuntime, createServer, Store } from "@emulators/core";
import { describe, expect, it, vi } from "vitest";
import { getResendStore, resendPlugin, seedFromConfig, type ResendSeedConfig } from "../index.js";

const base = "http://localhost:4000";
const payload = { from: "sender@example.com", to: "allowed@example.com", subject: "Delivery test" };

function setup(config: ResendSeedConfig = {}) {
  const server = createServer(resendPlugin, { tokens: { re_test: { login: "test", id: 1 } } });
  seedFromConfig(server.store, base, config);
  return { ...server, rs: getResendStore(server.store) };
}

function send(server: ReturnType<typeof setup>, body: unknown = payload, key?: string, batch = false) {
  return server.app.request(`${base}/emails${batch ? "/batch" : ""}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer re_test",
      ...(key !== undefined ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("Resend recipient restrictions and send attempts", () => {
  it("accepts all recipients by default and records normalized attempts without message bodies", async () => {
    const server = setup();
    const body = { ...payload, cc: "copy@example.com", bcc: ["hidden@example.com"], text: "private body" };
    expect((await send(server, body)).status).toBe(200);
    expect(server.rs.emails.all()).toHaveLength(1);
    expect(server.rs.sendAttempts.all()).toEqual([
      {
        id: 1,
        created_at: expect.any(String),
        updated_at: expect.any(String),
        from: payload.from,
        to: [payload.to],
        cc: ["copy@example.com"],
        bcc: ["hidden@example.com"],
        subject: payload.subject,
        idempotency_key: null,
      },
    ]);
    expect((await send(server, body)).status).toBe(200);
    expect(server.rs.sendAttempts.all()).toHaveLength(2);
  });

  it.each(["to", "cc", "bcc"])(
    "checks every %s recipient before creating an email or sending webhooks",
    async (field) => {
      const server = setup({ allowlist: [payload.to] });
      const dispatch = vi.spyOn(server.webhooks, "dispatch");
      const response = await send(server, { ...payload, [field]: [payload.to, "blocked@example.com"] }, "rejected");
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        statusCode: 403,
        name: "validation_error",
        message: "blocked@example.com is not in the allowlist: allowed@example.com.",
      });
      expect(server.rs.emails.all()).toHaveLength(0);
      expect(server.rs.idempotencyKeys.all()).toHaveLength(0);
      expect(server.rs.sendAttempts.all()).toHaveLength(1);
      expect(server.rs.sendAttempts.all()[0]).toMatchObject({ idempotency_key: "rejected" });
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it("rejects all recipients with an empty allowlist, including scheduled messages", async () => {
    const server = setup({ allowlist: [] });
    const response = await send(server, { ...payload, scheduled_at: "2099-01-01T00:00:00Z" });
    expect(response.status).toBe(403);
    expect(server.rs.emails.all()).toHaveLength(0);
    expect(server.rs.sendAttempts.all()).toHaveLength(1);
  });

  it("matches addresses case-insensitively after trimming and reports all rejected addresses once", async () => {
    const server = setup({ allowlist: [" ALLOWED@example.com ", "copy@example.com"] });
    expect((await send(server, { ...payload, cc: "Copy@EXAMPLE.com", bcc: ["allowed@example.com"] })).status).toBe(200);
    const response = await send(server, {
      ...payload,
      to: ["first@example.com", "second@example.com"],
      cc: "first@example.com",
      bcc: "third@example.com",
    });
    expect(response.status).toBe(403);
    expect((await response.json()) as { message: string }).toMatchObject({
      message:
        "first@example.com, second@example.com, third@example.com are not in the allowlist: ALLOWED@example.com, copy@example.com.",
    });
    expect(server.rs.sendAttempts.all()).toHaveLength(2);
  });

  it.each([undefined, "atomic-batch"])(
    "rejects a whole batch and lets retries create new attempts (key: %s)",
    async (key) => {
      const server = setup({ allowlist: [payload.to] });
      const dispatch = vi.spyOn(server.webhooks, "dispatch");
      const batch = [payload, { ...payload, to: "blocked@example.com", subject: "Second" }];
      for (let i = 0; i < 2; i++) {
        expect((await send(server, batch, key, true)).status).toBe(403);
        expect(server.rs.emails.all()).toHaveLength(0);
        expect(server.rs.idempotencyKeys.all()).toHaveLength(0);
        expect(server.rs.sendAttempts.all()).toHaveLength((i + 1) * 2);
      }
      expect(dispatch).not.toHaveBeenCalled();
      seedFromConfig(server.store, base, { allowlist: [payload.to, "blocked@example.com"] });
      const accepted = await send(server, batch, key, true);
      expect(accepted.status).toBe(200);
      expect(server.rs.emails.all()).toHaveLength(2);
      expect(server.rs.sendAttempts.all()).toHaveLength(6);
      expect(dispatch).toHaveBeenCalledTimes(4);
      if (key) {
        seedFromConfig(server.store, base, { allowlist: [] });
        const replay = await send(server, batch, key, true);
        expect(await replay.json()).toEqual(await accepted.json());
        expect(server.rs.sendAttempts.all()).toHaveLength(6);
        expect(dispatch).toHaveBeenCalledTimes(4);
      }
    },
  );

  it("records rejected single-send retries but no additional attempts for idempotency replays or conflicts", async () => {
    const server = setup({ allowlist: [] });
    for (let i = 0; i < 2; i++) {
      expect((await send(server, payload, "single")).status).toBe(403);
    }
    expect(server.rs.sendAttempts.all()).toHaveLength(2);
    expect(server.rs.idempotencyKeys.all()).toHaveLength(0);
    seedFromConfig(server.store, base, { allowlist: [payload.to] });
    const accepted = await send(server, payload, "single");
    expect(accepted.status).toBe(200);
    seedFromConfig(server.store, base, { allowlist: [] });
    const replay = await send(server, { ...payload, to: [payload.to] }, "single");
    expect(await replay.json()).toEqual(await accepted.json());
    expect((await send(server, { ...payload, subject: "Conflicting" }, "single")).status).toBe(409);
    expect(server.rs.sendAttempts.all()).toHaveLength(3);
    expect(server.rs.emails.all()).toHaveLength(1);
  });

  it("does not record malformed requests or invalid idempotency keys", async () => {
    const server = setup();
    for (const body of [
      null,
      {},
      { ...payload, to: [] },
      { ...payload, to: [17] },
      { ...payload, cc: {} },
      { ...payload, from: {} },
      { ...payload, subject: [] },
    ]) {
      expect((await send(server, body)).status).toBe(422);
      expect((await send(server, [payload, body], undefined, true)).status).toBe(422);
    }
    expect((await send(server, payload, "")).status).toBe(400);
    expect(server.rs.sendAttempts.all()).toHaveLength(0);
    expect(server.rs.emails.all()).toHaveLength(0);
  });

  it("preserves restrictions and attempts across snapshots and can read older snapshots", async () => {
    const server = setup({ allowlist: [] });
    await send(server);
    const restored = setup();
    restored.store.restore(JSON.parse(JSON.stringify(server.store.snapshot())));
    expect((await send(restored)).status).toBe(403);
    expect(restored.rs.sendAttempts.all()).toHaveLength(2);
    expect(restored.rs.sendAttempts.all().map((attempt) => attempt.id)).toEqual([1, 2]);

    const legacy = setup();
    legacy.store.restore(new Store().snapshot());
    expect((await send(legacy)).status).toBe(200);
    expect(getResendStore(legacy.store).sendAttempts.all()).toHaveLength(1);
  });

  it("persists a rejected attempt through the adapter's normal POST persistence", async () => {
    let saved: string | null = null;
    const runtime = createAdapterRuntime(
      {
        services: { resend: { emulator: { plugin: resendPlugin, seedFromConfig }, seed: { allowlist: [] } } },
        persistence: {
          load: async () => saved,
          save: async (value) => {
            saved = value;
          },
        },
      },
      (mount, service) => `${mount}/${service}`,
    );
    try {
      const response = await runtime.handle(
        new Request(`${base}/emulate/resend/emails`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer re_test" },
          body: JSON.stringify(payload),
        }),
        ["resend", "emails"],
        "/emulate",
      );
      expect(response.status).toBe(403);
    } finally {
      await runtime.close();
    }
    expect(saved).not.toBeNull();
    const snapshot = JSON.parse(saved!);
    expect(snapshot.store.collections["resend:resend.send_attempts"].items).toEqual([
      expect.objectContaining({ to: [payload.to], idempotency_key: null }),
    ]);
    expect(snapshot.store.collections["resend:resend.emails"].items).toEqual([]);
  });

  it.each([null, "allowed@example.com", [7], [""]])("rejects invalid allowlist config %j", (allowlist) => {
    const server = setup();
    expect(() => seedFromConfig(server.store, base, { allowlist } as ResendSeedConfig)).toThrow(/allowlist/);
  });
});
