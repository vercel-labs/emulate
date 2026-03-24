// RFC 7644 SCIM Filter Parser
// Recursive descent parser: Tokenizer -> AST Parser -> Evaluator

// ─── Token types ───────────────────────────────────────────────

type TokenType =
  | "ATTR"
  | "STRING"
  | "NUMBER"
  | "BOOLEAN"
  | "NULL"
  | "OP"
  | "PR"
  | "AND"
  | "OR"
  | "NOT"
  | "LPAREN"
  | "RPAREN"
  | "LBRACKET"
  | "RBRACKET"
  | "DOT";

interface Token {
  type: TokenType;
  value: string;
}

// ─── AST node types ────────────────────────────────────────────

type FilterNode =
  | { type: "comparison"; path: string; op: string; value: unknown }
  | { type: "presence"; path: string }
  | { type: "logical"; op: "and" | "or"; left: FilterNode; right: FilterNode }
  | { type: "not"; operand: FilterNode }
  | {
      type: "valuePath";
      path: string;
      filter: FilterNode;
      subAttr?: string;
      comparison?: { op: string; value: unknown };
    };

// ─── Tokenizer ─────────────────────────────────────────────────

const OPERATORS = new Set([
  "eq",
  "ne",
  "co",
  "sw",
  "ew",
  "gt",
  "ge",
  "lt",
  "le",
]);

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    // Skip whitespace
    if (/\s/.test(input[i])) {
      i++;
      continue;
    }

    // String literal
    if (input[i] === '"') {
      i++; // skip opening quote
      let str = "";
      while (i < input.length && input[i] !== '"') {
        if (input[i] === "\\" && i + 1 < input.length) {
          i++;
          str += input[i];
        } else {
          str += input[i];
        }
        i++;
      }
      if (i >= input.length) throw new Error("Unterminated string literal");
      i++; // skip closing quote
      tokens.push({ type: "STRING", value: str });
      continue;
    }

    // Parens and brackets
    if (input[i] === "(") {
      tokens.push({ type: "LPAREN", value: "(" });
      i++;
      continue;
    }
    if (input[i] === ")") {
      tokens.push({ type: "RPAREN", value: ")" });
      i++;
      continue;
    }
    if (input[i] === "[") {
      tokens.push({ type: "LBRACKET", value: "[" });
      i++;
      continue;
    }
    if (input[i] === "]") {
      tokens.push({ type: "RBRACKET", value: "]" });
      i++;
      continue;
    }

    // Dot
    if (input[i] === ".") {
      tokens.push({ type: "DOT", value: "." });
      i++;
      continue;
    }

    // Words (identifiers, operators, keywords, booleans, null) and numbers
    if (/[a-zA-Z0-9_\-:]/.test(input[i])) {
      let word = "";
      // URN-prefixed attributes can contain colons, so we greedily consume
      while (i < input.length && /[a-zA-Z0-9_\-:]/.test(input[i])) {
        word += input[i];
        i++;
      }

      const lower = word.toLowerCase();

      if (lower === "and") {
        tokens.push({ type: "AND", value: "and" });
      } else if (lower === "or") {
        tokens.push({ type: "OR", value: "or" });
      } else if (lower === "not") {
        tokens.push({ type: "NOT", value: "not" });
      } else if (lower === "pr") {
        tokens.push({ type: "PR", value: "pr" });
      } else if (lower === "true" || lower === "false") {
        tokens.push({ type: "BOOLEAN", value: lower });
      } else if (lower === "null") {
        tokens.push({ type: "NULL", value: "null" });
      } else if (OPERATORS.has(lower)) {
        tokens.push({ type: "OP", value: lower });
      } else if (/^-?\d+(\.\d+)?$/.test(word)) {
        tokens.push({ type: "NUMBER", value: word });
      } else {
        tokens.push({ type: "ATTR", value: word });
      }
      continue;
    }

    throw new Error(`Unexpected character: ${input[i]} at position ${i}`);
  }

  return tokens;
}

// ─── Parser (recursive descent) ────────────────────────────────

class Parser {
  private pos = 0;

  constructor(private tokens: Token[]) {}

