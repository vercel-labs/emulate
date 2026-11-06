import { GitHubGraphQLError } from "./context.js";

export interface ConnectionArgs {
  first?: number | null;
  after?: string | null;
  last?: number | null;
  before?: string | null;
}

const MAX_PAGE_SIZE = 100;

export function connectionFromArray<T>(items: T[], args: ConnectionArgs = {}, extra: Record<string, unknown> = {}) {
  const afterIndex = args.after ? decodeCursor(args.after) : -1;
  const beforeIndex = args.before ? decodeCursor(args.before) : items.length;
  const invalidCursor = Number.isNaN(afterIndex) ? args.after : Number.isNaN(beforeIndex) ? args.before : null;
  if (invalidCursor) {
    // GitHub still resolves totalCount and reports the bad cursor on each page field.
    const fail = () => {
      throw new GitHubGraphQLError(
        "INVALID_CURSOR_ARGUMENTS",
        `\`${invalidCursor}\` does not appear to be a valid cursor.`,
      );
    };
    return { ...extra, totalCount: items.length, nodes: fail, edges: fail, pageInfo: fail };
  }
  let start = Math.max(0, afterIndex + 1);
  let end = Math.min(items.length, beforeIndex);

  if (typeof args.first === "number") {
    end = Math.min(end, start + Math.max(0, args.first));
  } else if (typeof args.last === "number") {
    start = Math.max(start, end - Math.max(0, args.last));
  } else {
    end = Math.min(end, start + MAX_PAGE_SIZE);
  }

  const nodes = items.slice(start, end);
  const edges = nodes.map((node, offset) => ({ node, cursor: encodeCursor(start + offset) }));

  return {
    ...extra,
    nodes,
    edges,
    totalCount: items.length,
    pageInfo: {
      hasNextPage: end < items.length,
      hasPreviousPage: start > 0,
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges[edges.length - 1]?.cursor ?? null,
    },
  };
}

export function encodeCursor(index: number): string {
  return Buffer.from(`cursor:v2:${index}`, "utf8").toString("base64");
}

function decodeCursor(cursor: string): number {
  const match = /^cursor:v2:(\d+)$/.exec(Buffer.from(cursor, "base64").toString("utf8"));
  return match ? Number(match[1]) : Number.NaN;
}
