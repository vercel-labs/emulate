import type { JiraIssue, JiraStatusCategory, JiraUser } from "./entities.js";
import type { JiraStore } from "./store.js";
import { adfToText } from "./adf.js";
import { findField, SYSTEM_FIELDS } from "./fields.js";
import { findIssue, findUser } from "./lookup.js";

export class JqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JqlError";
  }
}

// Tokens

type TokenType = "word" | "string" | "op" | "lparen" | "rparen" | "comma" | "eof";

interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const OPERATORS = ["!=", "!~", ">=", "<=", "=", "~", ">", "<"];
const WORD_BREAK = /[\s()=,!~<>"']/;

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(") tokens.push({ type: "lparen", value: ch, pos: i++ });
    else if (ch === ")") tokens.push({ type: "rparen", value: ch, pos: i++ });
    else if (ch === ",") tokens.push({ type: "comma", value: ch, pos: i++ });
    else if (ch === '"' || ch === "'") {
      const start = i++;
      let value = "";
      let closed = false;
      while (i < input.length) {
        const c = input[i];
        if (c === "\\" && i + 1 < input.length) {
          value += input[i + 1];
          i += 2;
          continue;
        }
        if (c === ch) {
          closed = true;
          i++;
          break;
        }
        value += c;
        i++;
      }
      if (!closed) {
        throw new JqlError(
          `Error in the JQL Query: The quoted string '${value}' has not been completed. (line 1, character ${start + 1})`,
        );
      }
      tokens.push({ type: "string", value, pos: start });
    } else {
      const op = OPERATORS.find((candidate) => input.startsWith(candidate, i));
      if (op) {
        tokens.push({ type: "op", value: op, pos: i });
        i += op.length;
        continue;
      }
      if (ch === "!") {
        throw new JqlError(
          `Error in the JQL Query: The character '!' is a reserved JQL character. (line 1, character ${i + 1})`,
        );
      }
      const start = i;
      while (i < input.length && !WORD_BREAK.test(input[i])) i++;
      tokens.push({ type: "word", value: input.slice(start, i), pos: start });
    }
  }
  tokens.push({ type: "eof", value: "", pos: input.length });
  return tokens;
}

// AST

export type Operand =
  | { kind: "value"; value: string }
  | { kind: "fn"; name: string; args: string[] }
  | { kind: "empty" };

export type JqlNode =
  | { type: "and" | "or"; left: JqlNode; right: JqlNode }
  | { type: "not"; expr: JqlNode }
  | { type: "clause"; field: string; op: string; operands: Operand[]; listFn?: Operand };

export interface OrderBy {
  field: string;
  direction: "ASC" | "DESC";
}

export interface JqlQuery {
  where: JqlNode | null;
  orderBy: OrderBy[];
}

const KEYWORDS = new Set(["and", "or", "not", "in", "is", "empty", "null", "order", "by", "asc", "desc"]);

