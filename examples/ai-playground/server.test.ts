import assert from "node:assert/strict";
import { test } from "node:test";
import { startPlayground } from "./server.ts";

test("serves the playground, proxies emulator routes, and blocks cross-origin callers", async () => {
  const playground = await startPlayground({ port: 0, emulatorPort: 0 });
  try {
    const page = await fetch(playground.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
    assert.match(await page.text(), /<title>AI playground/);

    const rules = await fetch(`${playground.url}/_ai/rules`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: playground.url, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({
        rules: [{ id: "invoice", match: { textContains: "invoice" }, reply: [{ type: "text", text: "ok" }] }],
      }),
    });
    assert.equal(rules.status, 200);
    assert.equal(rules.headers.get("access-control-allow-origin"), null);

    const chat = await fetch(`${playground.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: playground.url },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "check invoice" }] }),
    });
    assert.equal(chat.status, 200);
    const json = (await chat.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(json.choices[0]?.message.content, "ok");

    const foreign = await fetch(`${playground.url}/_ai/calls`, {
      headers: { origin: "https://evil.example" },
    });
    assert.equal(foreign.status, 403);

    const crossSite = await fetch(`${playground.url}/_ai/reset`, {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
    });
    assert.equal(crossSite.status, 403);
  } finally {
    await playground.close();
  }
});
