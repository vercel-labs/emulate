import { streamSSE } from "hono/streaming";
import type { RouteContext } from "@emulators/core";
import { parseJsonBody } from "@emulators/core";
import { openaiError, openaiId } from "../helpers.js";
import type { OpenAICompletionConfig } from "../entities.js";

function matchCompletion(
  userMessage: string,
  configs: OpenAICompletionConfig[]
): OpenAICompletionConfig | null {
  for (const config of configs) {
    try {
      const regex = new RegExp(config.pattern, "i");
      if (regex.test(userMessage)) {
        return config;
      }
    } catch {
      if (userMessage.includes(config.pattern)) {
        return config;
      }
    }
  }
  return null;
}

function getLastUserMessage(messages: Array<{ role: string; content?: string }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && typeof messages[i].content === "string") {
      return messages[i].content!;
    }
  }
  return "";
}

export function chatCompletionRoutes({ app, store }: RouteContext): void {
  app.post("/v1/chat/completions", async (c) => {
    const body = await parseJsonBody(c);
    const model = typeof body.model === "string" ? body.model : "gpt-4o";
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const stream = body.stream === true;

    const configs = store.getData<OpenAICompletionConfig[]>("openai.completions") ?? [];
    const userMessage = getLastUserMessage(messages as Array<{ role: string; content?: string }>);
    const matched = matchCompletion(userMessage, configs);

    const responseContent = matched?.content ?? "This is a mock response from the emulated OpenAI API.";
    const toolCalls = matched?.tool_calls ?? null;
    const completionId = openaiId("chatcmpl");
    const created = Math.floor(Date.now() / 1000);

    if (stream) {
      return streamSSE(c, async (sseStream) => {
        const baseChunk = {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
        };

        await sseStream.writeSSE({
          data: JSON.stringify({
            ...baseChunk,
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
          }),
        });

        if (toolCalls) {
          for (const tc of toolCalls) {
            await sseStream.writeSSE({
              data: JSON.stringify({
                ...baseChunk,
                choices: [{
                  index: 0,
                  delta: {
                    tool_calls: [{
                      index: 0,
                      id: tc.id,
                      type: tc.type,
                      function: tc.function,
                    }],
                  },
                  finish_reason: null,
                }],
              }),
            });
          }
          await sseStream.writeSSE({
            data: JSON.stringify({
              ...baseChunk,
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            }),
          });
        } else {
          const words = responseContent.split(/\s+/);
          for (let i = 0; i < words.length; i++) {
            const content = i === 0 ? words[i] : ` ${words[i]}`;
            await sseStream.writeSSE({
              data: JSON.stringify({
                ...baseChunk,
                choices: [{ index: 0, delta: { content }, finish_reason: null }],
              }),
            });
          }
          await sseStream.writeSSE({
            data: JSON.stringify({
              ...baseChunk,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            }),
          });
        }

        await sseStream.writeSSE({ data: "[DONE]" });
      });
    }

    const finishReason = toolCalls ? "tool_calls" : "stop";
    const message: Record<string, unknown> = { role: "assistant" };
    if (toolCalls) {
      message.content = null;
      message.tool_calls = toolCalls;
    } else {
      message.content = responseContent;
    }

    const promptTokens = messages.reduce((acc: number, m: Record<string, unknown>) => {
      return acc + (typeof m.content === "string" ? m.content.split(/\s+/).length : 0);
    }, 0);
    const completionTokens = responseContent.split(/\s+/).length;

    return c.json({
      id: completionId,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    });
  });
}
