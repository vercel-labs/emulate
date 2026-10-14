import { beforeEach, describe, expect, it } from "vitest";
import type { Store } from "@emulators/core";
import { getSlackStore } from "../index.js";
import { parseSlackSearchQuery } from "../routes/search.js";
import { authHeaders, createSlackTestApp, slackTestBaseUrl as base, type SlackTestApp } from "./helpers.js";

const OTHER_TOKEN = "xoxp-other-user-token";

function addOtherUser(store: Store, tokenMap: SlackTestApp["tokenMap"]) {
  getSlackStore(store).users.insert({
    user_id: "U000000002",
    team_id: "T000000001",
    name: "carol",
    real_name: "Carol",
    email: "carol@emulate.dev",
    is_admin: false,
    is_bot: false,
    deleted: false,
    profile: { display_name: "carol", real_name: "Carol", email: "carol@emulate.dev", image_48: "", image_192: "" },
  });
  tokenMap.set(OTHER_TOKEN, { login: "U000000002", id: 2, scopes: [] });
}

async function call(app: SlackTestApp["app"], method: string, body: Record<string, unknown>, token?: string) {
  const headers = token ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } : authHeaders();
  const res = await app.request(`${base}/api/${method}`, { method: "POST", headers, body: JSON.stringify(body) });
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

describe("Slack plugin - users.conversations", () => {
  let app: SlackTestApp["app"];
  let store: Store;
  let tokenMap: SlackTestApp["tokenMap"];

  beforeEach(() => {
    ({ app, store, tokenMap } = createSlackTestApp());
    addOtherUser(store, tokenMap);
  });

  it("lists only the conversations the caller belongs to", async () => {
    await call(app, "conversations.create", { name: "carols-room" }, OTHER_TOKEN);
    const mine = await call(app, "conversations.create", { name: "my-room" });

    const body = await call(app, "users.conversations", {});

    expect(body.ok).toBe(true);
    const names = body.channels.map((ch: any) => ch.name);
    expect(names).toContain("my-room");
    expect(names).not.toContain("carols-room");
    expect(body.channels.find((ch: any) => ch.name === "my-room").id).toBe(mine.channel.id);
    expect(body.response_metadata.next_cursor).toBe("");
  });

  it("lists another user's public conversations but not private ones the caller cannot see", async () => {
    await call(app, "conversations.create", { name: "carols-room" }, OTHER_TOKEN);
    await call(app, "conversations.create", { name: "carols-secret", is_private: true }, OTHER_TOKEN);

    const body = await call(app, "users.conversations", {
      user: "U000000002",
      types: "public_channel,private_channel",
    });

    const names = body.channels.map((ch: any) => ch.name);
    expect(names).toContain("carols-room");
    expect(names).not.toContain("carols-secret");
  });

  it("filters by type and excludes archived conversations on request", async () => {
    const privateRoom = await call(app, "conversations.create", { name: "private-room", is_private: true });
    const archived = await call(app, "conversations.create", { name: "old-room" });
    await call(app, "conversations.archive", { channel: archived.channel.id });

    const publicOnly = await call(app, "users.conversations", {});
    expect(publicOnly.channels.map((ch: any) => ch.id)).not.toContain(privateRoom.channel.id);

    const withPrivate = await call(app, "users.conversations", {
      types: "public_channel,private_channel",
      exclude_archived: true,
    });
    const ids = withPrivate.channels.map((ch: any) => ch.id);
    expect(ids).toContain(privateRoom.channel.id);
    expect(ids).not.toContain(archived.channel.id);
  });

  it("paginates with a cursor", async () => {
    await call(app, "conversations.create", { name: "room-a" });
    await call(app, "conversations.create", { name: "room-b" });
    const all = await call(app, "users.conversations", {});

    const first = await call(app, "users.conversations", { limit: 1 });
    expect(first.channels).toHaveLength(1);
    const second = await call(app, "users.conversations", { limit: 1, cursor: first.response_metadata.next_cursor });

    expect(second.channels[0].id).toBe(all.channels[1].id);
  });

  it("returns user_not_found for an unknown user", async () => {
    const body = await call(app, "users.conversations", { user: "U999999999" });
    expect(body).toMatchObject({ ok: false, error: "user_not_found" });
  });
});

