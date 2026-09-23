import assert from "node:assert/strict";
import { test } from "node:test";
import { createEmulator } from "emulate";
import inventory from "./inventory.ts";

test("reservations update inventory, cancellation restores it, and reset re-seeds", async () => {
  const api = await createEmulator({ service: inventory, listen: false });
  try {
    const response = await api.request("/reservations", { method: "POST" });
    assert.equal(response.status, 201);
    const reservation = (await response.json()) as { id: string };
    assert.deepEqual(await (await api.request("/inventory")).json(), { stock: 9 });
    assert.equal((await api.request("/reservations/" + reservation.id, { method: "DELETE" })).status, 204);
    assert.deepEqual(await (await api.request("/inventory")).json(), { stock: 10 });

    for (let i = 0; i < 10; i++) await api.request("/reservations", { method: "POST" });
    assert.equal((await api.request("/reservations", { method: "POST" })).status, 409);
    await api.reset();
    assert.deepEqual(await (await api.request("/inventory")).json(), { stock: 10 });
    assert.deepEqual(await (await api.request("/reservations")).json(), []);
  } finally {
    await api.close();
  }
});
