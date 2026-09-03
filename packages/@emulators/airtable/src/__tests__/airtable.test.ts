import { describe, it, expect, beforeEach } from "vitest";
import {
  Hono,
  Store,
  WebhookDispatcher,
  authMiddleware,
  createApiErrorHandler,
  createErrorHandler,
  type TokenMap,
} from "@emulators/core";
import { airtablePlugin, seedFromConfig, type AirtableSeedConfig } from "../index.js";

const BASE = "appTest0000000001";
const TABLE = "tblTasks000000001";

const SEED: AirtableSeedConfig = {
  user: {
    id: "usrTest0000000001",
    email: "dev@example.com",
    name: "Dev",
    scopes: ["data.records:read", "data.records:write", "schema.bases:read"],
  },
  bases: [
    {
      id: BASE,
      name: "Test Base",
      tables: [
        {
          id: TABLE,
          name: "Tasks",
          fields: [
            { id: "fldName0000000001", name: "Name", type: "singleLineText" },
            {
              id: "fldStatus00000001",
              name: "Status",
              type: "singleSelect",
              options: {
                choices: [
                  { id: "selTodo00000000001", name: "Todo" },
                  { id: "selDoing0000000001", name: "Doing" },
                  { id: "selDone00000000001", name: "Done" },
                ],
              },
            },
            { id: "fldPriority000001", name: "Priority", type: "number" },
            { id: "fldDone0000000001", name: "Done", type: "checkbox" },
          ],
          views: [{ id: "viwActive00000001", name: "Active", type: "grid", filter: '{Status}!="Done"' }],
          records: [
            { id: "recAlpha000000001", fields: { Name: "Alpha", Status: "Todo", Priority: 2, Done: false } },
            { id: "recBeta0000000001", fields: { Name: "Beta", Status: "Doing", Priority: 1, Done: false } },
            { id: "recGamma000000001", fields: { Name: "Gamma", Status: "Done", Priority: 3, Done: true } },
          ],
        },
      ],
    },
  ],
};

interface ATRecord {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
}
interface ListResp {
  records: ATRecord[];
  offset?: string;
}
interface ObjError {
  error: { type: string; message: string };
}
interface Comment {
  id: string;
  text: string;
  author: { email: string };
  mentioned?: Record<string, unknown>;
}

function makeApp(): Hono {
  const store = new Store();
  const app = new Hono();
  const tokenMap: TokenMap = new Map();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap, undefined, { login: "dev@example.com", id: 1, scopes: [] }));
  airtablePlugin.register(app, store, new WebhookDispatcher(), "http://localhost:4014", tokenMap);
  seedFromConfig(store, "http://localhost:4014", SEED);
  return app;
}

let app: Hono;
beforeEach(() => {
  app = makeApp();
});

