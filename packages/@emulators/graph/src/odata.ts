export type Row = Record<string, unknown>;

type Token =
  | { kind: "ident"; value: string }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "punct"; value: string };

export class ODataError extends Error {}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "'") {
      let value = "";
      i++;
      while (i < input.length) {
        if (input[i] === "'" && input[i + 1] === "'") {
          value += "'";
          i += 2;
          continue;
        }
        if (input[i] === "'") break;
        value += input[i++];
      }
      if (input[i] !== "'") throw new ODataError("Unterminated string literal in $filter");
      i++;
      tokens.push({ kind: "string", value });
      continue;
    }
    if ("(),:".includes(ch)) {
      tokens.push({ kind: "punct", value: ch });
      i++;
      continue;
    }
    const rest = input.slice(i);
    const dateMatch = rest.match(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?/);
    if (dateMatch) {
      tokens.push({ kind: "ident", value: dateMatch[0] });
      i += dateMatch[0].length;
      continue;
    }
    const numberMatch = rest.match(/^-?\d+(?:\.\d+)?/);
    if (numberMatch) {
      tokens.push({ kind: "number", value: Number(numberMatch[0]) });
      i += numberMatch[0].length;
      continue;
    }
    const identMatch = rest.match(/^[A-Za-z_@$][A-Za-z0-9_./:@$-]*/);
    if (identMatch) {
      tokens.push({ kind: "ident", value: identMatch[0] });
      i += identMatch[0].length;
      continue;
    }
    throw new ODataError(`Unexpected character '${ch}' in $filter`);
  }
  return tokens;
}

