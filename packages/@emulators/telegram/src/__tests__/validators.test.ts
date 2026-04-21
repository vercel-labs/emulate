// Smoke tests for the zod validators. These are not exhaustive —
// detailed error-message assertions live in the integration tests — but
// they cover: (a) each schema accepts a realistic body, (b) the error
// normalisation (firstZodError) produces Bot API-style strings.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  zChatId,
  zSendMessageBody,
  zSendPhotoBody,
  zSendVideoBody,
  zAnswerCallbackQueryBody,
  zGetChatBody,
  zGetChatMemberBody,
  zCreateForumTopicBody,
  zGetUpdatesBody,
  zSetWebhookBody,
  zSetMessageReactionBody,
  zSetMyCommandsBody,
  zSendMessageDraftBody,
  zCreateBotInput,
  zInjectFaultInput,
  firstZodError,
} from "../types/validators/index.js";

describe("zChatId", () => {
  it("accepts a number", () => {
    expect(zChatId.parse(123)).toBe(123);
  });
  it("coerces a digit-string to number", () => {
    expect(zChatId.parse("-100123")).toBe(-100123);
  });
  it("rejects a non-numeric string", () => {
    expect(zChatId.safeParse("@channel").success).toBe(false);
  });
});

describe("zSendMessageBody", () => {
  it("accepts a minimal body", () => {
    const r = zSendMessageBody.parse({ chat_id: 1, text: "hi" });
    expect(r.chat_id).toBe(1);
    expect(r.text).toBe("hi");
  });
  it("accepts parse_mode + entities", () => {
    const r = zSendMessageBody.parse({
      chat_id: "1",
      text: "hi",
      parse_mode: "HTML",
      entities: [{ type: "bold", offset: 0, length: 2 }],
    });
    expect(r.parse_mode).toBe("HTML");
    expect(r.entities?.[0].type).toBe("bold");
  });
  it("accepts all four reply_markup variants", () => {
    expect(
      zSendMessageBody.parse({
        chat_id: 1,
        text: "x",
        reply_markup: { inline_keyboard: [[{ text: "ok", callback_data: "cb" }]] },
      }).reply_markup,
    ).toBeDefined();
    expect(
      zSendMessageBody.parse({
        chat_id: 1,
        text: "x",
        reply_markup: { keyboard: [[{ text: "a" }]] },
      }).reply_markup,
    ).toBeDefined();
    expect(
      zSendMessageBody.parse({
        chat_id: 1,
        text: "x",
        reply_markup: { force_reply: true },
      }).reply_markup,
    ).toBeDefined();
    expect(
      zSendMessageBody.parse({
        chat_id: 1,
        text: "x",
        reply_markup: { remove_keyboard: true },
      }).reply_markup,
    ).toBeDefined();
  });
});

describe("zSendPhotoBody / zSendVideoBody", () => {
  it("accepts string file_id", () => {
    expect(zSendPhotoBody.parse({ chat_id: 1, photo: "AgAD..." }).photo).toBe("AgAD...");
    expect(zSendVideoBody.parse({ chat_id: 1, video: "BAAD..." }).video).toBe("BAAD...");
  });
  it("accepts multipart file", () => {
    const mp = { __file: true, name: "a.jpg", type: "image/jpeg", bytes: Buffer.from("x") };
    const r = zSendPhotoBody.parse({ chat_id: 1, photo: mp });
    expect(typeof r.photo).not.toBe("string");
  });
});

describe("simple schemas", () => {
  it("zAnswerCallbackQueryBody", () => {
    expect(zAnswerCallbackQueryBody.parse({ callback_query_id: "abc" })).toEqual({
      callback_query_id: "abc",
    });
  });
  it("zGetChatBody / zGetChatMemberBody", () => {
    expect(zGetChatBody.parse({ chat_id: 1 }).chat_id).toBe(1);
    expect(zGetChatMemberBody.parse({ chat_id: 1, user_id: 2 }).user_id).toBe(2);
  });
  it("zCreateForumTopicBody requires name", () => {
    expect(zCreateForumTopicBody.parse({ chat_id: 1, name: "General" }).name).toBe("General");
    expect(zCreateForumTopicBody.safeParse({ chat_id: 1, name: "" }).success).toBe(false);
  });
  it("zGetUpdatesBody allows empty", () => {
    expect(zGetUpdatesBody.parse({})).toEqual({});
  });
  it("zSetWebhookBody allows empty", () => {
    expect(zSetWebhookBody.parse({})).toEqual({});
  });
  it("zSetMessageReactionBody accepts emoji + custom_emoji", () => {
    const r = zSetMessageReactionBody.parse({
      chat_id: 1,
      message_id: 2,
      reaction: [{ type: "emoji", emoji: "👍" }, { type: "custom_emoji", custom_emoji_id: "x" }],
    });
    expect(r.reaction?.length).toBe(2);
  });
  it("zSetMyCommandsBody", () => {
    expect(
      zSetMyCommandsBody.parse({ commands: [{ command: "start", description: "Start" }] })
        .commands[0].command,
    ).toBe("start");
  });
  it("zSendMessageDraftBody", () => {
    expect(
      zSendMessageDraftBody.parse({ chat_id: 1, draft_id: 10, text: "draft" }).draft_id,
    ).toBe(10);
  });
  it("zCreateBotInput / zInjectFaultInput", () => {
    expect(zCreateBotInput.parse({ username: "foo_bot" }).username).toBe("foo_bot");
    expect(
      zInjectFaultInput.parse({ bot_id: 1, method: "*", error_code: 429 }).error_code,
    ).toBe(429);
  });
});

describe("firstZodError", () => {
  const schema = z.object({ chat_id: z.number() });
  it("reports missing required field", () => {
    const r = schema.safeParse({});
    if (r.success) throw new Error("expected failure");
    expect(firstZodError(r.error)).toBe("Bad Request: chat_id is required");
  });
  it("reports invalid type", () => {
    const r = schema.safeParse({ chat_id: "nope" });
    if (r.success) throw new Error("expected failure");
    expect(firstZodError(r.error)).toBe("Bad Request: chat_id has invalid type");
  });
});
