import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { board as sdk } from "@vercel/board";
import { vb } from "@vercel/board/cli";
import { createServer, serve } from "@emulators/core";
import type { Store } from "@emulators/core";
import type { Server } from "node:http";
import { vercelPlugin, seedFromConfig } from "../index.js";

const TEST_TOKENS = [
  ["test_token_admin", "admin"],
  ["test_token_dev", "developer"],
  ["test_token_viewer", "viewer"],
] as const;

let server: Server;
let api: string;
let storeRef: Store;

function rewrite(input: string | URL | Request): string {
  const original = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const target = new URL(original);
  const local = new URL(api);
  target.protocol = local.protocol;
  target.host = local.host;
  return target.toString();
}

function as(token: string): typeof fetch {
  return (input, init = {}) => {
    const headers = new Headers(init.headers);
    if (token) headers.set("authorization", `Bearer ${token}`);
    return globalThis.fetch(rewrite(input), { ...init, headers });
  };
}

beforeAll(async () => {
  const { app, store } = createServer(vercelPlugin, {
    port: 0,
    tokens: Object.fromEntries(TEST_TOKENS.map(([token, login], i) => [token, { login, id: i + 1 }])),
  });
  server = serve({ fetch: (request) => app.fetch(request), port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  storeRef = store;
  vercelPlugin.seed?.(store, api);
  seedFromConfig(store, api, {
    users: [
      { username: "admin", name: "Admin", email: "admin@example.com" },
      { username: "developer", name: "Developer", email: "developer@example.com" },
      { username: "viewer", name: "Viewer", email: "viewer@example.com" },
    ],
    teams: [{ slug: "acme", name: "Acme" }],
    projects: [{ name: "web", team: "acme", framework: "nextjs" }],
    boards: [
      {
        name: "General",
        team: "acme",
        default: true,
        channels: ["general", "random"],
        threads: [
          {
            channel: "general",
            by: "admin",
            text: "Welcome to the board",
            reactions: [{ emoji: "tada", by: "developer" }],
            replies: [{ text: "first reply", by: "developer" }],
          },
        ],
      },
    ],
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

describe("Vercel board emulator", () => {
  it("serves a board the real SDK reads and writes", async () => {
    const team = sdk({ fetch: as("test_token_admin") });
    const me = await team.me();
    expect(me.principal).toContain("vercel:user:");
    expect(me.can["*"]).toContain("post");

    const channels = await team.channels();
    expect(channels.channels.map((channel) => channel.path)).toEqual(expect.arrayContaining(["general", "random"]));

    const posted = await team.post("general", "hello from the SDK");
    expect(posted.text).toBe("hello from the SDK");
    expect(posted.channel).toBe("general");
    expect(posted.re).toBeNull();

    const replied = await team.reply(posted.id, "on it");
    expect(replied.re).toBe(posted.id);
    expect(replied.replyTo).toBeNull();

    const thread = await team.thread(posted.id);
    expect(thread.message.text).toBe("hello from the SDK");
    expect(thread.replies.map((message) => message.text)).toContain("on it");

    await team.react(posted.id, "eyes");
    const reacted = await team.thread(posted.id);
    expect(reacted.message.reactions.eyes?.length).toBe(1);

    await team.label(posted.id, { set: { status: "open" } });
    const labeled = await team.thread(posted.id);
    expect(labeled.message.labels).toMatchObject({ status: "open" });
  });

  it("runs the real vb CLI commands on the emulator", async () => {
    const team = sdk({ fetch: as("test_token_admin") });
    const posted = await vb(team, ["post", "general", "from vb"]);
    expect(posted.code).toBe(0);
    const messageId = posted.stdout.trim().split(/\s+/).at(-1)!;
    expect(messageId).toMatch(/^msg_/);

    const replied = await vb(team, ["reply", messageId, "a vb reply"]);
    expect(replied.code).toBe(0);

    const read = await vb(team, ["read", "general", "--json"]);
    expect(read.code).toBe(0);
    const page = JSON.parse(read.stdout);
    expect(page.threads.some((thread: { message: { text: string } }) => thread.message.text === "from vb")).toBe(true);
    expect(
      page.threads.find((thread: { message: { text: string } }) => thread.message.text === "from vb").last.text,
    ).toBe("a vb reply");

    const reacted = await vb(team, ["react", messageId, "eyes"]);
    expect(reacted.code).toBe(0);
  });

  it("wakes a waiter when a reply is posted", async () => {
    const team = sdk({ fetch: as("test_token_admin") });
    const posted = await team.post("general", "waiting for an answer");
    const waiting = vb(team, ["wait", "general", "--timeout", "10", "--json"], { signal: AbortSignal.timeout(15_000) });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await team.reply(posted.id, "the answer");
    const woken = await waiting;
    expect(woken.code).toBe(0);
    expect(woken.stdout).toContain("the answer");
  });

  it("refuses grants to a project and allows a person", async () => {
    const person = sdk({ fetch: as("test_token_admin") });
    const listed = await vb(person, ["grants", "list", "--json"]);
    expect(listed.code).toBe(0);
    const grants = JSON.parse(listed.stdout);
    expect(grants.grants.length).toBeGreaterThanOrEqual(3);

    const project = sdk({ fetch: as("project:web:production") });
    const refused = await vb(project, ["grants", "list", "--json"]);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("grant_forbidden");
  });
});

type Json = { status: number; body: any };

async function call(method: string, path: string, options: { token?: string; body?: unknown } = {}): Promise<Json> {
  const response = await globalThis.fetch(`${api}/v1/messageboard${path}`, {
    method,
    headers: {
      ...(options.token !== undefined ? { authorization: `Bearer ${options.token}` } : {}),
      "content-type": "application/json",
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function defaultBoard(token = "test_token_admin"): Promise<string> {
  const found = await call("GET", "/boards", { token });
  return found.body.defaultBoardId;
}

describe("Vercel board API surface", () => {
  it("answers the API's error shapes for channels and messages", async () => {
    const board = await defaultBoard();
    const created = await call("POST", `/boards/${board}/channels`, {
      token: "test_token_admin",
      body: { name: "dev/ops" },
    });
    expect(created.status).toBe(200);

    const again = await call("POST", `/boards/${board}/channels`, {
      token: "test_token_admin",
      body: { name: "dev/ops" },
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("channel_name_taken");

    const bad = await call("POST", `/boards/${board}/channels`, {
      token: "test_token_admin",
      body: { name: "Not A Channel" },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_channel_name");

    const reserved = await call("POST", `/boards/${board}/threads`, {
      token: "test_token_admin",
      body: { channel: "general", text: "no", labels: { "board.task": "ready" } },
    });
    expect(reserved.status).toBe(400);
    expect(reserved.body.error.code).toBe("reserved_label");

    const unknown = await call("GET", `/boards/${board}/channels/chn_missing`, { token: "test_token_admin" });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("channel_not_found");
  });

  it("enforces grants per channel and answers the API's refusal codes", async () => {
    const person = "test_token_admin";
    const project = "project:web:production";
    const made = await call("POST", "/boards/ensure", { token: person, body: { name: "Ops" } });
    expect(made.status).toBe(200);
    const board = made.body.board.id as string;

    const before = await call("POST", `/boards/${board}/threads`, {
      token: project,
      body: { channel: "general", text: "from the project" },
    });
    expect(before.status).toBe(200);

    const grants = await call("GET", `/boards/${board}/grants`, { token: person });
    expect(grants.status).toBe(200);
    const allProjects = grants.body.grants.find((grant: any) =>
      grant.principals.some((principal: any) => principal.kind === "all-projects"),
    );
    const revoked = await call("POST", `/boards/${board}/grants/${allProjects.id}/revoke`, { token: person, body: {} });
    expect(revoked.status).toBe(200);
    expect(revoked.body.revoked).toBe(true);

    const denied = await call("POST", `/boards/${board}/threads`, {
      token: project,
      body: { channel: "general", text: "still here" },
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("forbidden");

    const narrow = await call("POST", `/boards/${board}/grants`, {
      token: person,
      body: {
        principals: [{ kind: "project", projectId: "web", environments: ["production"] }],
        can: { general: ["read", "post"] },
      },
    });
    expect(narrow.status).toBe(200);
    expect(narrow.body.grant.principals[0]).toMatchObject({
      kind: "project",
      name: "web",
      environments: ["production"],
    });

    const allowed = await call("POST", `/boards/${board}/threads`, {
      token: project,
      body: { channel: "general", text: "narrow access" },
    });
    expect(allowed.status).toBe(200);
    const elsewhere = await call("POST", `/boards/${board}/threads`, {
      token: project,
      body: { channel: "random", text: "not here" },
    });
    expect(elsewhere.status).toBe(403);

    const unreadable = await call("GET", `/boards/${board}/channels?name=random`, { token: project });
    expect(unreadable.status).toBe(200);
    expect(unreadable.body.channels).toEqual([]);

    const explained = await call(
      "GET",
      `/boards/${board}/grants/explain?channel=general&project=web&environment=production`,
      { token: person },
    );
    expect(explained.status).toBe(200);
    expect(explained.body.can).toEqual(expect.arrayContaining(["read", "post"]));
    expect(explained.body.pattern).toBe("general");

    const projectList = await call("GET", `/boards/${board}/grants`, { token: project });
    expect(projectList.status).toBe(403);
    expect(projectList.body.error.code).toBe("grant_forbidden");
  });

  it("answers label and revision conflicts as the API does", async () => {
    const board = await defaultBoard("test_token_dev");
    const posted = await call("POST", `/boards/${board}/threads`, {
      token: "test_token_dev",
      body: { channel: "general", text: "conflicts" },
    });
    const message = posted.body.message;
    await new Promise((resolve) => setTimeout(resolve, 5));

    const labeled = await call(
      "POST",
      `/boards/${board}/threads/${message.threadId}/messages/${message.sequence}/labels`,
      {
        token: "test_token_dev",
        body: { set: { state: "open" } },
      },
    );
    expect(labeled.status).toBe(200);
    expect(labeled.body.meta.labels).toMatchObject({ state: "open" });

    const conflict = await call(
      "POST",
      `/boards/${board}/threads/${message.threadId}/messages/${message.sequence}/labels`,
      {
        token: "test_token_dev",
        body: { set: { state: "closed" }, if: { state: "open" } },
      },
    );
    expect(conflict.status).toBe(200);
    const second = await call(
      "POST",
      `/boards/${board}/threads/${message.threadId}/messages/${message.sequence}/labels`,
      {
        token: "test_token_dev",
        body: { set: { state: "open" }, if: { state: "open" } },
      },
    );
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("label_conflict");

    const edited = await call("PATCH", `/boards/${board}/threads/${message.threadId}/messages/${message.sequence}`, {
      token: "test_token_dev",
      body: { text: "changed", revision: 1 },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.message.revision).toBe(2);

    const stale = await call("PATCH", `/boards/${board}/threads/${message.threadId}/messages/${message.sequence}`, {
      token: "test_token_dev",
      body: { text: "again", revision: 1 },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("revision_conflict");

    const admin = await call("PATCH", `/boards/${board}/threads/${message.threadId}/messages/${message.sequence}`, {
      token: "test_token_admin",
      body: { text: "not mine" },
    });
    expect(admin.status).toBe(403);
    expect(admin.body.error.code).toBe("message_not_owned");

    const emoji = await call(
      "POST",
      `/boards/${board}/threads/${message.threadId}/messages/${message.sequence}/reactions`,
      {
        token: "test_token_dev",
        body: { emoji: "Not Emoji" },
      },
    );
    expect(emoji.status).toBe(400);
    expect(emoji.body.error.code).toBe("invalid_emoji");

    const first = await call("POST", `/boards/${board}/threads/${message.threadId}/messages`, {
      token: "test_token_dev",
      body: { text: "first reply" },
    });
    expect(first.status).toBe(200);
    const reply = await call("POST", `/boards/${board}/threads/${message.threadId}/messages`, {
      token: "test_token_dev",
      body: { text: "reply", after: 1 },
    });
    expect(reply.status).toBe(409);
    expect(reply.body.error.code).toBe("newer_message");
  });

  it("narrows a caller with x-board-can and caps a team viewer", async () => {
    const board = await defaultBoard("test_token_admin");
    const narrowed = await globalThis.fetch(`${api}/v1/messageboard/boards/${board}/me`, {
      headers: { authorization: "Bearer test_token_admin", "x-board-can": "general=read" },
    });
    expect(narrowed.status).toBe(200);
    expect(((await narrowed.json()) as any).can).toEqual({ general: ["read"] });

    const narrowedPost = await globalThis.fetch(`${api}/v1/messageboard/boards/${board}/threads`, {
      method: "POST",
      headers: {
        authorization: "Bearer test_token_admin",
        "x-board-can": "general=read",
        "content-type": "application/json",
      },
      body: JSON.stringify({ channel: "general", text: "not allowed" }),
    });
    expect(narrowedPost.status).toBe(403);
    expect(((await narrowedPost.json()) as any).error.code).toBe("forbidden");

    const { getVercelStore } = await import("../index.js");
    const vs = getVercelStore(storeRef);
    const team = vs.teams.findOneBy("slug", "acme")!;
    const viewer = vs.users.findOneBy("username", "viewer")!;
    const member = vs.teamMembers.findBy("teamId", team.uid).find((found) => found.userId === viewer.uid)!;
    vs.teamMembers.update(member.id, { role: "VIEWER" });

    const viewerMe = await call("GET", `/boards/${board}/me`, { token: "test_token_viewer" });
    expect(viewerMe.status).toBe(200);
    expect(viewerMe.body.can["*"]).toEqual(["read", "react"]);
    const viewerPost = await call("POST", `/boards/${board}/threads`, {
      token: "test_token_viewer",
      body: { channel: "general", text: "no" },
    });
    expect(viewerPost.status).toBe(403);
    expect(viewerPost.body.error.code).toBe("forbidden");
  });

  it("feeds what comes next and long-polls for it", async () => {
    const board = await defaultBoard("test_token_admin");
    const latest = await call("GET", `/boards/${board}/changes?channel=random&from=latest`, {
      token: "test_token_admin",
    });
    expect(latest.status).toBe(200);
    const cursor = latest.body.cursor as string;

    const post = call("POST", `/boards/${board}/threads`, {
      token: "test_token_admin",
      body: { channel: "random", text: "feed me" },
    });
    const poll = await call(
      "GET",
      `/boards/${board}/changes?channel=random&include=message&wait=5&cursor=${encodeURIComponent(cursor)}`,
      {
        token: "test_token_admin",
      },
    );
    expect(poll.status).toBe(200);
    expect(poll.body.events).toHaveLength(1);
    expect(poll.body.events[0].type).toBe("message.posted");
    expect(poll.body.events[0].channel).toBe("random");
    expect(poll.body.events[0].currentMessage.text).toBe("feed me");
    await post;
  });

  it("runs vb's grants commands against the API", async () => {
    const team = sdk({ fetch: as("test_token_admin") });
    const created = await vb(team, [
      "grants",
      "create",
      "--user",
      "developer@example.com",
      "--can",
      "secret/=read",
      "--json",
    ]);
    expect(created.code).toBe(0);
    const grant = JSON.parse(created.stdout).grant;
    expect(grant.principals[0]).toMatchObject({ kind: "user", email: "developer@example.com" });
    expect(grant.can).toEqual({ "secret/": ["read"] });

    const explained = await vb(team, [
      "grants",
      "explain",
      "--user",
      "developer@example.com",
      "secret/incidents",
      "--json",
    ]);
    expect(explained.code).toBe(0);
    const explanation = JSON.parse(explained.stdout).explanation;
    expect(explanation.pattern).toBe("secret/");
    expect(explanation.can).toEqual(["read"]);

    const revoked = await vb(team, ["grants", "revoke", grant.id, "--json"]);
    expect(revoked.code).toBe(0);
    expect(JSON.parse(revoked.stdout)).toMatchObject({ grant: grant.id, outcome: "revoked" });
  });

  it("runs vb's live and label commands", { timeout: 15_000 }, async () => {
    const team = sdk({ fetch: as("test_token_admin") });
    const posted = await team.post("general", "label me");
    const labeled = await vb(team, ["label", posted.id, "kind=bug"]);
    expect(labeled.code).toBe(0);

    const thread = await vb(team, ["read", posted.id, "--json"]);
    expect(thread.code).toBe(0);
    expect(thread.stdout).toContain("label me");

    const tail = vb(team, ["tail", "general", "--json"], { signal: AbortSignal.timeout(1500) });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await team.post("general", "tail event");
    const seen = await tail;
    expect(seen.code).toBe(0);
    expect(seen.stdout).toContain("tail event");
  });
});
