import { randomBytes } from "crypto";
import type { Context } from "hono";

export function generateObjectId(): string {
  const timestamp = Math.floor(Date.now() / 1000).toString(16).padStart(8, "0");
  const random = randomBytes(8).toString("hex").slice(0, 16);
  return (timestamp + random).slice(0, 24);
}

export function generateClusterId(): string {
  return randomBytes(12).toString("hex");
}

export function generateGroupId(): string {
  return randomBytes(12).toString("hex");
}

export function generateUserId(): string {
  return randomBytes(12).toString("hex");
}

export function mongoOk<T extends Record<string, unknown>>(c: Context, data: T, status = 200) {
  return c.json(data, status as 200);
}

export function mongoError(c: Context, errorCode: string, detail: string, status = 400) {
  return c.json({ error: status, errorCode, detail }, status as 400);
}