class Parser {
  private index = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.index];
  }

  private next(): Token {
    return this.tokens[this.index++];
  }

  private isKeyword(word: string, token = this.peek()): boolean {
    return token.type === "word" && token.value.toLowerCase() === word;
  }

  private fail(expecting: string): never {
    const token = this.peek();
    const got = token.type === "eof" ? "end of query" : `'${token.value}'`;
    throw new JqlError(
      `Error in the JQL Query: Expecting ${expecting} but got ${got}. (line 1, character ${token.pos + 1})`,
    );
  }

  parse(): JqlQuery {
    let where: JqlNode | null = null;
    if (this.peek().type !== "eof" && !this.isKeyword("order")) where = this.parseOr();
    const orderBy: OrderBy[] = [];
    if (this.isKeyword("order")) {
      this.next();
      if (!this.isKeyword("by")) this.fail("'by'");
      this.next();
      do {
        const token = this.peek();
        if (token.type !== "word" && token.type !== "string") this.fail("a field name");
        this.next();
        let direction: "ASC" | "DESC" = "ASC";
        if (this.isKeyword("asc") || this.isKeyword("desc"))
          direction = this.next().value.toUpperCase() as "ASC" | "DESC";
        orderBy.push({ field: token.value, direction });
      } while (this.peek().type === "comma" && this.next());
    }
    if (this.peek().type !== "eof") this.fail("either 'OR' or 'AND'");
    return { where, orderBy };
  }

  private parseOr(): JqlNode {
    let left = this.parseAnd();
    while (this.isKeyword("or")) {
      this.next();
      left = { type: "or", left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): JqlNode {
    let left = this.parseNot();
    while (this.isKeyword("and")) {
      this.next();
      left = { type: "and", left, right: this.parseNot() };
    }
    return left;
  }

  private parseNot(): JqlNode {
    if (this.isKeyword("not")) {
      this.next();
      return { type: "not", expr: this.parseNot() };
    }
    if (this.peek().type === "lparen") {
      this.next();
      const expr = this.parseOr();
      if (this.peek().type !== "rparen") this.fail("')'");
      this.next();
      return expr;
    }
    return this.parseClause();
  }

  private parseClause(): JqlNode {
    const fieldToken = this.peek();
    if (
      (fieldToken.type !== "word" && fieldToken.type !== "string") ||
      (fieldToken.type === "word" && KEYWORDS.has(fieldToken.value.toLowerCase()))
    ) {
      this.fail("a field name");
    }
    this.next();
    const field = fieldToken.value;
    const token = this.peek();

    if (token.type === "op") {
      this.next();
      return { type: "clause", field, op: token.value, operands: [this.parseOperand()] };
    }
    if (this.isKeyword("is")) {
      this.next();
      let op = "is";
      if (this.isKeyword("not")) {
        this.next();
        op = "is not";
      }
      if (!this.isKeyword("empty") && !this.isKeyword("null")) this.fail("'EMPTY' or 'NULL'");
      this.next();
      return { type: "clause", field, op, operands: [{ kind: "empty" }] };
    }
    let op = "in";
    if (this.isKeyword("not")) {
      this.next();
      op = "not in";
      if (!this.isKeyword("in")) this.fail("'IN'");
    }
    if (this.isKeyword("in")) {
      this.next();
      if (this.peek().type === "lparen") {
        this.next();
        const operands: Operand[] = [];
        if (this.peek().type !== "rparen") {
          operands.push(this.parseOperand());
          while (this.peek().type === "comma") {
            this.next();
            operands.push(this.parseOperand());
          }
        }
        if (this.peek().type !== "rparen") this.fail("')'");
        this.next();
        return { type: "clause", field, op, operands };
      }
      const fn = this.parseOperand();
      if (fn.kind !== "fn") this.fail("a list or function");
      return { type: "clause", field, op, operands: [], listFn: fn };
    }
    return this.fail("operator");
  }

  private parseOperand(): Operand {
    const token = this.peek();
    if (token.type === "string") {
      this.next();
      return { kind: "value", value: token.value };
    }
    if (token.type !== "word" || ["and", "or", "order", "in", "is", "not"].includes(token.value.toLowerCase())) {
      this.fail("either a value, list or function");
    }
    this.next();
    const lower = token.value.toLowerCase();
    if (lower === "empty" || lower === "null") return { kind: "empty" };
    if (this.peek().type === "lparen") {
      this.next();
      const args: string[] = [];
      while (this.peek().type !== "rparen") {
        const arg = this.peek();
        if (arg.type !== "word" && arg.type !== "string") this.fail("a function argument");
        args.push(this.next().value);
        if (this.peek().type === "comma") this.next();
        else if (this.peek().type !== "rparen") this.fail("')'");
      }
      this.next();
      return { kind: "fn", name: token.value, args };
    }
    return { kind: "value", value: token.value };
  }
}

export function parseJql(jql: string): JqlQuery {
  return new Parser(tokenize(jql ?? "")).parse();
}

// Evaluation

type Scalar = string | number;
type Resolved = { empty: true } | { empty: false; values: Scalar[]; dayPrecision?: boolean };

interface EvalContext {
  js: JiraStore;
  user: JiraUser;
  now: Date;
}

type FieldKind = "ref" | "text" | "date" | "number" | "priority" | "key";

/** Returned by `resolve` for literals such as `Unresolved` that mean "the field is empty". */
const MATCHES_EMPTY = Symbol("matches empty");

interface FieldHandler {
  name: string;
  kind: FieldKind;
  /** Current values of the field for an issue. Empty array means the field is empty. */
  get(issue: JiraIssue, ctx: EvalContext): Scalar[];
  /** Maps a literal from the query to comparable values. Throws for unknown values. */
  resolve?(value: string, ctx: EvalContext): Scalar[] | typeof MATCHES_EMPTY;
  /** ORDER BY key. Defaults to the first value from `get`, lowercased. */
  sort?(issue: JiraIssue, ctx: EvalContext): Scalar | null;
}

const eqi = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const lower = (value: string | undefined | null) => value?.toLowerCase() ?? null;

function notFoundValue(value: string, field: string): JqlError {
  return new JqlError(`The value '${value}' does not exist for the field '${field}'.`);
}

function refResolver<T extends { id: number }>(
  field: string,
  items: (ctx: EvalContext) => T[],
  names: (item: T) => string[],
) {
  return (value: string, ctx: EvalContext): Scalar[] => {
    const matches = items(ctx).filter(
      (item) => String(item.id) === value || names(item).some((name) => eqi(name, value)),
    );
    if (matches.length === 0) throw notFoundValue(value, field);
    return matches.map((item) => item.id);
  };
}

function userResolver(field: string) {
  return (value: string, ctx: EvalContext): Scalar[] => {
    const user = findUser(ctx.js, value);
    if (!user) throw notFoundValue(value, field);
    return [user.account_id];
  };
}

function resolveIssue(value: string, ctx: EvalContext): Scalar[] {
  const issue = findIssue(ctx.js, value);
  if (!issue) throw new JqlError(`An issue with key '${value}' does not exist for field 'key'.`);
  return [issue.id];
}

function dateOf(value: string | null | undefined): Scalar[] {
  if (!value) return [];
  const time = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isNaN(time) ? [] : [time];
}

type TextPart = "summary" | "description" | "environment" | "comment";

function issueText(issue: JiraIssue, ctx: EvalContext, parts: TextPart[]): string {
  const chunks: string[] = [];
  if (parts.includes("summary")) chunks.push(issue.summary);
  if (parts.includes("description")) chunks.push(adfToText(issue.description));
  if (parts.includes("environment")) chunks.push(adfToText(issue.environment));
  if (parts.includes("comment")) {
    for (const comment of ctx.js.comments.findBy("issue_id", issue.id)) chunks.push(adfToText(comment.body));
  }
  return chunks.join("\n");
}

const CATEGORY_ALIASES: Record<JiraStatusCategory, string[]> = {
  new: ["new", "To Do", "2"],
  indeterminate: ["indeterminate", "In Progress", "4"],
  done: ["done", "Done", "3"],
};

function textField(name: string, parts: TextPart[]): FieldHandler {
  return {
    name,
    kind: "text",
    get: (issue, ctx) => {
      const value = issueText(issue, ctx, parts);
      return value ? [value] : [];
    },
  };
}

function userField(name: string, key: "assignee_id" | "reporter_id" | "creator_id"): FieldHandler {
  return {
    name,
    kind: "ref",
    get: (issue) => (issue[key] ? [issue[key]!] : []),
    resolve: userResolver(name),
    sort: (issue, ctx) => lower(issue[key] ? ctx.js.users.findOneBy("account_id", issue[key]!)?.display_name : null),
  };
}

function dateField(name: string, value: (issue: JiraIssue) => string | null): FieldHandler {
  return { name, kind: "date", get: (issue) => dateOf(value(issue)) };
}

const sprintField: FieldHandler = {
  name: "sprint",
  kind: "ref",
  get: (issue) => [...issue.closed_sprint_ids, ...(issue.sprint_id ? [issue.sprint_id] : [])],
  resolve: refResolver(
    "sprint",
    (ctx) => ctx.js.sprints.all(),
    (s) => [s.name],
  ),
};

/**
 * JQL behavior for each searchable system field, keyed by the field id in `SYSTEM_FIELDS`. Clause names
 * (`type` for `issuetype`, `due` for `duedate`, ...) come from `SYSTEM_FIELDS`, plus the extra `aliases` below.
 */
const SYSTEM_JQL: Record<string, FieldHandler & { aliases?: string[] }> = {
  project: {
    name: "project",
    kind: "ref",
    get: (issue) => [issue.project_id],
    resolve: refResolver(
      "project",
      (ctx) => ctx.js.projects.all(),
      (p) => [p.key, p.name],
    ),
    sort: (issue, ctx) => ctx.js.projects.get(issue.project_id)?.key ?? null,
  },
  issuekey: {
    name: "key",
    kind: "key",
    get: (issue) => [issue.id],
    resolve: resolveIssue,
    sort: (issue, ctx) =>
      `${ctx.js.projects.get(issue.project_id)?.key ?? ""}-${String(issue.number).padStart(10, "0")}`,
  },
  summary: { ...textField("summary", ["summary"]), sort: (issue) => issue.summary.toLowerCase() },
  description: textField("description", ["description"]),
  environment: textField("environment", ["environment"]),
  comment: textField("comment", ["comment"]),
  text: { ...textField("text", ["summary", "description", "environment", "comment"]), aliases: ["text"] },
  status: {
    name: "status",
    kind: "ref",
    get: (issue) => [issue.status_id],
    resolve: refResolver(
      "status",
      (ctx) => ctx.js.statuses.all(),
      (s) => [s.name],
    ),
    sort: (issue, ctx) => lower(ctx.js.statuses.get(issue.status_id)?.name),
  },
  statusCategory: {
    name: "statusCategory",
    kind: "ref",
    get: (issue, ctx) => {
      const category = ctx.js.statuses.get(issue.status_id)?.category;
      return category ? [category] : [];
    },
    resolve: (value) => {
      const match = (Object.keys(CATEGORY_ALIASES) as JiraStatusCategory[]).find((key) =>
        CATEGORY_ALIASES[key].some((alias) => eqi(alias, value)),
      );
      if (!match) throw notFoundValue(value, "statusCategory");
      return [match];
    },
  },
  assignee: userField("assignee", "assignee_id"),
  reporter: userField("reporter", "reporter_id"),
  creator: userField("creator", "creator_id"),
  watches: { name: "watcher", kind: "ref", get: (issue) => [...issue.watcher_ids], resolve: userResolver("watcher") },
  priority: {
    name: "priority",
    kind: "priority",
    get: (issue) => (issue.priority_id ? [issue.priority_id] : []),
    resolve: refResolver(
      "priority",
      (ctx) => ctx.js.priorities.all(),
      (p) => [p.name],
    ),
    // Priorities are only seeded, in order from Highest to Lowest, so a lower id is more urgent.
    sort: (issue) => (issue.priority_id ? -issue.priority_id : null),
  },
  issuetype: {
    name: "issuetype",
    kind: "ref",
    get: (issue) => [issue.issue_type_id],
    resolve: refResolver(
      "issuetype",
      (ctx) => ctx.js.issueTypes.all(),
      (t) => [t.name],
    ),
    sort: (issue, ctx) => lower(ctx.js.issueTypes.get(issue.issue_type_id)?.name),
  },
  labels: {
    name: "labels",
    kind: "ref",
    get: (issue) => [...issue.labels],
    resolve: (value) => [value],
    aliases: ["label"],
  },
  resolution: {
    name: "resolution",
    kind: "ref",
    get: (issue) => (issue.resolution_id ? [issue.resolution_id] : []),
    resolve: (value, ctx) =>
      eqi(value, "unresolved")
        ? MATCHES_EMPTY
        : refResolver(
            "resolution",
            (c) => c.js.resolutions.all(),
            (r) => [r.name],
          )(value, ctx),
  },
  parent: {
    name: "parent",
    kind: "ref",
    get: (issue) => (issue.parent_id ? [issue.parent_id] : []),
    resolve: resolveIssue,
  },
  created: dateField("created", (issue) => issue.created_at),
  updated: dateField("updated", (issue) => issue.updated_at),
  duedate: dateField("duedate", (issue) => issue.due_date),
  resolutiondate: dateField("resolutiondate", (issue) => issue.resolution_date),
  statuscategorychangedate: dateField("statusCategoryChangedDate", (issue) => issue.status_changed_at),
  components: {
    name: "component",
    kind: "ref",
    get: (issue) => [...issue.component_ids],
    resolve: refResolver(
      "component",
      (ctx) => ctx.js.components.all(),
      (c) => [c.name],
    ),
  },
  fixVersions: {
    name: "fixVersion",
    kind: "ref",
    get: (issue) => [...issue.fix_version_ids],
    resolve: refResolver(
      "fixVersion",
      (ctx) => ctx.js.versions.all(),
      (v) => [v.name],
    ),
  },
  sprint: { ...sprintField, aliases: ["sprint"] },
};

/** Clause name (lowercased) to handler, built once from `SYSTEM_FIELDS` clause names and `SYSTEM_JQL` aliases. */
const SYSTEM_CLAUSES = new Map<string, FieldHandler>();
for (const field of SYSTEM_FIELDS) {
  const handler = SYSTEM_JQL[field.id];
  if (!handler) continue;
  for (const clause of [field.id, ...field.clauseNames]) SYSTEM_CLAUSES.set(clause.toLowerCase(), handler);
}
for (const handler of Object.values(SYSTEM_JQL)) {
  for (const alias of handler.aliases ?? []) SYSTEM_CLAUSES.set(alias.toLowerCase(), handler);
}

/** ORDER BY Rank is accepted and falls back to creation order, as the emulator has no rank field. */
const rankSort: FieldHandler = {
  name: "rank",
  kind: "number",
  get: () => [],
  sort: (issue) => issue.id,
};

function resolveFieldHandler(js: JiraStore, name: string): FieldHandler {
  const system = SYSTEM_CLAUSES.get(name.toLowerCase());
  if (system) return system;
  const def = findField(js, name);
  const custom = def?.custom ? js.customFields.findOneBy("field_id", def.id) : undefined;
  if (!custom) throw new JqlError(`Field '${name}' does not exist or you do not have permission to view it.`);
  if (custom.type === "sprint") return sprintField;
  const raw = (issue: JiraIssue): Scalar[] => {
    const value = issue.custom_fields[custom.field_id];
    if (value === null || value === undefined) return [];
    return Array.isArray(value) ? value.map(String) : [typeof value === "number" ? value : String(value)];
  };
  switch (custom.type) {
    case "number":
      return { name: custom.name, kind: "number", get: raw, resolve: (value) => [Number(value)] };
    case "date":
    case "datetime":
      return dateField(custom.name, (issue) => issue.custom_fields[custom.field_id] as string | null);
    case "string":
      return { name: custom.name, kind: "text", get: raw };
    case "user":
      return { name: custom.name, kind: "ref", get: raw, resolve: userResolver(custom.name) };
    default:
      return { name: custom.name, kind: "ref", get: raw, resolve: (value) => [value] };
  }
}

function sortHandler(js: JiraStore, name: string): FieldHandler {
  return name.toLowerCase() === "rank" ? rankSort : resolveFieldHandler(js, name);
}

// Functions

const DAY = 24 * 3600 * 1000;

const FUNCTION_UNITS: Record<"day" | "week" | "month" | "year", string> = {
  day: "d",
  week: "w",
  month: "M",
  year: "y",
};

/**
 * Shifts a date by a Jira period such as `-1d`, `+2w`, `-1M`, `1y`, or `-1w 2d`. Units are
 * y (years), M (months), w (weeks), d (days), h (hours), and m (minutes). A bare number uses
 * `defaultUnit`, which date functions set to their own unit. Returns null for invalid input.
 */
function shiftDate(base: Date, value: string, defaultUnit?: string): Date | null {
  const trimmed = value.replace(/\s+/g, "");
  const match = /^([+-]?)((?:\d+[yMwdhm])+|\d+)$/.exec(trimmed);
  if (!match) return null;
  const sign = match[1] === "-" ? -1 : 1;
  const parts = /^\d+$/.test(match[2])
    ? defaultUnit
      ? [`${match[2]}${defaultUnit}`]
      : []
    : match[2].match(/\d+[yMwdhm]/g);
  if (!parts || parts.length === 0) return null;
  const date = new Date(base);
  for (const part of parts) {
    const amount = sign * Number(part.slice(0, -1));
    const unit = part.slice(-1);
    if (unit === "y") date.setUTCFullYear(date.getUTCFullYear() + amount);
    else if (unit === "M") date.setUTCMonth(date.getUTCMonth() + amount);
    else if (unit === "w") date.setTime(date.getTime() + amount * 7 * DAY);
    else if (unit === "d") date.setTime(date.getTime() + amount * DAY);
    else if (unit === "h") date.setTime(date.getTime() + amount * 3600 * 1000);
    else date.setTime(date.getTime() + amount * 60 * 1000);
  }
  return date;
}

function applyOffset(base: Date, offset: string | undefined, defaultUnit: string): Date {
  if (!offset) return base;
  const shifted = shiftDate(base, offset, defaultUnit);
  if (!shifted) throw new JqlError(`Invalid date offset '${offset}'.`);
  return shifted;
}

function startOf(unit: "day" | "week" | "month" | "year", date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  if (unit === "week") d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  if (unit === "month") d.setUTCDate(1);
  if (unit === "year") d.setUTCMonth(0, 1);
  return d;
}

function endOf(unit: "day" | "week" | "month" | "year", date: Date): Date {
  const start = startOf(unit, date);
  const next = new Date(start);
  if (unit === "day") next.setUTCDate(next.getUTCDate() + 1);
  if (unit === "week") next.setUTCDate(next.getUTCDate() + 7);
  if (unit === "month") next.setUTCMonth(next.getUTCMonth() + 1);
  if (unit === "year") next.setUTCFullYear(next.getUTCFullYear() + 1);
  return new Date(next.getTime() - 1);
}

function callFunction(fn: { name: string; args: string[] }, ctx: EvalContext): Scalar[] {
  const name = fn.name.toLowerCase();
  const js = ctx.js;
  const dateFn = /^(start|end)of(day|week|month|year)$/.exec(name);
  if (dateFn) {
    const unit = dateFn[2] as "day" | "week" | "month" | "year";
    const base = dateFn[1] === "start" ? startOf(unit, ctx.now) : endOf(unit, ctx.now);
    return [applyOffset(base, fn.args[0], FUNCTION_UNITS[unit]).getTime()];
  }
  switch (name) {
    case "currentuser":
      return [ctx.user.account_id];
    case "now":
      return [ctx.now.getTime()];
    case "opensprints":
      return js.sprints
        .all()
        .filter((s) => s.state !== "closed")
        .map((s) => s.id);
    case "closedsprints":
      return js.sprints
        .all()
        .filter((s) => s.state === "closed")
        .map((s) => s.id);
    case "futuresprints":
      return js.sprints
        .all()
        .filter((s) => s.state === "future")
        .map((s) => s.id);
    case "standardissuetypes":
      return js.issueTypes
        .all()
        .filter((t) => !t.subtask)
        .map((t) => t.id);
    case "subtaskissuetypes":
      return js.issueTypes
        .all()
        .filter((t) => t.subtask)
        .map((t) => t.id);
    case "releasedversions":
    case "unreleasedversions": {
      const released = name === "releasedversions";
      const project = fn.args[0]
        ? js.projects.all().find((p) => eqi(p.key, fn.args[0]) || String(p.id) === fn.args[0])
        : undefined;
      return js.versions
        .all()
        .filter((v) => v.released === released && (!project || v.project_id === project.id))
        .map((v) => v.id);
    }
    case "linkedissues": {
      const [ref, linkText] = fn.args;
      if (!ref) throw new JqlError("Function 'linkedIssues' expects at least one argument.");
      const issue = /^\d+$/.test(ref) ? js.issues.get(Number(ref)) : js.issues.all().find((i) => eqi(i.key, ref));
      if (!issue) throw new JqlError(`Issue '${ref}' could not be found in function 'linkedIssues'.`);
      const results: number[] = [];
      for (const link of js.issueLinks.findBy("inward_issue_id", issue.id)) {
        const type = js.issueLinkTypes.get(link.type_id);
        if (!linkText || (type && eqi(type.inward, linkText))) results.push(link.outward_issue_id);
      }
      for (const link of js.issueLinks.findBy("outward_issue_id", issue.id)) {
        const type = js.issueLinkTypes.get(link.type_id);
        if (!linkText || (type && eqi(type.outward, linkText))) results.push(link.inward_issue_id);
      }
      return results;
    }
    default:
      throw new JqlError(`Unable to find JQL function '${fn.name}()'.`);
  }
}

function parseDateLiteral(value: string, ctx: EvalContext): { time: number; dayPrecision: boolean } {
  const relative = shiftDate(ctx.now, value);
  if (relative) return { time: relative.getTime(), dayPrecision: false };
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(value.trim());
  if (!match)
    throw new JqlError(
      `Date value '${value}' for field is invalid. Valid formats include: 'yyyy/MM/dd HH:mm', 'yyyy-MM-dd HH:mm', 'yyyy/MM/dd', 'yyyy-MM-dd', or a period format e.g. '-5d', '4w 2d'.`,
    );
  const [, y, m, d, hh, mm] = match;
  const time = Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh ?? 0), Number(mm ?? 0));
  return { time, dayPrecision: hh === undefined };
}

