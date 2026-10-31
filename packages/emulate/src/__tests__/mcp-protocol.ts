import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

type JsonRpcId = number | string | null;

export type JsonRpcMessage = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

export function createJsonRpcStream(readable: Readable, writable: Writable) {
  const lines = createInterface({ input: readable, crlfDelay: Infinity });
  const waiting = new Map<
    JsonRpcId,
    { resolve: (message: JsonRpcMessage) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  let nextId = 0;
  let closed: Error | undefined;

  function fail(error: Error) {
    if (closed) return;
    closed = error;
    for (const [id, request] of waiting) {
      clearTimeout(request.timer);
      request.reject(error);
      waiting.delete(id);
    }
  }

  lines.on("line", (line) => {
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value) || !("id" in value))
        throw new Error("Invalid JSON-RPC response");
      const response = value as JsonRpcMessage;
      const request = waiting.get(response.id!);
      if (!request) throw new Error(`Unexpected JSON-RPC response ${response.id}`);
      clearTimeout(request.timer);
      waiting.delete(response.id!);
      request.resolve(response);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
  lines.on("close", () => fail(new Error("JSON-RPC stream closed")));
  readable.on("error", fail);

  function response(id: JsonRpcId) {
    if (closed) return Promise.reject(closed);
    if (waiting.has(id)) return Promise.reject(new Error(`Already waiting for JSON-RPC response ${id}`));
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`Timed out waiting for JSON-RPC response ${id}`));
      }, 15000);
      waiting.set(id, { resolve, reject, timer });
    });
  }

  function write(message: JsonRpcMessage) {
    writable.write(`${JSON.stringify(message)}\n`);
  }

  function requestMessage(message: JsonRpcMessage, firstChunk?: string) {
    if (message.id === undefined) throw new Error("JSON-RPC request requires an id");
    const pending = response(message.id);
    writable.write(firstChunk ?? `${JSON.stringify(message)}\n`);
    return pending;
  }

  return {
    request(method: string, params?: unknown) {
      const id = ++nextId;
      const pending = response(id);
      write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
      return pending;
    },
    requestMessage,
    response,
    notification(method: string, params?: unknown) {
      write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
    },
    writeRaw(value: string) {
      writable.write(value);
    },
    close() {
      lines.close();
    },
  };
}
