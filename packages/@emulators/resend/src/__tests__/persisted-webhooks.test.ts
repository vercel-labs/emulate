import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAdapterRuntime, type PersistenceAdapter } from "@emulators/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resendPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";

let receiver: Server;
let receiverUrl: string;
let received: Array<{ path: string; body: string }>;

beforeEach(async () => {
  received = [];
  receiver = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ path: req.url ?? "", body });
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
});

function runtime(saved: { value: string | null }, seed: Record<string, unknown>) {
  const persistence: PersistenceAdapter = {
    load: async () => saved.value,
    save: async (value) => {
      saved.value = value;
    },
  };
  return createAdapterRuntime(
    {
      services: { resend: { emulator: { plugin: resendPlugin, seedFromConfig }, seed } },
      persistence,
    },
    (mount, service) => `${mount}/${service}`,
  );
}

function send(runtime: ReturnType<typeof runtime>) {
  return runtime.handle(
    new Request(`${base}/emulate/resend/emails`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer re_test" },
      body: JSON.stringify({ from: "sender@example.com", to: "user@example.com", subject: "Restarted" }),
    }),
    ["resend", "emails"],
    "/emulate",
  );
}

describe("Resend webhooks after a restart from persisted state", () => {
  it("re-registers enabled webhooks so they receive deliveries", async () => {
    const saved: { value: string | null } = { value: null };

    const first = runtime(saved, {
      webhook_hosts: ["127.0.0.1"],
      webhooks: [{ endpoint: `${receiverUrl}/hook`, events: ["email.sent"] }],
    });
    try {
      expect((await send(first)).status).toBe(200);
    } finally {
      await first.close();
    }
    expect(received).toHaveLength(1);
    expect(saved.value).not.toBeNull();

    received = [];
    // Restart with no webhook seed: the only webhook comes from the restored state.
    const second = runtime(saved, { webhook_hosts: ["127.0.0.1"] });
    try {
      const listed = await second.handle(
        new Request(`${base}/emulate/resend/webhooks`, {
          headers: { Authorization: "Bearer re_test" },
        }),
        ["resend", "webhooks"],
        "/emulate",
      );
      expect(listed.status).toBe(200);
      expect(((await listed.json()) as { data: unknown[] }).data).toHaveLength(1);

      expect((await send(second)).status).toBe(200);
    } finally {
      await second.close();
    }

    expect(received).toHaveLength(1);
    expect(received[0]!.path).toBe("/hook");
    expect(JSON.parse(received[0]!.body).type).toBe("email.sent");
  });
});
