export interface ConnectionArgs {
  first?: number | null;
  after?: string | null;
  last?: number | null;
  before?: string | null;
}

export function connectionFromArray<T>(items: T[], args: ConnectionArgs = {}) {
  const beforeIndex = args.before ? decodeCursor(args.before) : items.length;
  const afterIndex = args.after ? decodeCursor(args.after) + 1 : 0;
  let start = Math.max(0, afterIndex);
  let end = Math.min(items.length, beforeIndex);

  if (typeof args.first === "number") {
    end = Math.min(end, start + Math.max(0, args.first));
  } else if (typeof args.last === "number") {
    start = Math.max(start, end - Math.max(0, args.last));
  } else {
    end = Math.min(end, start + 50);
  }

  const slice = items.slice(start, end);
  const edges = slice.map((node, offset) => ({
    node,
    cursor: encodeCursor(start + offset),
  }));

  return {
    nodes: slice,
    edges,
    pageInfo: {
      hasNextPage: end < items.length,
      hasPreviousPage: start > 0,
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges[edges.length - 1]?.cursor ?? null,
    },
  };
}

function encodeCursor(index: number): string {
  return Buffer.from(`linear:${index}`, "utf-8").toString("base64url");
}

function decodeCursor(cursor: string): number {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf-8");
    const [, index] = decoded.split(":");
    const parsed = Number(index);
    return Number.isFinite(parsed) ? parsed : -1;
  } catch {
    return -1;
  }
}
