import { ATTACHMENTS, TOOL, TOOL_OUTPUT, type Scenario } from "./scenarios";

export type Json = Record<string, unknown>;

export type Part = {
  kind: "text" | "reasoning" | "refusal" | "tool" | "finish";
  key?: number;
  id?: string;
  name?: string;
  text: string;
  signature?: string;
};

export type ToolCall = { id: string; name?: string; text: string };

export type RequestInput = {
  prompt: string;
  stream: boolean;
  schema?: Json;
  scenario: Scenario;
  attachment?: string;
  calls?: ToolCall[] | null;
  thoughts?: Part[];
};

type ChatCall = { index: number; id?: string; function?: { name?: string; arguments?: string } };
type ChatChoice = {
  delta?: { content?: string | null; refusal?: string | null; tool_calls?: ChatCall[] };
  message?: { content?: string | null; refusal?: string | null; tool_calls?: ChatCall[] };
  finish_reason?: string | null;
};
type ChatBody = { choices?: ChatChoice[] };

type ResponsesItem = {
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  summary?: { text?: string }[];
  content?: { type?: string; text?: string; refusal?: string }[];
};
type ResponsesEvent = {
  type?: string;
  delta?: string;
  output_index?: number;
  item?: ResponsesItem;
  response?: { status?: string; incomplete_details?: { reason?: string } | null };
  output?: ResponsesItem[];
  incomplete_details?: { reason?: string } | null;
  status?: string;
};

type MessagesBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: unknown;
};
type MessagesEvent = {
  type?: string;
  index?: number;
  content_block?: MessagesBlock;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  content?: MessagesBlock[];
  stop_reason?: string | null;
};

type Protocol = {
  path: string;
  body(input: RequestInput): Json;
  read(json: Json): Part[];
  parse(json: Json): Part[];
};

const dataUrl = (file: { mediaType: string; data: string }) => `data:${file.mediaType};base64,${file.data}`;

const chat: Protocol = {
  path: "/v1/chat/completions",
  body({ prompt, stream, schema, scenario, calls, attachment }) {
    const file = attachment ? ATTACHMENTS[attachment] : undefined;
    const content = file
      ? [
          { type: "text", text: prompt },
          file.mediaType === "application/pdf"
            ? { type: "file", file: { filename: file.name, file_data: dataUrl(file) } }
            : { type: "image_url", image_url: { url: dataUrl(file) } },
        ]
      : prompt;
    const messages: Json[] = [{ role: "user", content }];
    if (calls) {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.text },
        })),
      });
      for (const call of calls) messages.push({ role: "tool", tool_call_id: call.id, content: TOOL_OUTPUT });
    }
    return {
      model: "gpt-4o-mini",
      messages,
      stream,
      ...(schema
        ? { response_format: { type: "json_schema", json_schema: { name: "output", strict: true, schema } } }
        : {}),
      ...(scenario.tools ? { tools: [{ type: "function", function: TOOL }] } : {}),
    };
  },
  read(json) {
    const event = json as unknown as ChatBody;
    const choice = event.choices?.[0];
    if (!choice) return [];
    const delta = choice.delta ?? {};
    return [
      ...(delta.content ? [{ kind: "text" as const, text: delta.content }] : []),
      ...(delta.refusal ? [{ kind: "refusal" as const, text: delta.refusal }] : []),
      ...(delta.tool_calls ?? []).map((call) => ({
        kind: "tool" as const,
        key: call.index,
        id: call.id,
        name: call.function?.name,
        text: call.function?.arguments ?? "",
      })),
      ...(choice.finish_reason ? [{ kind: "finish" as const, text: choice.finish_reason }] : []),
    ];
  },
  parse(json) {
    const event = json as unknown as ChatBody;
    const choice = event.choices?.[0] ?? {};
    const message = choice.message ?? {};
    return [
      ...(message.content ? [{ kind: "text" as const, text: message.content }] : []),
      ...(message.refusal ? [{ kind: "refusal" as const, text: message.refusal }] : []),
      ...(message.tool_calls ?? []).map((call, key) => ({
        kind: "tool" as const,
        key,
        id: call.id,
        name: call.function?.name,
        text: call.function?.arguments ?? "",
      })),
      { kind: "finish" as const, text: choice.finish_reason ?? "" },
    ];
  },
};