function resolveOperand(handler: FieldHandler, operand: Operand, ctx: EvalContext): Resolved {
  if (operand.kind === "empty") return { empty: true };
  if (operand.kind === "fn") return { empty: false, values: callFunction(operand, ctx) };
  if (handler.kind === "date") {
    const parsed = parseDateLiteral(operand.value, ctx);
    return { empty: false, values: [parsed.time], dayPrecision: parsed.dayPrecision };
  }
  if (handler.kind === "text") return { empty: false, values: [operand.value] };
  if (handler.kind === "number") {
    const number = Number(operand.value);
    if (!Number.isFinite(number))
      throw new JqlError(`The value '${operand.value}' is not a valid number for '${handler.name}'.`);
    return { empty: false, values: [number] };
  }
  const values = handler.resolve ? handler.resolve(operand.value, ctx) : [operand.value];
  return values === MATCHES_EMPTY ? { empty: true } : { empty: false, values };
}

function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function textMatches(haystack: string, query: string): boolean {
  const trimmed = query.trim();
  const phrase = /^"(.*)"$/.exec(trimmed);
  if (phrase) return haystack.toLowerCase().includes(phrase[1].toLowerCase());
  const words = wordsOf(haystack);
  const terms = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((term) => {
    const prefix = term.replace(/[*?]+$/, "").replace(/[^\p{L}\p{N}]/gu, "");
    if (!prefix) return true;
    return words.some((word) => word.startsWith(prefix));
  });
}