type Predicate = (row: Row) => boolean;
type Value = (row: Row) => unknown;

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  parse(): Predicate {
    const result = this.parseOr();
    if (this.pos < this.tokens.length)
      throw new ODataError(`Unexpected token '${String(this.tokens[this.pos].value)}' in $filter`);
    return result;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos++];
    if (!token) throw new ODataError("Unexpected end of $filter");
    return token;
  }

  private isIdent(value: string): boolean {
    const token = this.peek();
    return token?.kind === "ident" && token.value.toLowerCase() === value;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== "punct" || token.value !== value) throw new ODataError(`Expected '${value}' in $filter`);
  }

  private parseOr(): Predicate {
    let left = this.parseAnd();
    while (this.isIdent("or")) {
      this.next();
      const right = this.parseAnd();
      const previous = left;
      left = (row) => previous(row) || right(row);
    }
    return left;
  }

  private parseAnd(): Predicate {
    let left = this.parseNot();
    while (this.isIdent("and")) {
      this.next();
      const right = this.parseNot();
      const previous = left;
      left = (row) => previous(row) && right(row);
    }
    return left;
  }

  private parseNot(): Predicate {
    if (this.isIdent("not")) {
      this.next();
      const inner = this.parseNot();
      return (row) => !inner(row);
    }
    return this.parseComparison();
  }

  private parseComparison(): Predicate {
    const token = this.peek();
    if (token?.kind === "punct" && token.value === "(") {
      this.next();
      const inner = this.parseOr();
      this.expectPunct(")");
      return inner;
    }
    const left = this.parseValue();
    const opToken = this.peek();
    if (opToken?.kind === "ident") {
      const op = opToken.value.toLowerCase();
      if (["eq", "ne", "gt", "ge", "lt", "le"].includes(op)) {
        this.next();
        const right = this.parseValue();
        return (row) => compare(op, left(row), right(row));
      }
      if (op === "in") {
        this.next();
        this.expectPunct("(");
        const values: Value[] = [];
        if (!(this.peek()?.kind === "punct" && this.peek()?.value === ")")) {
          values.push(this.parseValue());
          while (this.peek()?.kind === "punct" && this.peek()?.value === ",") {
            this.next();
            values.push(this.parseValue());
          }
        }
        this.expectPunct(")");
        return (row) => values.some((value) => compare("eq", left(row), value(row)));
      }
    }
    return (row) => Boolean(left(row));
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === "string") return () => token.value;
    if (token.kind === "number") return () => token.value;
    if (token.kind === "punct") throw new ODataError(`Unexpected '${token.value}' in $filter`);
    const lowered = token.value.toLowerCase();
    if (lowered === "true") return () => true;
    if (lowered === "false") return () => false;
    if (lowered === "null") return () => null;
    if (/^\d{4}-\d{2}-\d{2}/.test(token.value)) {
      const parsed = Date.parse(token.value.includes("T") ? token.value : `${token.value}T00:00:00Z`);
      return () => new Date(parsed).toISOString();
    }
    const nextIsParen = this.peek()?.kind === "punct" && this.peek()?.value === "(";
    if (token.value.includes("/") && nextIsParen) return this.parseLambda(token.value);
    if (nextIsParen) return this.parseFunction(lowered);
    const field = token.value;
    return (row) => readField(row, field);
  }

  private parseLambda(expression: string): Value {
    const [field, operator] = expression.split("/");
    if (!["any", "all"].includes(operator.toLowerCase()))
      throw new ODataError(`Unsupported expression '${expression}' in $filter`);
    this.expectPunct("(");
    const variableToken = this.next();
    if (variableToken.kind !== "ident") throw new ODataError("Expected lambda variable in $filter");
    const variable = variableToken.value.replace(/:$/, "");
    if (!variableToken.value.endsWith(":")) this.expectPunct(":");
    const inner = this.parseOr();
    this.expectPunct(")");
    return (row) => {
      const list = readField(row, field);
      if (!Array.isArray(list)) return false;
      const test = (item: unknown) => inner({ ...row, [variable]: item });
      return operator.toLowerCase() === "any" ? list.some(test) : list.every(test);
    };
  }

  private parseFunction(name: string): Value {
    this.expectPunct("(");
    const args: Value[] = [];
    if (!(this.peek()?.kind === "punct" && this.peek()?.value === ")")) {
      args.push(this.parseValue());
      while (this.peek()?.kind === "punct" && this.peek()?.value === ",") {
        this.next();
        args.push(this.parseValue());
      }
    }
    this.expectPunct(")");
    const text = (row: Row, index: number) => String(args[index]?.(row) ?? "").toLowerCase();
    switch (name) {
      case "contains":
      case "substringof":
        return (row) =>
          name === "contains" ? text(row, 0).includes(text(row, 1)) : text(row, 1).includes(text(row, 0));
      case "startswith":
        return (row) => text(row, 0).startsWith(text(row, 1));
      case "endswith":
        return (row) => text(row, 0).endsWith(text(row, 1));
      case "tolower":
        return (row) => text(row, 0);
      case "toupper":
        return (row) => String(args[0]?.(row) ?? "").toUpperCase();
      case "length":
        return (row) => String(args[0]?.(row) ?? "").length;
      case "indexof":
        return (row) => text(row, 0).indexOf(text(row, 1));
      case "trim":
        return (row) => String(args[0]?.(row) ?? "").trim();
      case "concat":
        return (row) => args.map((arg) => String(arg(row) ?? "")).join("");
      case "year":
      case "month":
      case "day":
      case "hour":
      case "minute":
      case "second": {
        return (row) => {
          const date = new Date(String(args[0]?.(row) ?? ""));
          const parts: Record<string, number> = {
            year: date.getUTCFullYear(),
            month: date.getUTCMonth() + 1,
            day: date.getUTCDate(),
            hour: date.getUTCHours(),
            minute: date.getUTCMinutes(),
            second: date.getUTCSeconds(),
          };
          return parts[name];
        };
      }
      case "now":
        return () => new Date().toISOString();
      default:
        throw new ODataError(`Unsupported function '${name}' in $filter`);
    }
  }
}

export function readField(row: Row, path: string): unknown {
  const segments = path.split("/");
  let current: unknown = row;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    const record = current as Row;
    const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === segment.toLowerCase());
    current = key === undefined ? undefined : record[key];
  }
  return current;
}

function normalize(value: unknown): unknown {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return value;
}