  parse(): FilterNode {
    if (this.tokens.length === 0) {
      throw new Error("Empty filter expression");
    }
    const node = this.parseOr();
    if (this.pos < this.tokens.length) {
      throw new Error(
        `Unexpected token: ${this.tokens[this.pos].value} at position ${this.pos}`
      );
    }
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private advance(): Token {
    return this.tokens[this.pos++];
  }

  private expect(type: TokenType): Token {
    const t = this.peek();
    if (!t || t.type !== type) {
      throw new Error(
        `Expected ${type}, got ${t ? `${t.type}(${t.value})` : "EOF"}`
      );
    }
    return this.advance();
  }

  // or-expr = and-expr ("or" and-expr)*
  private parseOr(): FilterNode {
    let left = this.parseAnd();
    while (this.peek()?.type === "OR") {
      this.advance();
      const right = this.parseAnd();
      left = { type: "logical", op: "or", left, right };
    }
    return left;
  }

  // and-expr = unary-expr ("and" unary-expr)*
  private parseAnd(): FilterNode {
    let left = this.parseUnary();
    while (this.peek()?.type === "AND") {
      this.advance();
      const right = this.parseUnary();
      left = { type: "logical", op: "and", left, right };
    }
    return left;
  }

  // unary-expr = "not" "(" or-expr ")" | primary
  private parseUnary(): FilterNode {
    if (this.peek()?.type === "NOT") {
      this.advance();
      this.expect("LPAREN");
      const operand = this.parseOr();
      this.expect("RPAREN");
      return { type: "not", operand };
    }
    return this.parsePrimary();
  }

  // primary = "(" or-expr ")" | attrPath "[" filter "]" "." subAttr op value | attrPath op value | attrPath "pr"
  private parsePrimary(): FilterNode {
    // Grouped expression
    if (this.peek()?.type === "LPAREN") {
      this.advance();
      const node = this.parseOr();
      this.expect("RPAREN");
      return node;
    }

    // Must be an attribute path
    const path = this.parseAttrPath();

    // Value path filter: attr[filter].subAttr op value
    if (this.peek()?.type === "LBRACKET") {
      this.advance();
      const filter = this.parseOr();
      this.expect("RBRACKET");

      let subAttr: string | undefined;
      let comparison: { op: string; value: unknown } | undefined;

      if (this.peek()?.type === "DOT") {
        this.advance();
        const subToken = this.expect("ATTR");
        subAttr = subToken.value;

        if (this.peek()?.type === "OP") {
          const opToken = this.advance();
          const val = this.parseValue();
          comparison = { op: opToken.value, value: val };
        }
      }

      return { type: "valuePath", path, filter, subAttr, comparison };
    }

    // Presence check
    if (this.peek()?.type === "PR") {
      this.advance();
      return { type: "presence", path };
    }

    // Comparison
    if (this.peek()?.type === "OP") {
      const opToken = this.advance();
      const value = this.parseValue();
      return { type: "comparison", path, op: opToken.value, value };
    }

    throw new Error(`Expected operator after attribute path "${path}"`);
  }

  private parseAttrPath(): string {
    const first = this.expect("ATTR");
    let path = first.value;

    // Consume dot-separated segments (but not if next-next is a bracket or operator — those belong to the main parse)
    while (this.peek()?.type === "DOT") {
      const nextNext = this.tokens[this.pos + 1];
      if (!nextNext || nextNext.type !== "ATTR") break;
      this.advance(); // consume dot
      const seg = this.advance(); // consume attr
      path += "." + seg.value;
    }

    return path;
  }

  private parseValue(): unknown {
    const t = this.peek();
    if (!t)
      throw new Error("Expected value, got EOF");

    if (t.type === "STRING") {
      this.advance();
      return t.value;
    }
    if (t.type === "NUMBER") {
      this.advance();
      return Number(t.value);
    }
    if (t.type === "BOOLEAN") {
      this.advance();
      return t.value === "true";
    }
    if (t.type === "NULL") {
      this.advance();
      return null;
    }

    throw new Error(`Expected value, got ${t.type}(${t.value})`);
  }
}

// ─── Attribute resolution ──────────────────────────────────────

function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  // Handle URN-prefixed paths like:
  // urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department
  // The URN is everything up to the last colon-separated segment that is the attribute name
  const urnMatch = path.match(/^(urn:[^:]+(?::[^:]+)+):([^:]+)$/);
  if (urnMatch) {
    const schemaUrn = urnMatch[1];
    const attrName = urnMatch[2];
    const schemaObj = obj[schemaUrn];
    if (schemaObj && typeof schemaObj === "object") {
      return (schemaObj as Record<string, unknown>)[attrName];
    }
    return undefined;
  }