function compileClause(node: Extract<JqlNode, { type: "clause" }>, ctx: EvalContext): (issue: JiraIssue) => boolean {
  const handler = resolveFieldHandler(ctx.js, node.field);
  const op = node.op.toLowerCase();

  if (op === "is" || op === "is not") {
    return (issue) => (handler.get(issue, ctx).length === 0) === (op === "is");
  }

  if (op === "~" || op === "!~") {
    if (handler.kind !== "text") {
      throw new JqlError(`The operator '${node.op}' is not supported by the '${node.field}' field.`);
    }
    const operand = node.operands[0];
    if (operand.kind !== "value") throw new JqlError(`The operator '${node.op}' requires a text value.`);
    return (issue) => {
      const text = handler.get(issue, ctx)[0];
      const matches = text !== undefined && textMatches(String(text), operand.value);
      return op === "~" ? matches : text !== undefined && !matches;
    };
  }

  const operands = node.listFn ? [node.listFn] : node.operands;
  const resolved = operands.map((operand) => resolveOperand(handler, operand, ctx));
  const wantsEmpty = resolved.some((entry) => entry.empty);
  const values = resolved.flatMap((entry) => (entry.empty ? [] : entry.values));
  const dayPrecision = resolved.some((entry) => !entry.empty && entry.dayPrecision);

  const eq = (a: Scalar, b: Scalar) =>
    handler.kind === "date" && dayPrecision
      ? Math.floor(Number(a) / DAY) === Math.floor(Number(b) / DAY)
      : typeof a === "string" && typeof b === "string"
        ? eqi(a, b)
        : a === b;

  const matchesAny = (issue: JiraIssue) => {
    const current = handler.get(issue, ctx);
    if (current.length === 0) return wantsEmpty;
    return current.some((value) => values.some((candidate) => eq(value, candidate)));
  };

  if (op === "=" || op === "in") return matchesAny;
  if (op === "!=" || op === "not in") {
    // Like Jira, negative operators never match issues where the field is empty.
    return (issue) => handler.get(issue, ctx).length > 0 && !matchesAny(issue);
  }

  // Ordering comparisons
  if (!["date", "number", "priority", "key"].includes(handler.kind)) {
    throw new JqlError(`The operator '${node.op}' is not supported by the '${node.field}' field.`);
  }
  if (values.length !== 1) throw new JqlError(`The operator '${node.op}' requires a single value.`);
  const target = values[0];
  const cmp = (value: Scalar): number => {
    if (handler.kind === "priority") {
      // Lower priority ids are more urgent, so "priority > Medium" means Highest and High.
      return Number(target) - Number(value);
    }
    if (handler.kind === "key") {
      const issue = ctx.js.issues.get(Number(value));
      const other = ctx.js.issues.get(Number(target));
      if (!issue || !other || issue.project_id !== other.project_id) return Number.NaN;
      return issue.number - other.number;
    }
    if (handler.kind === "date" && dayPrecision && (op === "<=" || op === ">")) {
      // A bare date covers the whole day, so "<= 2026-10-15" includes that day.
      return Number(value) - (Number(target) + DAY - 1);
    }
    return Number(value) - Number(target);
  };
  const test: Record<string, (n: number) => boolean> = {
    ">": (n) => n > 0,
    ">=": (n) => n >= 0,
    "<": (n) => n < 0,
    "<=": (n) => n <= 0,
  };
  return (issue) => handler.get(issue, ctx).some((value) => test[op](cmp(value)));
}