function compare(op: string, rawLeft: unknown, rawRight: unknown): boolean {
  const left = normalize(rawLeft);
  const right = normalize(rawRight);
  if (left === null || left === undefined || right === null || right === undefined) {
    const bothNull = (left ?? null) === null && (right ?? null) === null;
    if (op === "eq") return bothNull;
    if (op === "ne") return !bothNull;
    return false;
  }
  if (typeof left === "string" && typeof right === "string") {
    const a = left.toLowerCase();
    const b = right.toLowerCase();
    switch (op) {
      case "eq":
        return a === b;
      case "ne":
        return a !== b;
      case "gt":
        return a > b;
      case "ge":
        return a >= b;
      case "lt":
        return a < b;
      case "le":
        return a <= b;
    }
  }
  const a = typeof left === "boolean" ? Number(left) : (left as number);
  const b = typeof right === "boolean" ? Number(right) : typeof right === "string" ? Number(right) : (right as number);
  switch (op) {
    case "eq":
      return a === b || String(left).toLowerCase() === String(right).toLowerCase();
    case "ne":
      return !(a === b || String(left).toLowerCase() === String(right).toLowerCase());
    case "gt":
      return a > b;
    case "ge":
      return a >= b;
    case "lt":
      return a < b;
    case "le":
      return a <= b;
  }
  return false;
}

export function parseFilter(filter: string): Predicate {
  const trimmed = filter.trim();
  if (!trimmed) return () => true;
  return new Parser(tokenize(trimmed)).parse();
}

export interface ODataOptions {
  filter?: string;
  top?: number;
  skip?: number;
  orderby?: string;
  select?: string;
  count?: boolean;
}

export function parseODataOptions(url: URL, defaultTop: number): ODataOptions {
  const read = (name: string) => url.searchParams.get(`$${name}`) ?? url.searchParams.get(name) ?? undefined;
  const top = read("top");
  const skip = read("skip");
  const count = read("count");
  return {
    filter: read("filter"),
    top: top !== undefined ? clampInt(top, 1, defaultTop) : defaultTop,
    skip: skip !== undefined ? clampInt(skip, 0, Number.MAX_SAFE_INTEGER) : 0,
    orderby: read("orderby"),
    select: read("select"),
    count: count !== undefined ? count.toLowerCase() === "true" : false,
  };
}

function clampInt(value: string, min: number, max: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new ODataError(`Invalid value '${value}' for a numeric query option`);
  return Math.min(Math.max(parsed, min), max);
}

export interface ODataPage<T> {
  rows: T[];
  total: number;
  hasMore: boolean;
}

export function applyOData<T extends Row>(rows: T[], options: ODataOptions): ODataPage<Partial<T>> {
  let result = rows;
  if (options.filter) {
    const predicate = parseFilter(options.filter);
    result = result.filter((row) => predicate(row));
  }
  if (options.orderby) {
    const clauses = options.orderby
      .split(",")
      .map((clause) => clause.trim())
      .filter(Boolean)
      .map((clause) => {
        const [field, direction] = clause.split(/\s+/);
        return { field, descending: (direction ?? "asc").toLowerCase() === "desc" };
      });
    result = [...result].sort((a, b) => {
      for (const clause of clauses) {
        const left = normalize(readField(a, clause.field));
        const right = normalize(readField(b, clause.field));
        if (left === right) continue;
        if (left === null || left === undefined) return clause.descending ? 1 : -1;
        if (right === null || right === undefined) return clause.descending ? -1 : 1;
        const order = left < right ? -1 : 1;
        return clause.descending ? -order : order;
      }
      return 0;
    });
  }
  const total = result.length;
  const skip = options.skip ?? 0;
  const top = options.top ?? total;
  const page = result.slice(skip, skip + top);
  const hasMore = skip + top < total;
  if (options.select) {
    const fields = options.select
      .split(",")
      .map((field) => field.trim())
      .filter(Boolean);
    return {
      rows: page.map((row) => {
        const picked: Row = {};
        for (const field of fields) {
          const key = Object.keys(row).find((candidate) => candidate.toLowerCase() === field.toLowerCase());
          if (key) picked[key] = row[key];
        }
        return picked as Partial<T>;
      }),
      total,
      hasMore,
    };
  }
  return { rows: page, total, hasMore };
}
