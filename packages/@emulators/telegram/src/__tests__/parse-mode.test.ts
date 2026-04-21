import { describe, it, expect } from "vitest";
import { parseMarkdownV2, MarkdownParseError } from "../markdown.js";
import { parseHtml, HtmlParseError } from "../html.js";

describe("MarkdownV2 parser", () => {
  it("extracts bold with a single-asterisk pair", () => {
    const r = parseMarkdownV2("*hello*");
    expect(r.text).toBe("hello");
    expect(r.entities).toEqual([{ type: "bold", offset: 0, length: 5 }]);
  });

  it("extracts italic and bold together", () => {
    const r = parseMarkdownV2("*bold* and _italic_");
    expect(r.text).toBe("bold and italic");
    expect(r.entities).toContainEqual({ type: "bold", offset: 0, length: 4 });
    expect(r.entities).toContainEqual({ type: "italic", offset: 9, length: 6 });
  });

  it("handles underline via double underscore", () => {
    const r = parseMarkdownV2("__under__");
    expect(r.text).toBe("under");
    expect(r.entities).toEqual([{ type: "underline", offset: 0, length: 5 }]);
  });

  it("handles strikethrough", () => {
    const r = parseMarkdownV2("~gone~");
    expect(r.text).toBe("gone");
    expect(r.entities).toEqual([{ type: "strikethrough", offset: 0, length: 4 }]);
  });

  it("handles spoiler (double pipe)", () => {
    const r = parseMarkdownV2("||hush||");
    expect(r.text).toBe("hush");
    expect(r.entities).toEqual([{ type: "spoiler", offset: 0, length: 4 }]);
  });

  it("handles inline code", () => {
    const r = parseMarkdownV2("run `npm test` now");
    expect(r.text).toBe("run npm test now");
    expect(r.entities).toContainEqual({ type: "code", offset: 4, length: 8 });
  });

  it("handles pre block with language", () => {
    const r = parseMarkdownV2("```typescript\nconst x = 1;\n```");
    expect(r.text).toBe("const x = 1;\n");
    expect(r.entities[0].type).toBe("pre");
    expect(r.entities[0].language).toBe("typescript");
  });

  it("handles inline text_link", () => {
    const r = parseMarkdownV2("[hello](https://example.com)");
    expect(r.text).toBe("hello");
    expect(r.entities).toEqual([
      { type: "text_link", offset: 0, length: 5, url: "https://example.com" },
    ]);
  });

  it("handles text_mention via tg://user?id=N", () => {
    const r = parseMarkdownV2("[me](tg://user?id=42)");
    expect(r.text).toBe("me");
    expect(r.entities[0]).toMatchObject({ type: "text_mention", offset: 0, length: 2 });
    expect(r.entities[0].user?.id).toBe(42);
  });

  it("rejects unescaped reserved character (period)", () => {
    expect(() => parseMarkdownV2("hello.")).toThrowError(MarkdownParseError);
  });

  it("accepts escaped period", () => {
    const r = parseMarkdownV2("hello\\.");
    expect(r.text).toBe("hello.");
    expect(r.entities).toHaveLength(0);
  });

  it("rejects unclosed bold", () => {
    expect(() => parseMarkdownV2("*hello")).toThrowError(MarkdownParseError);
  });

  it("rejects unclosed inline code", () => {
    expect(() => parseMarkdownV2("run `npm test")).toThrowError(MarkdownParseError);
  });

  it("rejects malformed link", () => {
    expect(() => parseMarkdownV2("[hello](no-close")).toThrowError(MarkdownParseError);
  });

  it("rejects stray reserved char after escape", () => {
    // `\` at end is terminal, not a dangling escape.
    expect(() => parseMarkdownV2("foo\\")).toThrowError(MarkdownParseError);
  });

  it("rejects every reserved char unescaped (spot-check)", () => {
    for (const ch of [".", "-", "!", "#", "+", "=", "{", "}"]) {
      expect(() => parseMarkdownV2(`hello${ch}world`)).toThrowError(MarkdownParseError);
    }
  });
});

describe("HTML parser", () => {
  it("extracts bold", () => {
    const r = parseHtml("<b>hi</b>");
    expect(r.text).toBe("hi");
    expect(r.entities).toEqual([{ type: "bold", offset: 0, length: 2 }]);
  });

  it("accepts <strong> as bold alias", () => {
    const r = parseHtml("<strong>hi</strong>");
    expect(r.entities[0].type).toBe("bold");
  });

  it("extracts link with href", () => {
    const r = parseHtml('<a href="https://x.io">hello</a>');
    expect(r.text).toBe("hello");
    expect(r.entities).toEqual([
      { type: "text_link", offset: 0, length: 5, url: "https://x.io" },
    ]);
  });

  it("extracts text_mention from tg://user", () => {
    const r = parseHtml('<a href="tg://user?id=42">me</a>');
    expect(r.entities[0].type).toBe("text_mention");
    expect(r.entities[0].user?.id).toBe(42);
  });

  it("decodes HTML entities (&amp; &lt; &gt; &quot;)", () => {
    const r = parseHtml("A &amp; B &lt;3");
    expect(r.text).toBe("A & B <3");
  });

  it("handles tg-spoiler", () => {
    const r = parseHtml("<tg-spoiler>hush</tg-spoiler>");
    expect(r.entities[0].type).toBe("spoiler");
  });

  it("handles span.tg-spoiler", () => {
    const r = parseHtml('<span class="tg-spoiler">hush</span>');
    expect(r.entities[0].type).toBe("spoiler");
  });

  it("rejects unclosed tag", () => {
    expect(() => parseHtml("<b>hi")).toThrowError(HtmlParseError);
  });

  it("rejects mismatched closing tag", () => {
    expect(() => parseHtml("<b>hi</i>")).toThrowError(HtmlParseError);
  });

  it("rejects unsupported tag", () => {
    expect(() => parseHtml("<marquee>nope</marquee>")).toThrowError(HtmlParseError);
  });

  it("parses <blockquote>", () => {
    const r = parseHtml("<blockquote>quoted</blockquote>");
    expect(r.text).toBe("quoted");
    expect(r.entities).toEqual([{ type: "blockquote", offset: 0, length: 6 }]);
  });

  it("parses <blockquote expandable>", () => {
    const r = parseHtml("<blockquote expandable>long</blockquote>");
    expect(r.text).toBe("long");
    expect(r.entities).toEqual([{ type: "expandable_blockquote", offset: 0, length: 4 }]);
  });
});

describe("MarkdownV2 blockquote", () => {
  it("parses single-line > blockquote", () => {
    const r = parseMarkdownV2(">quoted");
    expect(r.text).toBe("quoted");
    expect(r.entities).toEqual([{ type: "blockquote", offset: 0, length: 6 }]);
  });

  it("parses multi-line > blockquote joined with newline", () => {
    const r = parseMarkdownV2(">line one\n>line two");
    expect(r.text).toBe("line one\nline two");
    expect(r.entities).toEqual([{ type: "blockquote", offset: 0, length: 17 }]);
  });

  it("parses expandable blockquote **>...||", () => {
    const r = parseMarkdownV2("**>line one\n>line two||");
    expect(r.text).toBe("line one\nline two");
    expect(r.entities).toEqual([{ type: "expandable_blockquote", offset: 0, length: 17 }]);
  });
});
