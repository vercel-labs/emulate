import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeChatAttachment, decodeResponsesAttachment } from "../attachments.js";
import { AiRequestError } from "../errors.js";

const BASE64 = Buffer.from("hello").toString("base64");

function digest(value: string): string {
  return createHash("sha256").update(Buffer.from(value, "base64")).digest("hex");
}

function thrown(run: () => unknown): AiRequestError {
  try {
    run();
  } catch (error) {
    if (error instanceof AiRequestError) return error;
    throw error;
  }
  throw new Error("expected an AiRequestError");
}

describe("inline attachments", () => {
  it("records size and sha256 without the bytes", () => {
    const result = decodeChatAttachment(
      { type: "image_url", image_url: { url: `data:image/png;base64,${BASE64}` } },
      "content[0]",
    );
    expect(result).toEqual({
      type: "file",
      mediaType: "image/png",
      source: "inline",
      bytes: 5,
      sha256: digest(BASE64),
    });
    expect(JSON.stringify(result)).not.toContain(BASE64);
  });

  it("infers the media type from a filename", () => {
    const result = decodeResponsesAttachment(
      { type: "input_file", filename: "notes.txt", file_data: BASE64 },
      "input[0]",
    );
    expect(result).toMatchObject({ type: "file", mediaType: "text/plain", name: "notes.txt", source: "inline" });
  });

  it("falls back to application/octet-stream without a filename", () => {
    expect(decodeResponsesAttachment({ type: "input_file", file_id: "file_123" }, "input[0]")).toEqual({
      type: "file",
      mediaType: "application/octet-stream",
      source: "file_id",
      ref: "file_123",
    });
  });

  it("rejects malformed base64", () => {
    const error = thrown(() =>
      decodeChatAttachment({ type: "image_url", image_url: { url: "data:image/png;base64,!!!!" } }, "content[0]"),
    );
    expect(error.message).toBe("Malformed base64 data.");
    expect(error.param).toBe("content[0].image_url.url");
    expect(error.code).toBe("invalid_attachment");
  });

  it("rejects bad padding", () => {
    const error = thrown(() =>
      decodeChatAttachment({ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8==" } }, "content[0]"),
    );
    expect(error.message).toBe("Malformed base64 data.");
  });

  it("rejects an encoding that does not round-trip", () => {
    const error = thrown(() =>
      decodeChatAttachment({ type: "image_url", image_url: { url: "data:image/png;base64,Zh==" } }, "content[0]"),
    );
    expect(error.message).toBe("Malformed base64 data.");
  });

  it("rejects inline data above the size limit", () => {
    const oversized = "A".repeat(66_666_671);
    const error = thrown(() => decodeResponsesAttachment({ type: "input_file", file_data: oversized }, "input[0]"));
    expect(error.message).toBe("Inline attachment exceeds the size limit.");
    expect(error.param).toBe("input[0].file_data");
  });

  it("rejects an image media type outside the allowed set", () => {
    const error = thrown(() =>
      decodeChatAttachment({ type: "image_url", image_url: { url: `data:text/plain;base64,${BASE64}` } }, "content[0]"),
    );
    expect(error.message).toBe("Unsupported image media type.");
  });
});

describe("URL attachments", () => {
  it("requires HTTPS", () => {
    const error = thrown(() =>
      decodeChatAttachment({ type: "image_url", image_url: { url: "http://example.com/cat.png" } }, "content[0]"),
    );
    expect(error.message).toBe("Expected an HTTPS URL.");
    expect(error.param).toBe("content[0].image_url.url");
  });

  it("strips credentials, query, and hash", () => {
    const result = decodeChatAttachment(
      { type: "image_url", image_url: { url: "https://user:pass@example.com/cat.png?sig=secret#frag" } },
      "content[0]",
    );
    expect(result).toEqual({
      type: "file",
      mediaType: "image/png",
      source: "url",
      ref: "https://example.com/cat.png",
    });
  });
});

describe("file id attachments", () => {
  it("decodes a Responses file id with its inferred media type", () => {
    expect(
      decodeResponsesAttachment({ type: "input_file", filename: "report.pdf", file_id: "file_abc" }, "input[0]"),
    ).toEqual({
      type: "file",
      mediaType: "application/pdf",
      name: "report.pdf",
      source: "file_id",
      ref: "file_abc",
    });
  });

  it("decodes a Responses image file id as an image", () => {
    expect(decodeResponsesAttachment({ type: "input_image", file_id: "file_img" }, "input[0]")).toEqual({
      type: "file",
      mediaType: "image/*",
      source: "file_id",
      ref: "file_img",
    });
  });

  it("decodes a Chat PDF file id", () => {
    expect(
      decodeChatAttachment({ type: "file", file: { filename: "report.pdf", file_id: "file_pdf" } }, "content[0]"),
    ).toEqual({
      type: "file",
      mediaType: "application/pdf",
      name: "report.pdf",
      source: "file_id",
      ref: "file_pdf",
    });
  });
});

describe("source counts", () => {
  it("requires exactly one Responses file source", () => {
    const error = thrown(() =>
      decodeResponsesAttachment({ type: "input_file", file_data: BASE64, file_id: "file_x" }, "input[0]"),
    );
    expect(error.message).toBe("Provide exactly one of file_data, file_id, or file_url.");
    expect(error.param).toBe("input[0]");
  });

  it("requires exactly one Responses image source", () => {
    const error = thrown(() => decodeResponsesAttachment({ type: "input_image" }, "input[0]"));
    expect(error.message).toBe("Provide exactly one of image_url or file_id.");
  });

  it("requires exactly one Chat file source", () => {
    const error = thrown(() =>
      decodeChatAttachment({ type: "file", file: { file_data: BASE64, file_id: "file_x" } }, "content[0]"),
    );
    expect(error.message).toBe("Provide exactly one of file_data or file_id.");
  });
});

describe("non-attachment parts", () => {
  it("returns null", () => {
    expect(decodeChatAttachment({ type: "text", text: "hi" }, "content[0]")).toBeNull();
    expect(decodeResponsesAttachment({ type: "input_text", text: "hi" }, "input[0]")).toBeNull();
    expect(decodeChatAttachment("nope", "content[0]")).toBeNull();
    expect(decodeResponsesAttachment(null, "input[0]")).toBeNull();
  });
});
