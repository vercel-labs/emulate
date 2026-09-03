import { describe, it, expect } from "vitest";
import {
  parseFormula,
  evaluateFormula,
  matchesFormula,
  collectFieldRefs,
  FormulaError,
  type FormulaContext,
} from "../formula.js";

function ctx(cells: Record<string, unknown>, opts: Partial<FormulaContext> = {}): FormulaContext {
  return {
    field: (name) => cells[name],
    recordId: opts.recordId ?? "recTEST0000000001",
    createdTime: opts.createdTime ?? "2026-01-01T00:00:00.000Z",
    now: opts.now ?? new Date("2026-07-20T12:00:00.000Z"),
  };
}

function match(formula: string, cells: Record<string, unknown> = {}, opts: Partial<FormulaContext> = {}): boolean {
  return matchesFormula(parseFormula(formula), ctx(cells, opts));
}

function evalF(formula: string, cells: Record<string, unknown> = {}, opts: Partial<FormulaContext> = {}): unknown {
  return evaluateFormula(parseFormula(formula), ctx(cells, opts));
}

describe("formula: comparisons and field refs", () => {
  it("string equality on a field value", () => {
    expect(match('{Status}="Active"', { Status: "Active" })).toBe(true);
    expect(match('{Status}="Active"', { Status: "Alum" })).toBe(false);
  });

  it("bare (unbraced) field references", () => {
    expect(match('Status="Active"', { Status: "Active" })).toBe(true);
  });

  it("numeric comparisons coerce numeric strings", () => {
    expect(match("{n} > 3", { n: 5 })).toBe(true);
    expect(match("{n} > 3", { n: "5" })).toBe(true);
    expect(match("{n} <= 3", { n: 3 })).toBe(true);
    expect(match("{n} != 3", { n: 4 })).toBe(true);
  });

  it("reads a formula/computed field's stored value", () => {
    // {Program} is a computed field in Airtable; filterByFormula filters on its value.
    expect(match('{Program}="Member Residency"', { Program: "Member Residency" })).toBe(true);
  });
});

describe("formula: logic", () => {
  it("AND / OR / NOT", () => {
    expect(match('AND({Status}="Active",{Location}="SF")', { Status: "Active", Location: "SF" })).toBe(true);
    expect(match('AND({Status}="Active",{Location}="SF")', { Status: "Active", Location: "NYC" })).toBe(false);
    expect(match('OR({Status}="Active",{Status}="Alum")', { Status: "Alum" })).toBe(true);
    expect(match('NOT({Status}="Active")', { Status: "Alum" })).toBe(true);
  });

  it("IF returns branches", () => {
    expect(evalF('IF({n}>3,"big","small")', { n: 5 })).toBe("big");
    expect(evalF('IF({n}>3,"big","small")', { n: 1 })).toBe("small");
  });
});

describe("formula: text and search (the search-records pattern)", () => {
  it("FIND(LOWER(needle), LOWER(field)) > 0", () => {
    const f = 'FIND(LOWER("finn"), LOWER({Name})) > 0';
    expect(match(f, { Name: "Finnegan Marsh" })).toBe(true);
    expect(match(f, { Name: "Someone Else" })).toBe(false);
  });

  it("FIND returns 0 when the needle is absent", () => {
    expect(evalF('FIND("x", {Name})', { Name: "abc" })).toBe(0);
    expect(evalF('FIND("b", {Name})', { Name: "abc" })).toBe(2);
  });

  it("string helpers", () => {
    expect(evalF('UPPER("hi")')).toBe("HI");
    expect(evalF('TRIM("  hi  ")')).toBe("hi");
    expect(evalF('LEN("abc")')).toBe(3);
    expect(evalF('CONCATENATE("a","b","c")')).toBe("abc");
    expect(evalF('{a} & "-" & {b}', { a: "x", b: "y" })).toBe("x-y");
  });

  it("FIND over a linked/array field sees its joined display value", () => {
    expect(match('FIND("UI", {Tags}) > 0', { Tags: ["Bug", "UI"] })).toBe(true);
  });
});

describe("formula: blank and record id", () => {
  it("BLANK() equality detects empty cells", () => {
    expect(match("{Email}=BLANK()", { Email: "" })).toBe(true);
    expect(match("{Email}=BLANK()", {})).toBe(true);
    expect(match("NOT({Email}=BLANK())", { Email: "a@b.com" })).toBe(true);
  });

  it("RECORD_ID() and the OR(RECORD_ID()=...) get-many pattern", () => {
    const f = "OR(RECORD_ID()='recA',RECORD_ID()='recB')";
    expect(match(f, {}, { recordId: "recA" })).toBe(true);
    expect(match(f, {}, { recordId: "recZ" })).toBe(false);
  });
});

describe("formula: dates (the recent-activity pattern)", () => {
  const now = new Date("2026-07-20T12:00:00.000Z");

  it("TODAY / DATEADD / IS_AFTER window", () => {
    const f = "IS_AFTER({Modified}, DATEADD(TODAY(), -7, 'days'))";
    expect(match(f, { Modified: "2026-07-18T00:00:00.000Z" }, { now })).toBe(true);
    expect(match(f, { Modified: "2026-07-01T00:00:00.000Z" }, { now })).toBe(false);
  });

  it("IS_SAME with a day unit", () => {
    const f = "IS_SAME({d}, '2026-07-20T09:00:00.000Z', 'day')";
    expect(match(f, { d: "2026-07-20T23:00:00.000Z" })).toBe(true);
    expect(match(f, { d: "2026-07-21T00:00:00.000Z" })).toBe(false);
  });

  it("DATETIME_DIFF in days", () => {
    expect(evalF("DATETIME_DIFF('2026-07-20', '2026-07-13', 'days')")).toBe(7);
  });
});

describe("formula: arithmetic precedence and truthiness", () => {
  it("multiplication before addition", () => {
    expect(evalF("1 + 2 * 3")).toBe(7);
    expect(evalF("(1 + 2) * 3")).toBe(9);
  });

  it("checkbox / numeric truthiness", () => {
    expect(match("{Done}", { Done: true })).toBe(true);
    expect(match("{Done}", { Done: false })).toBe(false);
    expect(match("{n}", { n: 0 })).toBe(false);
    expect(match("{n}", { n: 2 })).toBe(true);
  });
});

describe("formula: introspection and errors", () => {
  it("collectFieldRefs finds every referenced field", () => {
    const refs = collectFieldRefs(parseFormula('AND({Status}="Active", FIND("x", {Name}) > 0)'));
    expect(new Set(refs)).toEqual(new Set(["Status", "Name"]));
  });

  it("throws FormulaError on unbalanced parens", () => {
    expect(() => parseFormula("AND({a}")).toThrow(FormulaError);
  });

  it("throws FormulaError on an unsupported function", () => {
    expect(() => evaluateFormula(parseFormula("REGEX_MATCH({a},'x')"), ctx({ a: "x" }))).toThrow(FormulaError);
  });
});