async function req<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await app.fetch(
    new Request("http://localhost" + path, {
      method,
      headers: { Authorization: "Bearer patTest", "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );
  const text = await res.text();
  // Test boundary: the emulator's JSON response, shaped per the caller's T.
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

const enc = encodeURIComponent;
const names = (list: ListResp): unknown[] => list.records.map((r) => r.fields.Name);

describe("Airtable Meta API", () => {
  it("whoami returns id, email, and scopes", async () => {
    const { body } = await req<{ id: string; email: string; scopes: string[] }>("GET", "/v0/meta/whoami");
    expect(body).toEqual({
      id: "usrTest0000000001",
      email: "dev@example.com",
      scopes: ["data.records:read", "data.records:write", "schema.bases:read"],
    });
  });

  it("lists bases", async () => {
    const { body } = await req<{ bases: Array<{ id: string; name: string; permissionLevel: string }> }>(
      "GET",
      "/v0/meta/bases",
    );
    expect(body.bases).toEqual([{ id: BASE, name: "Test Base", permissionLevel: "create" }]);
  });

  it("returns the base schema with fields and views", async () => {
    const { body } = await req<{
      tables: Array<{ id: string; primaryFieldId: string; fields: unknown[]; views: unknown[] }>;
    }>("GET", `/v0/meta/bases/${BASE}/tables`);
    expect(body.tables).toHaveLength(1);
    expect(body.tables[0].id).toBe(TABLE);
    expect(body.tables[0].primaryFieldId).toBe("fldName0000000001");
    expect(body.tables[0].fields).toHaveLength(4);
    expect(body.tables[0].views).toEqual([{ id: "viwActive00000001", name: "Active", type: "grid" }]);
  });

  it("unknown base returns a bare-string 404", async () => {
    const { status, body } = await req<{ error: string }>("GET", "/v0/meta/bases/appNope/tables");
    expect(status).toBe(404);
    expect(body).toEqual({ error: "NOT_FOUND" });
  });
});

describe("Airtable list records", () => {
  it("lists all records", async () => {
    const { body } = await req<ListResp>("GET", `/v0/${BASE}/${TABLE}`);
    expect(body.records).toHaveLength(3);
  });

  it("addresses a table by name", async () => {
    const { body } = await req<ListResp>("GET", `/v0/${BASE}/Tasks`);
    expect(body.records).toHaveLength(3);
  });

  it("filters with filterByFormula", async () => {
    const { body } = await req<ListResp>("GET", `/v0/${BASE}/${TABLE}?filterByFormula=${enc('{Status}="Doing"')}`);
    expect(names(body)).toEqual(["Beta"]);
  });

  it("sorts ascending and descending", async () => {
    const asc = await req<ListResp>("GET", `/v0/${BASE}/${TABLE}?sort[0][field]=Priority&sort[0][direction]=asc`);
    expect(names(asc.body)).toEqual(["Beta", "Alpha", "Gamma"]);
    const desc = await req<ListResp>("GET", `/v0/${BASE}/${TABLE}?sort[0][field]=Priority&sort[0][direction]=desc`);
    expect(names(desc.body)).toEqual(["Gamma", "Alpha", "Beta"]);
  });

  it("restricts to a view's seeded filter", async () => {
    const { body } = await req<ListResp>("GET", `/v0/${BASE}/${TABLE}?view=Active`);
    expect(names(body).sort()).toEqual(["Alpha", "Beta"]);
  });

  it("selects fields and returns by field id", async () => {
    const named = await req<ListResp>("GET", `/v0/${BASE}/${TABLE}?fields[]=Name`);
    expect(Object.keys(named.body.records[0].fields)).toEqual(["Name"]);
    const byId = await req<ListResp>("GET", `/v0/${BASE}/${TABLE}?fields[]=Name&returnFieldsByFieldId=true`);
    expect(Object.keys(byId.body.records[0].fields)).toEqual(["fldName0000000001"]);
  });

  it("paginates with pageSize and offset", async () => {
    const page1 = await req<ListResp>("GET", `/v0/${BASE}/${TABLE}?pageSize=2`);
    expect(page1.body.records).toHaveLength(2);
    expect(page1.body.offset).toBeTruthy();
    const page2 = await req<ListResp>("GET", `/v0/${BASE}/${TABLE}?pageSize=2&offset=${enc(page1.body.offset ?? "")}`);
    expect(page2.body.records).toHaveLength(1);
    expect(page2.body.offset).toBeUndefined();
  });

  it("caps results with maxRecords", async () => {
    const { body } = await req<ListResp>("GET", `/v0/${BASE}/${TABLE}?maxRecords=1`);
    expect(body.records).toHaveLength(1);
  });

  it("supports body-based POST /listRecords", async () => {
    const { body } = await req<ListResp>("POST", `/v0/${BASE}/${TABLE}/listRecords`, {
      filterByFormula: '{Status}="Todo"',
      fields: ["Name"],
    });
    expect(names(body)).toEqual(["Alpha"]);
  });
});

describe("Airtable get record", () => {
  it("gets one record", async () => {
    const { body } = await req<ATRecord>("GET", `/v0/${BASE}/${TABLE}/recAlpha000000001`);
    expect(body.id).toBe("recAlpha000000001");
    expect(body.fields.Name).toBe("Alpha");
  });

  it("unknown record returns a bare-string 404", async () => {
    const { status, body } = await req<{ error: string }>("GET", `/v0/${BASE}/${TABLE}/recNope`);
    expect(status).toBe(404);
    expect(body).toEqual({ error: "NOT_FOUND" });
  });
});

describe("Airtable create records", () => {
  it("creates a single record", async () => {
    const { status, body } = await req<ATRecord>("POST", `/v0/${BASE}/${TABLE}`, {
      fields: { Name: "Delta", Status: "Todo" },
    });
    expect(status).toBe(200);
    expect(body.id).toMatch(/^rec/);
    expect(body.fields).toEqual({ Name: "Delta", Status: "Todo" });
  });

  it("creates a batch of records", async () => {
    const { body } = await req<ListResp>("POST", `/v0/${BASE}/${TABLE}`, {
      records: [{ fields: { Name: "E" } }, { fields: { Name: "F" } }],
    });
    expect(body.records).toHaveLength(2);
  });

  it("rejects a batch larger than 10", async () => {
    const records = Array.from({ length: 11 }, (_, i) => ({ fields: { Name: `x${i}` } }));
    const { status, body } = await req<ObjError>("POST", `/v0/${BASE}/${TABLE}`, { records });
    expect(status).toBe(422);
    expect(body.error.type).toBe("INVALID_REQUEST_BODY");
  });

  it("rejects an unknown field", async () => {
    const { status, body } = await req<ObjError>("POST", `/v0/${BASE}/${TABLE}`, { fields: { Nope: 1 } });
    expect(status).toBe(422);
    expect(body.error.type).toBe("UNKNOWN_FIELD_NAME");
  });

  it("rejects a missing fields object", async () => {
    const { status, body } = await req<ObjError>("POST", `/v0/${BASE}/${TABLE}`, {});
    expect(status).toBe(422);
    expect(body.error.type).toBe("INVALID_REQUEST_MISSING_FIELDS");
  });

  it("rejects an invalid select choice without typecast", async () => {
    const { status, body } = await req<ObjError>("POST", `/v0/${BASE}/${TABLE}`, {
      fields: { Name: "G", Status: "Blocked" },
    });
    expect(status).toBe(422);
    expect(body.error.type).toBe("INVALID_MULTIPLE_CHOICE_OPTIONS");
  });

  it("accepts a new select choice with typecast", async () => {
    const { status, body } = await req<ATRecord>("POST", `/v0/${BASE}/${TABLE}`, {
      fields: { Name: "G", Status: "Blocked" },
      typecast: true,
    });
    expect(status).toBe(200);
    expect(body.fields.Status).toBe("Blocked");
  });
});

describe("Airtable update records", () => {
  it("PATCH merges only the given fields", async () => {
    const { body } = await req<ATRecord>("PATCH", `/v0/${BASE}/${TABLE}/recAlpha000000001`, {
      fields: { Status: "Done" },
    });
    expect(body.fields.Name).toBe("Alpha");
    expect(body.fields.Status).toBe("Done");
  });

  it("PUT replaces the record, clearing unspecified fields", async () => {
    const { body } = await req<ATRecord>("PUT", `/v0/${BASE}/${TABLE}/recAlpha000000001`, {
      fields: { Name: "Alpha2" },
    });
    expect(body.fields.Name).toBe("Alpha2");
    expect(body.fields.Status).toBeUndefined();
  });

  it("batch updates by id", async () => {
    const { body } = await req<ListResp>("PATCH", `/v0/${BASE}/${TABLE}`, {
      records: [
        { id: "recAlpha000000001", fields: { Priority: 9 } },
        { id: "recBeta0000000001", fields: { Priority: 8 } },
      ],
    });
    expect(body.records).toHaveLength(2);
    expect(body.records[0].fields.Priority).toBe(9);
  });

  it("upserts on fieldsToMergeOn (update existing, create new)", async () => {
    const { body } = await req<ListResp & { createdRecords: string[]; updatedRecords: string[] }>(
      "PATCH",
      `/v0/${BASE}/${TABLE}`,
      {
        performUpsert: { fieldsToMergeOn: ["Name"] },
        records: [{ fields: { Name: "Alpha", Priority: 5 } }, { fields: { Name: "Zeta", Priority: 7 } }],
      },
    );
    expect(body.updatedRecords).toEqual(["recAlpha000000001"]);
    expect(body.createdRecords).toHaveLength(1);
    expect(body.records).toHaveLength(2);
  });
});

describe("Airtable delete records", () => {
  it("deletes a single record", async () => {
    const { body } = await req<{ deleted: boolean; id: string }>("DELETE", `/v0/${BASE}/${TABLE}/recBeta0000000001`);
    expect(body).toEqual({ deleted: true, id: "recBeta0000000001" });
    const after = await req<ListResp>("GET", `/v0/${BASE}/${TABLE}`);
    expect(after.body.records).toHaveLength(2);
  });

  it("batch deletes", async () => {
    const { body } = await req<{ records: Array<{ deleted: boolean; id: string }> }>(
      "DELETE",
      `/v0/${BASE}/${TABLE}?records[]=recAlpha000000001&records[]=recGamma000000001`,
    );
    expect(body.records).toEqual([
      { deleted: true, id: "recAlpha000000001" },
      { deleted: true, id: "recGamma000000001" },
    ]);
  });
});

describe("Airtable error envelopes", () => {
  it("unknown table returns 403 model-not-found", async () => {
    const { status, body } = await req<ObjError>("GET", `/v0/${BASE}/tblNope`);
    expect(status).toBe(403);
    expect(body.error.type).toBe("INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND");
  });

  it("invalid formula returns 422", async () => {
    const { status, body } = await req<ObjError>("GET", `/v0/${BASE}/${TABLE}?filterByFormula=NOTAFN(`);
    expect(status).toBe(422);
    expect(body.error.type).toBe("INVALID_FILTER_BY_FORMULA");
  });

  it("a {fldXXX} id token in a formula is rejected", async () => {
    const { status, body } = await req<ObjError>(
      "GET",
      `/v0/${BASE}/${TABLE}?filterByFormula=${enc('{fldName0000000001}="Alpha"')}`,
    );
    expect(status).toBe(422);
    expect(body.error.type).toBe("INVALID_FILTER_BY_FORMULA");
  });

  it("pageSize out of range returns 422", async () => {
    const { status, body } = await req<ObjError>("GET", `/v0/${BASE}/${TABLE}?pageSize=200`);
    expect(status).toBe(422);
    expect(body.error.type).toBe("INVALID_PAGE_SIZE_ARGUMENT");
  });
});

describe("Airtable record comments", () => {
  const REC = "recAlpha000000001";

  it("posts a comment with author identity and mention parsing", async () => {
    const { status, body } = await req<Comment>("POST", `/v0/${BASE}/${TABLE}/${REC}/comments`, {
      text: "Nudge @[usrTest0000000001]",
    });
    expect(status).toBe(200);
    expect(body.author.email).toBe("dev@example.com");
    expect(body.mentioned).toHaveProperty("usrTest0000000001");
  });

  it("lists comments in thread order and deletes", async () => {
    await req("POST", `/v0/${BASE}/${TABLE}/${REC}/comments`, { text: "first" });
    await req("POST", `/v0/${BASE}/${TABLE}/${REC}/comments`, { text: "second" });
    const list = await req<{ comments: Comment[] }>("GET", `/v0/${BASE}/${TABLE}/${REC}/comments`);
    expect(list.body.comments.map((c) => c.text)).toEqual(["first", "second"]);
    const del = await req<{ deleted: boolean }>(
      "DELETE",
      `/v0/${BASE}/${TABLE}/${REC}/comments/${list.body.comments[0].id}`,
    );
    expect(del.body.deleted).toBe(true);
  });

  it("rejects an empty comment", async () => {
    const { status, body } = await req<ObjError>("POST", `/v0/${BASE}/${TABLE}/${REC}/comments`, {});
    expect(status).toBe(422);
    expect(body.error.type).toBe("INVALID_REQUEST_MISSING_FIELDS");
  });
});
