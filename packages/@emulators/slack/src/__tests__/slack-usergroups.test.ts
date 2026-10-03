import { beforeEach, describe, expect, it } from "vitest";
import { Store } from "@emulators/core";
import { getSlackStore, seedFromConfig, slackPlugin } from "../index.js";
import { authHeaders, createSlackTestApp, slackTestBaseUrl as base, type SlackTestApp } from "./helpers.js";

function addUser(store: Store, userId: string, name: string, deleted = false) {
  getSlackStore(store).users.insert({
    user_id: userId,
    team_id: "T000000001",
    name,
    real_name: name,
    email: `${name}@emulate.dev`,
    is_admin: false,
    is_bot: false,
    deleted,
    profile: { display_name: name, real_name: name, email: `${name}@emulate.dev`, image_48: "", image_192: "" },
  });
}

async function call(app: SlackTestApp["app"], method: string, body: Record<string, unknown>) {
  const res = await app.request(`${base}/api/${method}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

describe("Slack plugin - usergroups", () => {
  let app: SlackTestApp["app"];
  let store: Store;

  beforeEach(() => {
    ({ app, store } = createSlackTestApp());
    addUser(store, "U000000002", "carol");
    addUser(store, "U000000003", "dave");
    addUser(store, "U000000004", "gone", true);
  });

  async function createGroup(fields: Record<string, unknown> = {}) {
    const body = await call(app, "usergroups.create", { name: "On-call", handle: "oncall", ...fields });
    expect(body.ok).toBe(true);
    return body.usergroup;
  }

  it("creates a group in Slack's shape, with a numeric user count", async () => {
    const body = await call(app, "usergroups.create", {
      name: "On-call",
      handle: "oncall",
      description: "Pager rotation",
      channels: "C000000001",
      include_count: true,
    });

    expect(body.ok).toBe(true);
    expect(body.usergroup).toMatchObject({
      team_id: "T000000001",
      is_usergroup: true,
      name: "On-call",
      handle: "oncall",
      description: "Pager rotation",
      is_external: false,
      date_delete: 0,
      auto_type: null,
      created_by: "U000000001",
      updated_by: "U000000001",
      deleted_by: null,
      prefs: { channels: ["C000000001"], groups: [] },
      users: [],
      user_count: 0,
    });
    expect(body.usergroup.id).toMatch(/^S/);
  });

  it("rejects a missing name, a duplicate name and invalid or taken handles", async () => {
    await createGroup();

    expect((await call(app, "usergroups.create", { handle: "x" })).error).toBe("missing_subteam_name");
    expect((await call(app, "usergroups.create", { name: "ON-CALL" })).error).toBe("name_already_exists");
    expect((await call(app, "usergroups.create", { name: "B", handle: "Bad Handle" })).error).toBe("bad_handle");
    // A handle is an @mention, so it may not reuse another group's, a member's or a channel's name.
    for (const handle of ["oncall", "carol", "general"]) {
      expect((await call(app, "usergroups.create", { name: `G ${handle}`, handle })).error).toBe(
        "handle_already_exists",
      );
    }
    expect((await call(app, "usergroups.create", { name: "C", channels: "C999" })).error).toBe(
      "invalid_channel_provided",
    );
  });

  it("lists enabled groups, with users and counts only on request", async () => {
    const group = await createGroup();
    await call(app, "usergroups.users.update", { usergroup: group.id, users: "U000000002,U000000003" });

    const plain = await call(app, "usergroups.list", {});
    expect(plain.usergroups).toHaveLength(1);
    expect(plain.usergroups[0].users).toBeUndefined();
    expect(plain.usergroups[0].user_count).toBeUndefined();

    const full = await call(app, "usergroups.list", { include_users: "true", include_count: "1" });
    expect(full.usergroups[0].users).toEqual(["U000000002", "U000000003"]);
    expect(full.usergroups[0].user_count).toBe(2);
  });

  it("replaces the member list and rejects unknown or deactivated users", async () => {
    const group = await createGroup();

    const first = await call(app, "usergroups.users.update", {
      usergroup: group.id,
      users: "U000000002,U000000003,U000000002",
      include_count: true,
    });
    expect(first.usergroup.users).toEqual(["U000000002", "U000000003"]);
    expect(first.usergroup.user_count).toBe(2);

    const second = await call(app, "usergroups.users.update", { usergroup: group.id, users: ["U000000003"] });
    expect(second.usergroup.users).toEqual(["U000000003"]);
    expect((await call(app, "usergroups.users.list", { usergroup: group.id })).users).toEqual(["U000000003"]);

    expect((await call(app, "usergroups.users.update", { usergroup: group.id, users: "" })).error).toBe(
      "no_users_provided",
    );
    for (const users of ["U999", "U000000004"]) {
      expect((await call(app, "usergroups.users.update", { usergroup: group.id, users })).error).toBe("invalid_users");
    }
    expect((await call(app, "usergroups.users.update", { usergroup: "S999", users: "U000000002" })).error).toBe(
      "no_such_subteam",
    );
  });

  it("updates metadata without touching members, and keeps its own handle and name free", async () => {
    const group = await createGroup();
    await call(app, "usergroups.users.update", { usergroup: group.id, users: "U000000002" });
    await createGroup({ name: "Platform", handle: "platform" });

    const body = await call(app, "usergroups.update", {
      usergroup: group.id,
      name: "On-call",
      handle: "oncall-primary",
      description: "Primary pager",
      channels: "C000000002",
    });
    expect(body.ok).toBe(true);
    expect(body.usergroup).toMatchObject({
      name: "On-call",
      handle: "oncall-primary",
      description: "Primary pager",
      prefs: { channels: ["C000000002"], groups: [] },
      users: ["U000000002"],
    });

    expect((await call(app, "usergroups.update", { usergroup: group.id, name: "platform" })).error).toBe(
      "name_already_exists",
    );
    expect((await call(app, "usergroups.update", { usergroup: group.id, handle: "platform" })).error).toBe(
      "handle_already_exists",
    );
    expect((await call(app, "usergroups.update", { usergroup: "S999", name: "x" })).error).toBe("no_such_subteam");
  });

  it("disables and re-enables a group, hiding it from default reads while disabled", async () => {
    const group = await createGroup();
    await call(app, "usergroups.users.update", { usergroup: group.id, users: "U000000002" });

    const disabled = await call(app, "usergroups.disable", { usergroup: group.id });
    expect(disabled.usergroup.date_delete).toBeGreaterThan(0);
    expect(disabled.usergroup.deleted_by).toBe("U000000001");

    expect((await call(app, "usergroups.list", {})).usergroups).toEqual([]);
    expect((await call(app, "usergroups.list", { include_disabled: true })).usergroups).toHaveLength(1);
    expect((await call(app, "usergroups.users.list", { usergroup: group.id })).error).toBe("no_such_subteam");
    expect((await call(app, "usergroups.users.list", { usergroup: group.id, include_disabled: true })).users).toEqual([
      "U000000002",
    ]);

    const enabled = await call(app, "usergroups.enable", { usergroup: group.id });
    expect(enabled.usergroup.date_delete).toBe(0);
    expect(enabled.usergroup.deleted_by).toBeNull();
    expect((await call(app, "usergroups.list", {})).usergroups).toHaveLength(1);
  });

  it("enforces usergroups scopes in strict mode", async () => {
    store.setData("slack.strict_scopes", true);

    const read = await call(app, "usergroups.list", {});
    expect(read.ok).toBe(false);
    expect(read.error).toBe("missing_scope");
    const write = await call(app, "usergroups.create", { name: "x" });
    expect(write.error).toBe("missing_scope");
  });
});

describe("Slack plugin - seedFromConfig usergroups", () => {
  function seededStore() {
    const store = new Store();
    slackPlugin.seed?.(store, base);
    seedFromConfig(store, base, {
      users: [{ name: "carol" }, { name: "dave" }],
      channels: [{ name: "incidents" }],
    });
    return store;
  }

  it("seeds groups with members and channels resolved by name or ID", () => {
    const store = seededStore();
    const ss = getSlackStore(store);
    const dave = ss.users.findOneBy("name", "dave")!;
    const incidents = ss.channels.findOneBy("name", "incidents")!;

    seedFromConfig(store, base, {
      usergroups: [
        { name: "On-call", handle: "oncall", users: ["carol", dave.user_id], channels: ["incidents"] },
        { name: "Retired", handle: "retired", disabled: true },
      ],
    });

    const oncall = ss.usergroups.findOneBy("handle", "oncall")!;
    expect(oncall.users).toEqual([ss.users.findOneBy("name", "carol")!.user_id, dave.user_id]);
    expect(oncall.channels).toEqual([incidents.channel_id]);
    expect(oncall.date_delete).toBe(0);
    expect(ss.usergroups.findOneBy("handle", "retired")!.date_delete).toBeGreaterThan(0);
  });

  it("fails loudly on a group that names an unknown user or channel", () => {
    const store = seededStore();
    expect(() => seedFromConfig(store, base, { usergroups: [{ name: "Typo", users: ["carlo"] }] })).toThrow(
      /unknown user "carlo"/,
    );
    expect(() => seedFromConfig(store, base, { usergroups: [{ name: "Typo", channels: ["incident"] }] })).toThrow(
      /unknown channel "incident"/,
    );
  });
});
