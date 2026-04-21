import type { Hono } from "hono";
import type { ServicePlugin, Store, WebhookDispatcher, TokenMap, AppEnv, RouteContext } from "@emulators/core";
import { getTelegramStore } from "./store.js";
import { botApiRoutes } from "./routes/bot-api.js";
import { controlRoutes, createBot, createUser, createPrivateChat, createGroupChat } from "./routes/control.js";
import { inspectorRoutes } from "./routes/inspector.js";

export { getTelegramStore, type TelegramStore } from "./store.js";
export * from "./entities.js";
export type {
  CreateBotInput,
  CreateUserInput,
  CreatePrivateChatInput,
  CreateGroupChatInput,
  SimulateUserMessageInput,
  SimulateUserPhotoInput,
  SimulateCallbackInput,
} from "./routes/control.js";
export {
  simulateUserMessage,
  simulateUserPhoto,
  simulateUserMedia,
  simulateCallback,
  simulateEditedUserMessage,
  simulateReaction,
  simulateChannelPost,
  createSupergroup,
  createChannel,
  createForumTopic,
  addBotToChat,
  removeBotFromChat,
  injectFault,
  clearFaults,
  getCallbackAnswer,
  getDraftHistory,
  getSentMessages,
  getAllMessages,
} from "./routes/control.js";
export { getDispatcher, TelegramDispatcher } from "./dispatcher.js";

export interface TelegramBotSeed {
  username: string;
  name?: string;
  first_name?: string;
  token?: string;
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
  commands?: Array<{ command: string; description: string }>;
}

export interface TelegramUserSeed {
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChatSeed {
  type: "private" | "group";
  title?: string;
  between?: [string, string]; // [bot_username, user_username] for private
  members?: string[]; // user usernames for groups
  bots?: string[]; // bot usernames for groups
}

export interface TelegramSeedConfig {
  bots?: TelegramBotSeed[];
  users?: TelegramUserSeed[];
  chats?: TelegramChatSeed[];
}

export function seedDefaults(store: Store): void {
  const ts = getTelegramStore(store);
  // Only seed defaults if nothing is present.
  if (ts.bots.all().length > 0) return;

  const bot = createBot(store, {
    username: "emulate_bot",
    name: "Emulate Bot",
    token: "100001:EMULATE_DEFAULT_TOKEN",
    commands: [{ command: "start", description: "Start the bot" }],
  });
  const user = createUser(store, { first_name: "Tester", username: "tester" });
  createPrivateChat(store, { botId: bot.bot_id, userId: user.user_id });
}

export function seedFromConfig(store: Store, _baseUrl: string, config: TelegramSeedConfig): void {
  const ts = getTelegramStore(store);

  if (config.bots) {
    for (const b of config.bots) {
      const existing = ts.bots.findOneBy("username", b.username);
      if (existing) continue;
      createBot(store, {
        username: b.username,
        name: b.name ?? b.first_name,
        first_name: b.first_name,
        token: b.token,
        can_join_groups: b.can_join_groups,
        can_read_all_group_messages: b.can_read_all_group_messages,
        commands: b.commands,
      });
    }
  }

  if (config.users) {
    for (const u of config.users) {
      if (u.username && ts.users.findOneBy("username", u.username)) continue;
      createUser(store, u);
    }
  }

  if (config.chats) {
    for (const ch of config.chats) {
      if (ch.type === "private" && ch.between) {
        const [botUsername, userUsername] = ch.between;
        const bot = ts.bots.findOneBy("username", botUsername);
        const user = ts.users.findOneBy("username", userUsername);
        if (!bot || !user) continue;
        createPrivateChat(store, { botId: bot.bot_id, userId: user.user_id });
      } else if (ch.type === "group") {
        const botIds = (ch.bots ?? [])
          .map((u) => ts.bots.findOneBy("username", u)?.bot_id)
          .filter((v): v is number => v !== undefined);
        const memberIds = (ch.members ?? [])
          .map((u) => ts.users.findOneBy("username", u)?.user_id)
          .filter((v): v is number => v !== undefined);
        createGroupChat(store, { title: ch.title ?? "Group", memberIds, botIds });
      }
    }
  }
}

export const telegramPlugin: ServicePlugin = {
  name: "telegram",
  register(
    app: Hono<AppEnv>,
    store: Store,
    webhooks: WebhookDispatcher,
    baseUrl: string,
    tokenMap?: TokenMap,
  ): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    // Specific routes first so they win over the catchall in bot-api.
    controlRoutes(ctx);
    inspectorRoutes(ctx);
    botApiRoutes(ctx);
  },
  seed(store: Store): void {
    seedDefaults(store);
  },
};

export default telegramPlugin;
