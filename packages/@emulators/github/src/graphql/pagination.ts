import { createHash } from "node:crypto";

export interface GraphQLConnectionArgs {
  first?: number | null;
  after?: string | null;
  last?: number | null;
  before?: string | null;
}

export interface GraphQLPageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

export interface GraphQLEdge<T> {
  cursor: string;
  node: T;
}

export interface GraphQLConnection<T> {
  nodes: T[];
  edges: GraphQLEdge<T>[];
  pageInfo: GraphQLPageInfo;
  totalCount: number;
}

const CURSOR_PREFIX = "github:graphql:v1:";
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 100;

function connectionKey(connection: string): string {
  return createHash("sha256").update(connection).digest("base64url").slice(0, 16);
}

export class InvalidGraphQLCursorError extends Error {
  constructor(cursor: string) {
    super(`Invalid cursor: ${cursor}`);
    this.name = "InvalidGraphQLCursorError";
  }
}

export class InvalidGraphQLPageSizeError extends Error {
  constructor(argument: "first" | "last") {
    super(`Argument '${argument}' must be between 0 and ${MAX_PAGE_SIZE}`);
    this.name = "InvalidGraphQLPageSizeError";
  }
}

function encodeCursor(connection: string, index: number): string {
  return Buffer.from(`${CURSOR_PREFIX}${connectionKey(connection)}:${index}`, "utf8").toString("base64url");
}

function decodeCursorPayload(cursor: string): string {
  if (typeof cursor !== "string" || cursor.length === 0) {
    throw new InvalidGraphQLCursorError(String(cursor));
  }
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new InvalidGraphQLCursorError(cursor);
  }

  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new InvalidGraphQLCursorError(cursor);
  }
  if (Buffer.from(decoded, "utf8").toString("base64url") !== cursor) {
    throw new InvalidGraphQLCursorError(cursor);
  }

  return decoded;
}

function parseCursorIndex(decoded: string, connection: string, cursor: string, itemCount: number): number {
  const prefix = `${CURSOR_PREFIX}${connectionKey(connection)}:`;
  if (!decoded.startsWith(prefix)) {
    throw new InvalidGraphQLCursorError(cursor);
  }

  const rawIndex = decoded.slice(prefix.length);
  if (!/^\d+$/.test(rawIndex)) {
    throw new InvalidGraphQLCursorError(cursor);
  }

  const index = Number(rawIndex);
  if (!Number.isSafeInteger(index) || index < 0 || index >= itemCount) {
    throw new InvalidGraphQLCursorError(cursor);
  }
  return index;
}

function decodeCursor(cursor: string, connection: string, itemCount: number): number {
  return parseCursorIndex(decodeCursorPayload(cursor), connection, cursor, itemCount);
}

function normalizePageSize(value: number | null | undefined, argument: "first" | "last"): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0 || value > MAX_PAGE_SIZE) {
    throw new InvalidGraphQLPageSizeError(argument);
  }
  return value;
}

/**
 * Build a Relay-style connection with strict, connection-bound opaque cursors.
 * Cursors carry only an internal offset and never expose an entity ID.
 */
export function connectionFromArray<T>(
  items: T[],
  args: GraphQLConnectionArgs = {},
  connection = "default",
): GraphQLConnection<T> {
  const first = normalizePageSize(args.first, "first");
  const last = normalizePageSize(args.last, "last");

  if (first !== undefined && last !== undefined) {
    throw new Error("Arguments 'first' and 'last' cannot be used together");
  }

  const afterIndex = args.after == null ? -1 : decodeCursor(args.after, connection, items.length);
  const beforeIndex = args.before == null ? items.length : decodeCursor(args.before, connection, items.length);
  if (afterIndex >= beforeIndex) {
    throw new InvalidGraphQLCursorError(args.after ?? args.before ?? "");
  }

  let start = afterIndex + 1;
  let end = beforeIndex;

  if (first !== undefined) {
    end = Math.min(end, start + first);
  } else if (last !== undefined) {
    start = Math.max(start, end - last);
  } else {
    end = Math.min(end, start + DEFAULT_PAGE_SIZE);
  }

  const nodes = items.slice(start, end);
  const edges = nodes.map((node, offset) => ({
    node,
    cursor: encodeCursor(connection, start + offset),
  }));

  return {
    nodes,
    edges,
    pageInfo: {
      hasNextPage: end < items.length,
      hasPreviousPage: start > 0,
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges[edges.length - 1]?.cursor ?? null,
    },
    totalCount: items.length,
  };
}
