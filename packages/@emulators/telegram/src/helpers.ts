// Barrel re-export for backwards compatibility. The canonical homes are:
//   - ids.ts              — counters, tokens, file/update/callback IDs
//   - http.ts             — ok / okRaw / tgError / parseTelegramBody
//   - serializers.ts      — serializeUser/Bot/Chat/Message/ChatFullInfo + resolveBotFromToken
//   - entity-parser.ts    — parseEntities (bot_command/mention/url/email/hashtag/cashtag)
//   - services/media.ts   — buildPhotoSizes / readImageDimensions / buildMediaField

export {
  generateBotToken,
  generateCallbackQueryId,
  nextBotId,
  nextChannelChatId,
  nextFileId,
  nextGroupChatId,
  nextSupergroupChatId,
  nextUpdateId,
  nextUserId,
  parseBotIdFromToken,
} from "./ids.js";

export { ok, okRaw, parseTelegramBody, tgError } from "./http.js";

export {
  resolveBotFromToken,
  serializeBotAsUser,
  serializeChat,
  serializeChatFullInfo,
  serializeMessage,
  serializeUser,
} from "./serializers.js";

export { parseEntities } from "./entity-parser.js";

export { buildPhotoSizes, readImageDimensions } from "./services/media.js";
