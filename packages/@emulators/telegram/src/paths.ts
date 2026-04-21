// Shared control-plane URL builders. Every place that constructs a
// `/_emu/telegram/*` string — both sides of the control plane (server
// routes in control.ts, typed client in test.ts) — goes through here.

export const TELEGRAM_CONTROL_PREFIX = "/_emu/telegram";

export const telegramPaths = {
  reset: () => `${TELEGRAM_CONTROL_PREFIX}/reset`,
  bots: () => `${TELEGRAM_CONTROL_PREFIX}/bots`,
  users: () => `${TELEGRAM_CONTROL_PREFIX}/users`,
  faults: () => `${TELEGRAM_CONTROL_PREFIX}/faults`,
  callbackById: (id: string | number) =>
    `${TELEGRAM_CONTROL_PREFIX}/callbacks/${id}`,

  privateChat: () => `${TELEGRAM_CONTROL_PREFIX}/chats/private`,
  groupChat: () => `${TELEGRAM_CONTROL_PREFIX}/chats/group`,
  supergroup: () => `${TELEGRAM_CONTROL_PREFIX}/chats/supergroup`,
  channel: () => `${TELEGRAM_CONTROL_PREFIX}/chats/channel`,

  chatMessages: (chatId: number | string) =>
    `${TELEGRAM_CONTROL_PREFIX}/chats/${chatId}/messages`,
  chatPhotos: (chatId: number | string) =>
    `${TELEGRAM_CONTROL_PREFIX}/chats/${chatId}/photos`,
  chatMedia: (chatId: number | string) =>
    `${TELEGRAM_CONTROL_PREFIX}/chats/${chatId}/media`,
  chatCallbacks: (chatId: number | string) =>
    `${TELEGRAM_CONTROL_PREFIX}/chats/${chatId}/callbacks`,
  chatEdits: (chatId: number | string) =>
    `${TELEGRAM_CONTROL_PREFIX}/chats/${chatId}/edits`,
  chatAddBot: (chatId: number | string) =>
    `${TELEGRAM_CONTROL_PREFIX}/chats/${chatId}/add-bot`,
  chatRemoveBot: (chatId: number | string) =>
    `${TELEGRAM_CONTROL_PREFIX}/chats/${chatId}/remove-bot`,
  chatPromote: (chatId: number | string) =>
    `${TELEGRAM_CONTROL_PREFIX}/chats/${chatId}/promote`,
  chatReactions: (chatId: number | string) =>
    `${TELEGRAM_CONTROL_PREFIX}/chats/${chatId}/reactions`,
  chatTopics: (chatId: number | string) =>
    `${TELEGRAM_CONTROL_PREFIX}/chats/${chatId}/topics`,
  channelPosts: (chatId: number | string) =>
    `${TELEGRAM_CONTROL_PREFIX}/chats/${chatId}/channel-posts`,
  channelPostEdits: (chatId: number | string) =>
    `${TELEGRAM_CONTROL_PREFIX}/chats/${chatId}/channel-post-edits`,
  chatDraft: (chatId: number | string, draftId: number | string) =>
    `${TELEGRAM_CONTROL_PREFIX}/chats/${chatId}/drafts/${draftId}`,
} as const;
