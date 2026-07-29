import type { Entity } from "@emulators/core";

export interface TelegramBot extends Entity {
  bot_id: number;
  token: string;
  username: string;
  first_name: string;
  can_join_groups: boolean;
  can_read_all_group_messages: boolean;
  supports_inline_queries: boolean;
  webhook_url: string | null;
  webhook_secret: string | null;
  webhook_allowed_updates: string[] | null;
  commands: Array<{ command: string; description: string }>;
}
