/** Browser Buffer: the `buffer` package plus base64url, which that package lacks. Load it before any emulator code runs. */
import { Buffer as NodeBuffer } from "buffer/index.js";

function fromBase64url(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
}

function toBase64url(base64: string): string {
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

if (!NodeBuffer.isEncoding("base64url")) {
  const nativeIsEncoding = NodeBuffer.isEncoding;
  const nativeFrom = NodeBuffer.from as unknown as (
    value: unknown,
    encodingOrOffset?: unknown,
    length?: number,
  ) => NodeBuffer;
  const nativeByteLength = NodeBuffer.byteLength;
  const nativeToString = NodeBuffer.prototype.toString;

  NodeBuffer.isEncoding = (encoding: string) => encoding.toLowerCase() === "base64url" || nativeIsEncoding(encoding);

  NodeBuffer.from = (value: unknown, encodingOrOffset?: unknown, length?: number) =>
    typeof value === "string" && encodingOrOffset === "base64url"
      ? nativeFrom(fromBase64url(value), "base64")
      : nativeFrom(value, encodingOrOffset, length);

  NodeBuffer.byteLength = (value: string, encoding?: string) =>
    encoding?.toLowerCase() === "base64url"
      ? nativeByteLength(fromBase64url(value), "base64")
      : nativeByteLength(value, encoding);

  NodeBuffer.prototype.toString = function toString(this: NodeBuffer, ...args: [string?, number?, number?]): string {
    if (args[0] !== "base64url") return nativeToString.apply(this, args);
    return toBase64url(nativeToString.call(this, "base64", args[1], args[2]));
  };
}

Object.assign(globalThis, { Buffer: globalThis.Buffer ?? NodeBuffer });

export { NodeBuffer as Buffer };
export default NodeBuffer;
