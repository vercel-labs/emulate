import { createHash } from "node:crypto";

/** A seeded board's ID, stable across restarts: its team and its name, whatever the case. */
export function stableBoardId(teamId: string, name: string): string {
  const digest = createHash("sha256")
    .update(`board:${teamId}:${name.trim().normalize("NFC").toLowerCase()}`)
    .digest("base64url")
    .slice(0, 20);
  return `brd_${digest}`;
}
