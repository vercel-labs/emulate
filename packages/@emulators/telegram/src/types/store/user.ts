import type { Entity } from "@emulators/core";

export interface TelegramUser extends Entity {
  user_id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}
