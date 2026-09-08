/**
 * A pragmatic `filterByFormula` engine: recursive-descent parser + evaluator over a
 * single record's cells. It covers the subset SPC's agents actually use (comparisons,
 * AND/OR/NOT/IF, LOWER/FIND/SEARCH, RECORD_ID/BLANK, IS_AFTER/IS_SAME, DATEADD, TODAY,
 * field refs) with Airtable's loose coercion and truthiness. Unsupported tokens throw
 * `FormulaError`, which the records route maps to `422 INVALID_FILTER_BY_FORMULA`.
 *
 * Field refs resolve by NAME (Airtable's rule); a `{fldXXX}` id token won't match a
 * field name and surfaces via `collectFieldRefs` so the route can reject it. Linked and
 * computed fields are read as their stored cell value.
 */

export class FormulaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormulaError";
  }
}

export interface FormulaContext {
  field(name: string): unknown;
  recordId: string;
  createdTime: string;
  now: Date;
}

type NodeType = "num" | "str" | "field" | "call" | "binary" | "unary";

interface FormulaNode {
  type: NodeType;
  value?: number | string;
  name?: string;
  op?: string;
  args?: FormulaNode[];
  operand?: FormulaNode;
  left?: FormulaNode;
  right?: FormulaNode;
}

type TokenType = "num" | "str" | "field" | "ident" | "op" | "lparen" | "rparen" | "comma" | "eof";

interface Token {
  type: TokenType;
  value: string;
}

const MULTI_CHAR_OPS = ["!=", "<>", "<=", ">="];
const SINGLE_CHAR_OPS: Record<string, true> = {
  "=": true,
  "<": true,
  ">": true,
  "&": true,
  "+": true,
  "-": true,
  "*": true,
  "/": true,
};

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const ch = src[i];

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      let str = "";
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\" && i + 1 < n) {
          str += src[i + 1];
          i += 2;
        } else {
          str += src[i];
          i++;
        }
      }
      if (i >= n) throw new FormulaError("Unterminated string literal");
      i++;
      tokens.push({ type: "str", value: str });
      continue;
    }

    if (ch === "{") {
      let name = "";
      i++;
      while (i < n && src[i] !== "}") {
        if (src[i] === "\\" && i + 1 < n) {
          name += src[i + 1];
          i += 2;
        } else {
          name += src[i];
          i++;
        }
      }
      if (i >= n) throw new FormulaError("Unterminated field reference");
      i++;
      tokens.push({ type: "field", value: name });
      continue;
    }

    if (ch >= "0" && ch <= "9") {
      let num = "";
      while (i < n && ((src[i] >= "0" && src[i] <= "9") || src[i] === ".")) {
        num += src[i];
        i++;
      }
      tokens.push({ type: "num", value: num });
      continue;
    }

    const two = src.slice(i, i + 2);
    if (MULTI_CHAR_OPS.includes(two)) {
      tokens.push({ type: "op", value: two === "<>" ? "!=" : two });
      i += 2;
      continue;
    }

    if (SINGLE_CHAR_OPS[ch]) {
      tokens.push({ type: "op", value: ch });
      i++;
      continue;
    }

    if (ch === "(") {
      tokens.push({ type: "lparen", value: ch });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen", value: ch });
      i++;
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: "comma", value: ch });
      i++;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let ident = "";
      while (i < n && /[A-Za-z0-9_]/.test(src[i])) {
        ident += src[i];
        i++;
      }
      tokens.push({ type: "ident", value: ident });
      continue;
    }

    throw new FormulaError(`Unexpected character '${ch}' in formula`);
  }

  tokens.push({ type: "eof", value: "" });
  return tokens;
}

