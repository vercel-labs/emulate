import type { Entity } from "@emulators/core";

export interface TelegramFault extends Entity {
  bot_id: number;
  method: string; // "*" or specific method name
  error_code: number;
  description: string;
  retry_after: number | null;
  remaining: number;
}