function compile(node: JqlNode, ctx: EvalContext): (issue: JiraIssue) => boolean {
  switch (node.type) {
    case "and": {
      const left = compile(node.left, ctx);
      const right = compile(node.right, ctx);
      return (issue) => left(issue) && right(issue);
    }
    case "or": {
      const left = compile(node.left, ctx);
      const right = compile(node.right, ctx);
      return (issue) => left(issue) || right(issue);
    }
    case "not": {
      const inner = compile(node.expr, ctx);
      return (issue) => !inner(issue);
    }
    case "clause":
      return compileClause(node, ctx);
  }
}

function sortValue(handler: FieldHandler, issue: JiraIssue, ctx: EvalContext): Scalar | null {
  if (handler.sort) return handler.sort(issue, ctx);
  const value = handler.get(issue, ctx)[0];
  if (value === undefined) return null;
  return typeof value === "string" ? value.toLowerCase() : value;
}

function sortIssues(issues: JiraIssue[], orderBy: OrderBy[], ctx: EvalContext): JiraIssue[] {
  const order = orderBy.length > 0 ? orderBy : [{ field: "created", direction: "DESC" as const }];
  const handlers = order.map((entry) => sortHandler(ctx.js, entry.field));
  const keyed = issues.map((issue) => ({ issue, keys: handlers.map((handler) => sortValue(handler, issue, ctx)) }));
  keyed.sort((a, b) => {
    for (let i = 0; i < order.length; i++) {
      const av = a.keys[i];
      const bv = b.keys[i];
      if (av === bv) continue;
      if (av === null) return 1;
      if (bv === null) return -1;
      const diff = av < bv ? -1 : 1;
      return order[i].direction === "DESC" ? -diff : diff;
    }
    return order[0].direction === "DESC" ? b.issue.id - a.issue.id : a.issue.id - b.issue.id;
  });
  return keyed.map((entry) => entry.issue);
}

/**
 * Compiles JQL into a predicate for testing single issues, such as webhook filters. Unknown fields and values
 * (including ORDER BY fields) throw JqlError up front. ORDER BY itself is ignored.
 */
export function compileJql(
  js: JiraStore,
  jql: string,
  user: JiraUser,
  now = new Date(),
): (issue: JiraIssue) => boolean {
  const query = parseJql(jql);
  const ctx: EvalContext = { js, user, now };
  for (const entry of query.orderBy) sortHandler(js, entry.field);
  return query.where ? compile(query.where, ctx) : () => true;
}

/** Runs a JQL query against the store. Throws JqlError for invalid queries. */
export function searchIssues(js: JiraStore, jql: string, user: JiraUser, now = new Date()): JiraIssue[] {
  const query = parseJql(jql);
  return runQuery(js, query, user, now);
}

export function runQuery(js: JiraStore, query: JqlQuery, user: JiraUser, now = new Date()): JiraIssue[] {
  const ctx: EvalContext = { js, user, now };
  const predicate = query.where ? compile(query.where, ctx) : () => true;
  // Resolving the sort handlers inside sortIssues also rejects unknown ORDER BY fields when nothing matches.
  return sortIssues(js.issues.all().filter(predicate), query.orderBy, ctx);
}
