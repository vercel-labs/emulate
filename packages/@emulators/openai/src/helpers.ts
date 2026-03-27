import { createHash, randomBytes } from "crypto";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export function openaiError(
  c: Context,
  status: number,
  type: string,
  message: string,
  param?: string | null,
  code?: string | null
) {
  return c.json(
    {
      error: {
        type,
        message,
        param: param ?? null,
        code: code ?? null,
      },
    },
    status as ContentfulStatusCode
  );
}

export function openaiId(prefix: string): string {
  return `${prefix}-${randomBytes(12).toString("base64url").slice(0, 24)}`;
}

export function openaiList<T>(data: T[], object = "list"): { object: string; data: T[] } {
  return { object, data };
}

export function deterministicEmbedding(input: string, dimensions = 1536): number[] {
  const hash = createHash("sha256").update(input).digest();
  const floats: number[] = [];
  for (let i = 0; i < dimensions; i++) {
    const byteIndex = i % hash.length;
    const value = (hash[byteIndex] + i) % 256;
    floats.push((value / 128) - 1);
  }
  return floats;
}