// Recursive-descent parser. Precedence low→high: comparison, concat(&), +-, */, unary.
class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expect(type: TokenType): Token {
    const tok = this.next();
    if (tok.type !== type) throw new FormulaError(`Expected ${type} but found '${tok.value || tok.type}'`);
    return tok;
  }

  parse(): FormulaNode {
    const node = this.parseComparison();
    if (this.peek().type !== "eof") throw new FormulaError(`Unexpected token '${this.peek().value}'`);
    return node;
  }

  private parseBinaryLevel(ops: Record<string, true>, next: () => FormulaNode): FormulaNode {
    let left = next();
    while (this.peek().type === "op" && ops[this.peek().value]) {
      const op = this.next().value;
      const right = next();
      left = { type: "binary", op, left, right };
    }
    return left;
  }

  private parseComparison(): FormulaNode {
    return this.parseBinaryLevel({ "=": true, "!=": true, "<": true, ">": true, "<=": true, ">=": true }, () =>
      this.parseConcat(),
    );
  }

  private parseConcat(): FormulaNode {
    return this.parseBinaryLevel({ "&": true }, () => this.parseAdditive());
  }

  private parseAdditive(): FormulaNode {
    return this.parseBinaryLevel({ "+": true, "-": true }, () => this.parseMultiplicative());
  }

  private parseMultiplicative(): FormulaNode {
    return this.parseBinaryLevel({ "*": true, "/": true }, () => this.parseUnary());
  }

  private parseUnary(): FormulaNode {
    if (this.peek().type === "op" && this.peek().value === "-") {
      this.next();
      return { type: "unary", op: "-", operand: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): FormulaNode {
    const tok = this.peek();

    if (tok.type === "num") {
      this.next();
      return { type: "num", value: Number(tok.value) };
    }
    if (tok.type === "str") {
      this.next();
      return { type: "str", value: tok.value };
    }
    if (tok.type === "field") {
      this.next();
      return { type: "field", name: tok.value };
    }
    if (tok.type === "lparen") {
      this.next();
      const node = this.parseComparison();
      this.expect("rparen");
      return node;
    }
    if (tok.type === "ident") {
      this.next();
      if (this.peek().type === "lparen") {
        this.next();
        const args: FormulaNode[] = [];
        if (this.peek().type !== "rparen") {
          args.push(this.parseComparison());
          while (this.peek().type === "comma") {
            this.next();
            args.push(this.parseComparison());
          }
        }
        this.expect("rparen");
        return { type: "call", name: tok.value.toUpperCase(), args };
      }
      // Bare identifier is a field reference (Airtable allows unbraced names).
      return { type: "field", name: tok.value };
    }

    throw new FormulaError(`Unexpected token '${tok.value || tok.type}'`);
  }
}

export function parseFormula(src: string): FormulaNode {
  return new Parser(tokenize(src)).parse();
}

export function collectFieldRefs(node: FormulaNode, out: string[] = []): string[] {
  if (node.type === "field" && node.name) out.push(node.name);
  if (node.operand) collectFieldRefs(node.operand, out);
  if (node.left) collectFieldRefs(node.left, out);
  if (node.right) collectFieldRefs(node.right, out);
  for (const arg of node.args ?? []) collectFieldRefs(arg, out);
  return out;
}

// ---- coercion (Airtable is loosely typed) ----

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
}

function toStr(v: unknown): string {
  if (isBlank(v)) return "";
  if (Array.isArray(v)) return v.map(toStr).join(",");
  if (typeof v === "boolean") return v ? "1" : "";
  return String(v);
}

function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (isBlank(v)) return 0;
  const n = Number(toStr(v));
  return Number.isNaN(n) ? 0 : n;
}

function truthy(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (isBlank(v)) return false;
  if (Array.isArray(v)) return v.length > 0;
  return toStr(v) !== "";
}

function looksNumeric(v: unknown): boolean {
  if (typeof v === "number") return true;
  if (typeof v === "string" && v.trim() !== "") return !Number.isNaN(Number(v));
  return false;
}

function toMs(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  const parsed = Date.parse(toStr(v));
  if (Number.isNaN(parsed)) throw new FormulaError("Invalid date argument");
  return parsed;
}

const UNIT_MS: Record<string, number> = {
  milliseconds: 1,
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 604_800_000,
};

function normalizeUnit(unit: string): string {
  const u = unit.toLowerCase().replace(/s$/, "");
  const map: Record<string, string> = {
    millisecond: "milliseconds",
    second: "seconds",
    minute: "minutes",
    hour: "hours",
    day: "days",
    week: "weeks",
    month: "months",
    year: "years",
  };
  return map[u] ?? unit.toLowerCase();
}

function dateAdd(baseMs: number, count: number, unit: string): number {
  const u = normalizeUnit(unit);
  if (u === "months" || u === "years") {
    const d = new Date(baseMs);
    if (u === "months") d.setUTCMonth(d.getUTCMonth() + count);
    else d.setUTCFullYear(d.getUTCFullYear() + count);
    return d.getTime();
  }
  return baseMs + count * (UNIT_MS[u] ?? 0);
}

function compare(a: unknown, b: unknown, op: string): boolean {
  let cmp: number;
  if (looksNumeric(a) && looksNumeric(b)) {
    cmp = toNum(a) - toNum(b);
  } else {
    const sa = toStr(a);
    const sb = toStr(b);
    cmp = sa < sb ? -1 : sa > sb ? 1 : 0;
  }
  switch (op) {
    case "=":
      return cmp === 0;
    case "!=":
      return cmp !== 0;
    case "<":
      return cmp < 0;
    case ">":
      return cmp > 0;
    case "<=":
      return cmp <= 0;
    case ">=":
      return cmp >= 0;
    default:
      throw new FormulaError(`Unknown comparison operator '${op}'`);
  }
}

// Eager functions: args already evaluated. Logic/date functions needing special
// handling (short-circuit, ctx) are dispatched in evalCall.
const EAGER_FUNCTIONS: Record<string, (args: unknown[]) => unknown> = {
  LOWER: (a) => toStr(a[0]).toLowerCase(),
  UPPER: (a) => toStr(a[0]).toUpperCase(),
  TRIM: (a) => toStr(a[0]).trim(),
  LEN: (a) => toStr(a[0]).length,
  LEFT: (a) => toStr(a[0]).slice(0, toNum(a[1])),
  RIGHT: (a) => toStr(a[0]).slice(-toNum(a[1]) || toStr(a[0]).length),
  MID: (a) => toStr(a[0]).slice(Math.max(0, toNum(a[1]) - 1), Math.max(0, toNum(a[1]) - 1) + toNum(a[2])),
  CONCATENATE: (a) => a.map(toStr).join(""),
  SUBSTITUTE: (a) => toStr(a[0]).split(toStr(a[1])).join(toStr(a[2])),
  VALUE: (a) => toNum(a[0]),
  ABS: (a) => Math.abs(toNum(a[0])),
  ROUND: (a) => {
    const factor = 10 ** toNum(a[1] ?? 0);
    return Math.round(toNum(a[0]) * factor) / factor;
  },
  MIN: (a) => Math.min(...a.map(toNum)),
  MAX: (a) => Math.max(...a.map(toNum)),
  SUM: (a) => a.reduce<number>((acc, v) => acc + toNum(v), 0),
};