const responses: Protocol = {
  path: "/v1/responses",
  body({ prompt, stream, schema, scenario, calls, attachment }) {
    const file = attachment ? ATTACHMENTS[attachment] : undefined;
    const content = file
      ? [
          { type: "input_text", text: prompt },
          file.mediaType === "application/pdf"
            ? { type: "input_file", filename: file.name, file_data: dataUrl(file) }
            : { type: "input_image", image_url: dataUrl(file) },
        ]
      : undefined;
    const input = calls
      ? [
          { role: "user", content: content ?? prompt },
          ...calls.map((call) => ({ type: "function_call", call_id: call.id, name: call.name, arguments: call.text })),
          ...calls.map((call) => ({ type: "function_call_output", call_id: call.id, output: TOOL_OUTPUT })),
        ]
      : file
        ? [{ role: "user", content }]
        : prompt;
    return {
      model: "gpt-5",
      input,
      stream,
      ...(schema ? { text: { format: { type: "json_schema", name: "output", strict: true, schema } } } : {}),
      ...(scenario.tools ? { tools: [{ type: "function", ...TOOL }] } : {}),
    };
  },
  read(json) {
    const event = json as unknown as ResponsesEvent;
    switch (event.type) {
      case "response.output_text.delta":
        return [{ kind: "text", text: event.delta ?? "" }];
      case "response.refusal.delta":
        return [{ kind: "refusal", text: event.delta ?? "" }];
      case "response.reasoning_summary_text.delta":
        return [{ kind: "reasoning", text: event.delta ?? "" }];
      case "response.function_call_arguments.delta":
        return [{ kind: "tool", key: event.output_index, text: event.delta ?? "" }];
      case "response.output_item.added":
        return event.item?.type === "function_call"
          ? [{ kind: "tool", key: event.output_index, id: event.item.call_id, name: event.item.name, text: "" }]
          : [];
      case "response.completed":
        return [{ kind: "finish", text: "completed" }];
      case "response.incomplete":
        return [{ kind: "finish", text: event.response?.incomplete_details?.reason ?? "incomplete" }];
      default:
        return [];
    }
  },
  parse(json) {
    const event = json as unknown as ResponsesEvent;
    const parts: Part[] = [];
    for (const [key, item] of (event.output ?? []).entries()) {
      if (item.type === "reasoning") {
        for (const part of item.summary ?? []) parts.push({ kind: "reasoning", text: part.text ?? "" });
      }
      if (item.type === "function_call") {
        parts.push({ kind: "tool", key, id: item.call_id, name: item.name, text: item.arguments ?? "" });
      }
      if (item.type === "message") {
        for (const part of item.content ?? []) {
          parts.push(
            part.type === "refusal"
              ? { kind: "refusal", text: part.refusal ?? "" }
              : { kind: "text", text: part.text ?? "" },
          );
        }
      }
    }
    return [...parts, { kind: "finish", text: event.incomplete_details?.reason ?? event.status ?? "" }];
  },
};

const messages: Protocol = {
  path: "/v1/messages",
  body({ prompt, stream, schema, scenario, calls, thoughts, attachment }) {
    const file = attachment ? ATTACHMENTS[attachment] : undefined;
    const content = file
      ? [
          { type: "text", text: prompt },
          file.mediaType === "application/pdf"
            ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: file.data } }
            : { type: "image", source: { type: "base64", media_type: "image/png", data: file.data } },
        ]
      : prompt;
    const list: Json[] = [{ role: "user", content }];
    if (calls) {
      list.push({
        role: "assistant",
        content: [
          ...(thoughts ?? []).map((thought) => ({
            type: "thinking",
            thinking: thought.text,
            signature: thought.signature,
          })),
          ...calls.map((call) => ({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: JSON.parse(call.text || "{}"),
          })),
        ],
      });
      list.push({
        role: "user",
        content: calls.map((call) => ({ type: "tool_result", tool_use_id: call.id, content: TOOL_OUTPUT })),
      });
    }
    return {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      messages: list,
      stream,
      ...(schema ? { output_config: { format: { type: "json_schema", schema } } } : {}),
      ...(scenario.tools
        ? { tools: [{ name: TOOL.name, description: TOOL.description, input_schema: TOOL.parameters }] }
        : {}),
    };
  },
  read(json) {
    const event = json as unknown as MessagesEvent;
    if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
      return [
        {
          kind: "tool",
          key: event.index,
          id: event.content_block.id,
          name: event.content_block.name,
          text: "",
        },
      ];
    }
    const delta = event.delta;
    if (event.type === "content_block_delta" && delta?.type === "text_delta")
      return [{ kind: "text", text: delta.text ?? "" }];
    if (event.type === "content_block_delta" && delta?.type === "thinking_delta") {
      return [{ kind: "reasoning", text: delta.thinking ?? "" }];
    }
    if (event.type === "content_block_delta" && delta?.type === "signature_delta") {
      return [{ kind: "reasoning", text: "", signature: delta.signature }];
    }
    if (event.type === "content_block_delta" && delta?.type === "input_json_delta") {
      return [{ kind: "tool", key: event.index, text: delta.partial_json ?? "" }];
    }
    if (event.type === "message_delta" && delta?.stop_reason) return [{ kind: "finish", text: delta.stop_reason }];
    return [];
  },
  parse(json) {
    const event = json as unknown as MessagesEvent;
    const parts: Part[] = (event.content ?? []).map((block, key) => {
      if (block.type === "tool_use") {
        return { kind: "tool", key, id: block.id, name: block.name, text: JSON.stringify(block.input) };
      }
      if (block.type === "thinking")
        return { kind: "reasoning", text: block.thinking ?? "", signature: block.signature };
      return { kind: "text", text: block.text ?? "" };
    });
    return [...parts, { kind: "finish", text: event.stop_reason ?? "" }];
  },
};

export type ApiId = "chat" | "responses" | "messages";
export const PROTOCOLS: Record<ApiId, Protocol> = { chat, responses, messages };