describe("Slack plugin - search.messages and search.all", () => {
  let app: SlackTestApp["app"];
  let store: Store;
  let tokenMap: SlackTestApp["tokenMap"];

  beforeEach(async () => {
    ({ app, store, tokenMap } = createSlackTestApp());
    addOtherUser(store, tokenMap);
    await call(app, "chat.postMessage", { channel: "general", text: "Refunds over $500 fail with a 502" }, OTHER_TOKEN);
    await call(app, "chat.postMessage", { channel: "general", text: "Lunch order is in" });
    await call(app, "chat.postMessage", { channel: "random", text: "refund policy question" });
    await call(app, "chat.postMessage", {
      channel: "random",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "Deploy of refunds-v2 is done" } }],
    });
  });

  it("matches every term, case-insensitively, across channels the caller can read", async () => {
    const body = await call(app, "search.messages", { query: "REFUND" });

    expect(body.ok).toBe(true);
    expect(body.query).toBe("REFUND");
    expect(body.messages.total).toBe(3);
    const both = await call(app, "search.messages", { query: "refunds 502" });
    expect(both.messages.matches.map((m: any) => m.text)).toEqual(["Refunds over $500 fail with a 502"]);
  });

  it("finds messages whose content is only in blocks", async () => {
    const body = await call(app, "search.messages", { query: "refunds-v2" });

    expect(body.messages.total).toBe(1);
    expect(body.messages.matches[0].blocks[0].text.text).toBe("Deploy of refunds-v2 is done");
  });

  it("applies in: and from: modifiers", async () => {
    const inRandom = await call(app, "search.messages", { query: "refund in:#random" });
    expect(inRandom.messages.matches.every((m: any) => m.channel.name === "random")).toBe(true);
    expect(inRandom.messages.total).toBe(2);

    const fromCarol = await call(app, "search.messages", { query: "refunds from:@carol" });
    expect(fromCarol.messages.total).toBe(1);
    expect(fromCarol.messages.matches[0]).toMatchObject({ user: "U000000002", username: "carol" });

    const byId = await call(app, "search.messages", { query: "from:<@U000000002>" });
    expect(byId.messages.total).toBe(1);
  });

  it("excludes private conversations the caller is not a member of", async () => {
    const secret = await call(app, "conversations.create", { name: "secret", is_private: true }, OTHER_TOKEN);
    await call(app, "chat.postMessage", { channel: secret.channel.id, text: "refund secret" }, OTHER_TOKEN);

    const body = await call(app, "search.messages", { query: "secret" });

    expect(body.messages.total).toBe(0);
  });

  it("returns Slack's match and paging shape, with permalinks", async () => {
    const body = await call(app, "search.messages", { query: "refund", count: 2, page: 2, sort: "timestamp" });

    expect(body.messages.paging).toEqual({ count: 2, total: 3, page: 2, pages: 2 });
    expect(body.messages.pagination).toMatchObject({ total_count: 3, page: 2, per_page: 2, first: 3, last: 3 });
    const [match] = body.messages.matches;
    expect(match).toMatchObject({ type: "message", channel: { name: "general", is_channel: true } });
    expect(match.permalink).toMatch(/\/archives\/C[A-Z0-9]+\/p\d+/);
  });

  it("sorts by timestamp in either direction", async () => {
    const desc = await call(app, "search.messages", { query: "refund", sort: "timestamp" });
    const asc = await call(app, "search.messages", { query: "refund", sort: "timestamp", sort_dir: "asc" });

    expect(asc.messages.matches.map((m: any) => m.ts)).toEqual(
      [...desc.messages.matches.map((m: any) => m.ts)].reverse(),
    );
  });

  it("rejects an empty query", async () => {
    const body = await call(app, "search.messages", { query: "  " });
    expect(body).toMatchObject({ ok: false, error: "no_query" });
  });

  it("search.all returns message matches with empty file results", async () => {
    const body = await call(app, "search.all", { query: "refund" });

    expect(body.ok).toBe(true);
    expect(body.messages.total).toBe(3);
    expect(body.files).toMatchObject({ total: 0, matches: [] });
  });
});

describe("parseSlackSearchQuery", () => {
  it("separates terms, quoted phrases, and modifiers", () => {
    expect(parseSlackSearchQuery('"refunds over" in:#support from:<@U123|bob> 502')).toEqual({
      terms: ["refunds over", "502"],
      inChannels: ["support"],
      fromUsers: ["U123"],
    });
  });

  it("parses date modifiers and keeps an invalid date as a term", () => {
    const parsed = parseSlackSearchQuery("after:2026-09-01 before:2026-09-30 on:not-a-date");
    expect(parsed.after).toBe(Date.parse("2026-09-02T00:00:00Z"));
    expect(parsed.before).toBe(Date.parse("2026-09-30T00:00:00Z"));
    expect(parsed.terms).toEqual(["on:not-a-date"]);
  });
});