function find(args: unknown[]): number {
  const needle = toStr(args[0]);
  const hay = toStr(args[1]);
  const start = args[2] != null ? Math.max(0, toNum(args[2]) - 1) : 0;
  const idx = hay.indexOf(needle, start);
  return idx < 0 ? 0 : idx + 1;
}

function evalCall(node: FormulaNode, ctx: FormulaContext): unknown {
  const name = node.name ?? "";
  const args = node.args ?? [];

  switch (name) {
    case "AND":
      return args.every((a) => truthy(evalNode(a, ctx)));
    case "OR":
      return args.some((a) => truthy(evalNode(a, ctx)));
    case "NOT":
      return !truthy(evalNode(args[0], ctx));
    case "IF": {
      const cond = truthy(evalNode(args[0], ctx));
      return cond ? evalNode(args[1], ctx) : args.length > 2 ? evalNode(args[2], ctx) : "";
    }
    case "TRUE":
      return 1;
    case "FALSE":
      return 0;
    case "BLANK":
      return "";
    case "RECORD_ID":
      return ctx.recordId;
    case "CREATED_TIME":
      return ctx.createdTime;
    case "TODAY": {
      const d = ctx.now;
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
    }
    case "NOW":
      return ctx.now.toISOString();
    case "FIND":
      return find(args.map((a) => evalNode(a, ctx)));
    case "SEARCH": {
      const idx = find(args.map((a) => evalNode(a, ctx)));
      return idx === 0 ? "" : idx;
    }
    case "DATEADD": {
      const ms = dateAdd(toMs(evalNode(args[0], ctx)), toNum(evalNode(args[1], ctx)), toStr(evalNode(args[2], ctx)));
      return new Date(ms).toISOString();
    }
    case "DATETIME_DIFF": {
      const a = toMs(evalNode(args[0], ctx));
      const b = toMs(evalNode(args[1], ctx));
      const unit = normalizeUnit(toStr(evalNode(args[2] ?? { type: "str", value: "days" }, ctx)));
      return Math.trunc((a - b) / (UNIT_MS[unit] ?? UNIT_MS.days));
    }
    case "IS_AFTER":
      return toMs(evalNode(args[0], ctx)) > toMs(evalNode(args[1], ctx));
    case "IS_BEFORE":
      return toMs(evalNode(args[0], ctx)) < toMs(evalNode(args[1], ctx));
    case "IS_SAME": {
      const a = toMs(evalNode(args[0], ctx));
      const b = toMs(evalNode(args[1], ctx));
      if (args[2] != null) {
        const unit = normalizeUnit(toStr(evalNode(args[2], ctx)));
        return Math.floor(a / (UNIT_MS[unit] ?? 1)) === Math.floor(b / (UNIT_MS[unit] ?? 1));
      }
      return a === b;
    }
  }

  const eager = EAGER_FUNCTIONS[name];
  if (eager) return eager(args.map((a) => evalNode(a, ctx)));

  throw new FormulaError(`Unsupported function '${name}()'`);
}

function evalBinary(node: FormulaNode, ctx: FormulaContext): unknown {
  const op = node.op ?? "";
  const left = evalNode(node.left as FormulaNode, ctx);
  const right = evalNode(node.right as FormulaNode, ctx);
  switch (op) {
    case "&":
      return toStr(left) + toStr(right);
    case "+":
      return toNum(left) + toNum(right);
    case "-":
      return toNum(left) - toNum(right);
    case "*":
      return toNum(left) * toNum(right);
    case "/":
      return toNum(right) === 0 ? 0 : toNum(left) / toNum(right);
    default:
      return compare(left, right, op);
  }
}

function evalNode(node: FormulaNode, ctx: FormulaContext): unknown {
  switch (node.type) {
    case "num":
      return node.value;
    case "str":
      return node.value;
    case "field":
      return ctx.field(node.name ?? "");
    case "unary":
      return -toNum(evalNode(node.operand as FormulaNode, ctx));
    case "binary":
      return evalBinary(node, ctx);
    case "call":
      return evalCall(node, ctx);
    default:
      throw new FormulaError("Malformed formula node");
  }
}

export function evaluateFormula(node: FormulaNode, ctx: FormulaContext): unknown {
  return evalNode(node, ctx);
}

export function matchesFormula(node: FormulaNode, ctx: FormulaContext): boolean {
  return truthy(evalNode(node, ctx));
}