  // Standard dot-path resolution
  const segments = path.split(".");
  let current: unknown = obj;
  for (const seg of segments) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

// ─── Evaluator ─────────────────────────────────────────────────

function compareValues(actual: unknown, expected: unknown, op: string): boolean {
  const numActual = typeof actual === "number" ? actual : Number(actual);
  const numExpected = typeof expected === "number" ? expected : Number(expected);

  // Use numeric comparison if both are valid numbers
  const useNumeric = !isNaN(numActual) && !isNaN(numExpected) &&
    typeof actual !== "boolean" && typeof expected !== "boolean";

  const a = useNumeric ? numActual : String(actual ?? "");
  const b = useNumeric ? numExpected : String(expected ?? "");

  switch (op) {
    case "gt": return a > b;
    case "ge": return a >= b;
    case "lt": return a < b;
    case "le": return a <= b;
    default: return false;
  }
}

function compare(
  actual: unknown,
  op: string,
  expected: unknown
): boolean {
  // Case-insensitive string comparison
  const norm = (v: unknown): unknown => {
    if (typeof v === "string") return v.toLowerCase();
    return v;
  };

  switch (op) {
    case "eq":
      return norm(actual) === norm(expected);
    case "ne":
      return norm(actual) !== norm(expected);
    case "co":
      if (typeof actual === "string" && typeof expected === "string")
        return actual.toLowerCase().includes(expected.toLowerCase());
      return false;
    case "sw":
      if (typeof actual === "string" && typeof expected === "string")
        return actual.toLowerCase().startsWith(expected.toLowerCase());
      return false;
    case "ew":
      if (typeof actual === "string" && typeof expected === "string")
        return actual.toLowerCase().endsWith(expected.toLowerCase());
      return false;
    case "gt":
    case "ge":
    case "lt":
    case "le":
      return compareValues(actual, expected, op);
    default:
      throw new Error(`Unknown operator: ${op}`);
  }
}

function evaluate(
  node: FilterNode,
  resource: Record<string, unknown>
): boolean {
  switch (node.type) {
    case "comparison": {
      const actual = resolvePath(resource, node.path);
      return compare(actual, node.op, node.value);
    }
    case "presence": {
      const val = resolvePath(resource, node.path);
      return val !== undefined && val !== null;
    }
    case "logical": {
      const left = evaluate(node.left, resource);
      const right = evaluate(node.right, resource);
      return node.op === "and" ? left && right : left || right;
    }
    case "not":
      return !evaluate(node.operand, resource);
    case "valuePath": {
      const arr = resolvePath(resource, node.path);
      if (!Array.isArray(arr)) return false;

      const filtered = arr.filter((item: Record<string, unknown>) =>
        evaluate(node.filter, item)
      );

      if (node.subAttr && node.comparison) {
        return filtered.some((item: Record<string, unknown>) =>
          compare(item[node.subAttr!], node.comparison!.op, node.comparison!.value)
        );
      }

      if (node.subAttr) {
        return filtered.some(
          (item: Record<string, unknown>) =>
            item[node.subAttr!] !== undefined && item[node.subAttr!] !== null
        );
      }

      return filtered.length > 0;
    }
    default:
      throw new Error(`Unknown node type: ${(node as FilterNode).type}`);
  }
}

// ─── Public API ────────────────────────────────────────────────

export function parseFilter(
  filter: string
): (resource: Record<string, unknown>) => boolean {
  const trimmed = filter.trim();
  if (!trimmed) throw new Error("Empty filter expression");

  const tokens = tokenize(trimmed);
  const parser = new Parser(tokens);
  const ast = parser.parse();

  return (resource: Record<string, unknown>) => evaluate(ast, resource);
}
