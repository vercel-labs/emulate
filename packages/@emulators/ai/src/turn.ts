import { AiRequestError } from "./errors.js";
import type { AIRequest, FilePart, InputPart, Message, ToolDefinition } from "./types.js";

type TextPart = Extract<InputPart, { type: "text" }>;
type ToolResult = Extract<InputPart, { type: "tool_result" }>;

/** What one request asks the model to answer. */
export interface Turn {
  /** Text of the latest user message, excluding tool results. */
  text: string;
  /** Attachments on the latest user message and inside the tool results sent since the last assistant message. */
  files: FilePart[];
  /** Tool results sent since the last assistant message. */
  toolResults: ToolResult[];
  /** The tool result the request ends on, set only when no user message follows it. */
  pendingResult?: ToolResult;
  /** The tool a forced tool choice resolves to. */
  forcedTool?: ToolDefinition;
}

/**
 * Derives the turn a request asks to be answered, so rule matching and defaults read the same text, files, and tool results.
 * Throws the client error for a tool choice that forces a tool the request never declared.
 */
export function currentTurn(request: AIRequest): Turn {
  const { messages, tools, toolChoice } = request;
  const roles = messages.map((message) => message.role);
  const user: Message | undefined = messages[roles.lastIndexOf("user")];
  const continuation = messages.slice(roles.lastIndexOf("assistant") + 1);
  const attached = [...(user ? [user] : []), ...continuation.filter((message) => message.role === "tool")];
  const pendingResult = messages.at(-1)?.parts.filter(isToolResult).at(-1);
  const forcedTool =
    typeof toolChoice === "object"
      ? tools.find((tool) => tool.name === toolChoice.name)
      : toolChoice === "required"
        ? tools[0]
        : undefined;
  if (!forcedTool && toolChoice !== "auto" && toolChoice !== "none") {
    throw new AiRequestError("Forced tool choice requires a declared tool.", "tool_choice");
  }
  return {
    text: (user?.parts ?? [])
      .filter(isText)
      .map((part) => part.text)
      .join(""),
    files: attached.flatMap((message) => message.parts.filter(isFile)),
    toolResults: continuation.flatMap((message) => message.parts.filter(isToolResult)),
    ...(pendingResult ? { pendingResult } : {}),
    ...(forcedTool ? { forcedTool } : {}),
  };
}

function isText(part: InputPart): part is TextPart {
  return part.type === "text";
}

function isFile(part: InputPart): part is FilePart {
  return part.type === "file";
}

function isToolResult(part: InputPart): part is ToolResult {
  return part.type === "tool_result";
}
