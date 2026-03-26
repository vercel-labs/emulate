import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Collection, Store, type Entity } from "../store.js";

interface User extends Entity {
  name: string;
  status?: string;
}

describe("Collection", () => {
  describe("CRUD", () => {
    let col: Collection<User>;

    beforeEach(() => {
      col = new Collection<User>();
    });

    it("insert returns item with auto-id and timestamps; get retrieves by id", () => {
      const item = col.insert({ name: "alice" });
      expect(item.id).toBe(1);
      expect(item.created_at).toBe(item.updated_at);
      expect(new Date(item.created_at).toString()).not.toBe("Invalid Date");

      const got = col.get(1);
      expect(got).toEqual(item);
    });

    it("update merges data and updates updated_at; delete removes item", () => {
      vi.useFakeTimers();
      const base = new Date("2020-01-01T00:00:00.000Z");
      vi.setSystemTime(base);
      const inserted = col.insert({ name: "bob" });
      const createdAt = inserted.created_at;

      vi.setSystemTime(new Date("2020-01-02T00:00:00.000Z"));
      const updated = col.update(1, { name: "robert", status: "active" });
      expect(updated).toBeDefined();
      expect(updated!.name).toBe("robert");
      expect(updated!.status).toBe("active");
      expect(updated!.id).toBe(1);
      expect(updated!.created_at).toBe(createdAt);
      expect(updated!.updated_at).not.toBe(createdAt);

      expect(col.delete(1)).toBe(true);
      expect(col.get(1)).toBeUndefined();
      vi.useRealTimers();
    });
  });

  describe("auto-incrementing IDs", () => {
    it("assigns sequential ids for successive inserts", () => {
      const col = new Collection<User>();
      expect(col.insert({ name: "a" }).id).toBe(1);
      expect(col.insert({ name: "b" }).id).toBe(2);
      expect(col.insert({ name: "c" }).id).toBe(3);
    });

    it("advances the counter when an explicit id is used", () => {
      const col = new Collection<User>();
      expect(col.insert({ id: 100, name: "x" }).id).toBe(100);
      expect(col.insert({ name: "y" }).id).toBe(101);
    });
  });

  describe("index lookups", () => {
    it("findBy uses indexes when indexFields are provided", () => {
      const col = new Collection<User>(["name"]);
      col.insert({ name: "dup", status: "a" });
      col.insert({ name: "dup", status: "b" });
      col.insert({ name: "other" });

      const matches = col.findBy("name", "dup");
      expect(matches).toHaveLength(2);
      expect(matches.map((m) => m.status).sort()).toEqual(["a", "b"]);
    });

    it("findOneBy returns the first match", () => {
      const col = new Collection<User>(["name"]);
      col.insert({ name: "same" });
      col.insert({ name: "same" });

      const one = col.findOneBy("name", "same");
      expect(one).toBeDefined();
      expect(one!.id).toBe(1);
    });
  });

  describe("findBy without index", () => {
    it("falls back to a linear scan for fields not in indexFields", () => {
      const col = new Collection<User>(["status"]);
      col.insert({ name: "first", status: "ok" });
      col.insert({ name: "second", status: "ok" });

      const byName = col.findBy("name", "second");
      expect(byName).toHaveLength(1);
      expect(byName[0]!.name).toBe("second");
    });
  });

  describe("pagination", () => {
    let col: Collection<User>;

    beforeEach(() => {
      col = new Collection<User>();
      for (let i = 1; i <= 35; i++) {
        col.insert({ name: `user-${i}` });
      }
    });

    it("uses default page 1 and per_page 30", () => {
      const r = col.query();
      expect(r.page).toBe(1);
      expect(r.per_page).toBe(30);
      expect(r.items).toHaveLength(30);
      expect(r.total_count).toBe(35);
    });

    it("computes has_next and has_prev across pages", () => {
      const p1 = col.query({ page: 1, per_page: 30 });
      expect(p1.has_prev).toBe(false);
      expect(p1.has_next).toBe(true);

      const p2 = col.query({ page: 2, per_page: 30 });
      expect(p2.has_prev).toBe(true);
      expect(p2.has_next).toBe(false);
      expect(p2.items).toHaveLength(5);
    });

    it("caps per_page at 100", () => {
      const col2 = new Collection<User>();
      for (let i = 0; i < 150; i++) {
        col2.insert({ name: `n-${i}` });
      }
      const r = col2.query({ page: 1, per_page: 200 });
      expect(r.per_page).toBe(100);
      expect(r.items).toHaveLength(100);
    });
  });

  describe("filter and sort", () => {
    it("applies filter, sort, or both in query", () => {
      const col = new Collection<User>();
      col.insert({ name: "a", status: "x" });
      col.insert({ name: "b", status: "y" });
      col.insert({ name: "c", status: "y" });

      const filtered = col.query({
        filter: (u) => u.status === "y",
      });
      expect(filtered.total_count).toBe(2);

      const sorted = col.query({
        sort: (a, b) => b.name.localeCompare(a.name),
      });
      expect(sorted.items[0]!.name).toBe("c");

      const both = col.query({
        filter: (u) => u.name !== "b",
        sort: (a, b) => a.name.localeCompare(b.name),
      });
      expect(both.items.map((u) => u.name)).toEqual(["a", "c"]);
    });
  });

  describe("count", () => {
    it("returns total size without a filter and filtered count with a filter", () => {
      const col = new Collection<User>();
      col.insert({ name: "a" });
      col.insert({ name: "b" });
      col.insert({ name: "c" });

      expect(col.count()).toBe(3);
      expect(col.count((u) => u.id > 1)).toBe(2);
    });
  });

  describe("clear", () => {
    it("resets items, indexes, and the auto-id counter", () => {
      const col = new Collection<User>(["name"]);
      col.insert({ name: "x" });
      col.insert({ id: 50, name: "y" });
      expect(col.findBy("name", "x")).toHaveLength(1);

      col.clear();
      expect(col.all()).toHaveLength(0);
      expect(col.findBy("name", "x")).toHaveLength(0);
      expect(col.insert({ name: "z" }).id).toBe(1);
    });
  });
});

describe("Store", () => {
  let store: Store;

  beforeEach(() => {
    store = new Store();
  });

  it("collection returns the same Collection for the same name", () => {
    const a = store.collection<User>("users");
    const b = store.collection<User>("users");
    expect(a).toBe(b);
  });

  it("collection returns different collections for different names", () => {
    const users = store.collection<User>("users");
    const posts = store.collection<User>("posts");
    expect(users).not.toBe(posts);
  });

  it("reset clears all collections", () => {
    const u = store.collection<User>("users");
    const p = store.collection<User>("posts");
    u.insert({ name: "u" });
    p.insert({ name: "p" });

    store.reset();
    expect(u.all()).toHaveLength(0);
    expect(p.all()).toHaveLength(0);
  });

  it("getData/setData stores arbitrary values and reset clears them", () => {
    store.setData("session", { token: "abc" });
    expect(store.getData<{ token: string }>("session")).toEqual({ token: "abc" });

    store.reset();
    expect(store.getData("session")).toBeUndefined();
  });
});

describe("InsertInput", () => {
  it("allows insert without an id field", () => {
    const col = new Collection<User>();
    const item = col.insert({ name: "no-id" });
    expect(item.id).toBe(1);
  });

  it("allows insert with an explicit id", () => {
    const col = new Collection<User>();
    const item = col.insert({ id: 42, name: "explicit" });
    expect(item.id).toBe(42);
  });
});

afterEach(() => {
  vi.useRealTimers();
});
