import type { MessageEntity } from "./entities.js";

/**
 * HTML parse_mode support — stripped-down parser that handles the tag set
 * Telegram's Bot API recognises. Minimal HTML entity decoding for the four
 * common names (`&amp; &lt; &gt; &quot;`).
 *
 * Rejects unclosed or mismatched tags with a 400-style "can't parse
 * entities" error.
 */
export interface ParsedHtml {
  text: string;
  entities: MessageEntity[];
}

export class HtmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HtmlParseError";
  }
}

type TagName = "b" | "i" | "u" | "s" | "code" | "pre" | "a" | "tg-spoiler" | "span";
type OpenTag = {
  name: TagName;
  entityType: MessageEntity["type"];
  startOffset: number;
  attrs?: Record<string, string>;
};

const TAG_TO_ENTITY: Record<string, MessageEntity["type"]> = {
  b: "bold",
  strong: "bold",
  i: "italic",
  em: "italic",
  u: "underline",
  ins: "underline",
  s: "strikethrough",
  strike: "strikethrough",
  del: "strikethrough",
  code: "code",
  pre: "pre",
  a: "text_link",
  "tg-spoiler": "spoiler",
  blockquote: "blockquote",
};

export function parseHtml(input: string): ParsedHtml {
  const out: string[] = [];
  const entities: MessageEntity[] = [];
  const stack: OpenTag[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (ch === "<") {
      const close = input.indexOf(">", i);
      if (close === -1) {
        throw new HtmlParseError("Bad Request: can't parse entities: unclosed tag");
      }
      const tagBody = input.slice(i + 1, close);
      if (tagBody.startsWith("/")) {
        // Closing tag
        const name = tagBody.slice(1).trim().toLowerCase();
        const open = stack.pop();
        if (!open || open.name !== name) {
          throw new HtmlParseError(
            `Bad Request: can't parse entities: mismatched closing tag </${name}>`,
          );
        }
        const endOffset = utf16Length(out.join(""));
        let entType = open.entityType;
        if (entType === "blockquote" && open.attrs && "expandable" in open.attrs) {
          entType = "expandable_blockquote";
        }
        const ent: MessageEntity = {
          type: entType,
          offset: open.startOffset,
          length: endOffset - open.startOffset,
        };
        if (open.entityType === "text_link") {
          const href = open.attrs?.href ?? "";
          if (href.startsWith("tg://user?id=")) {
            const uid = Number(href.slice("tg://user?id=".length));
            if (Number.isFinite(uid)) {
              entities.push({
                type: "text_mention",
                offset: ent.offset,
                length: ent.length,
                user: { id: uid, is_bot: false, first_name: "" },
              });
              i = close + 1;
              continue;
            }
          }
          ent.url = href;
        }
        entities.push(ent);
        i = close + 1;
        continue;
      }

      // Opening tag
      const { name, attrs, selfClose } = parseTagBody(tagBody);
      const normalized = name.toLowerCase();
      // Special: <span class="tg-spoiler">
      let entityName = normalized;
      if (normalized === "span" && (attrs.class ?? "").includes("tg-spoiler")) {
        entityName = "tg-spoiler";
      }
      const entType = TAG_TO_ENTITY[entityName];
      if (!entType) {
        throw new HtmlParseError(
          `Bad Request: can't parse entities: unsupported tag <${normalized}>`,
        );
      }
      if (selfClose) {
        // Self-closing with no content doesn't produce an entity.
        i = close + 1;
        continue;
      }
      const startOffset = utf16Length(out.join(""));
      // Track the actual tag name for close matching, not the normalized
      // entity name — <span class="tg-spoiler"> closes with </span>.
      stack.push({
        name: normalized as TagName,
        entityType: entType,
        startOffset,
        attrs,
      });
      i = close + 1;
      continue;
    }

    if (ch === "&") {
      const semi = input.indexOf(";", i);
      if (semi === -1) {
        throw new HtmlParseError("Bad Request: can't parse entities: stray '&' without terminator");
      }
      const ref = input.slice(i + 1, semi);
      const decoded = decodeHtmlEntity(ref);
      if (decoded === null) {
        throw new HtmlParseError(
          `Bad Request: can't parse entities: unknown HTML entity '&${ref};'`,
        );
      }
      out.push(decoded);
      i = semi + 1;
      continue;
    }

    out.push(ch);
    i += 1;
  }

  if (stack.length > 0) {
    throw new HtmlParseError(
      `Bad Request: can't parse entities: unclosed tag <${stack[stack.length - 1].name}>`,
    );
  }

  entities.sort((a, b) => (a.offset !== b.offset ? a.offset - b.offset : b.length - a.length));
  return { text: out.join(""), entities };
}

function parseTagBody(body: string): {
  name: string;
  attrs: Record<string, string>;
  selfClose: boolean;
} {
  let s = body.trim();
  let selfClose = false;
  if (s.endsWith("/")) {
    selfClose = true;
    s = s.slice(0, -1).trim();
  }
  const nameMatch = s.match(/^([A-Za-z][A-Za-z0-9-]*)/);
  const name = nameMatch ? nameMatch[1] : s;
  const rest = nameMatch ? s.slice(name.length).trim() : "";
  const attrs: Record<string, string> = {};
  // Attribute parser: key="value" / key='value' / key=value / bare key.
  const attrRe = /([A-Za-z_:][A-Za-z0-9_:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(rest)) !== null) {
    if (!m[0]) break;
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return { name, attrs, selfClose };
}

function decodeHtmlEntity(ref: string): string | null {
  switch (ref) {
    case "amp":
      return "&";
    case "lt":
      return "<";
    case "gt":
      return ">";
    case "quot":
      return '"';
    case "apos":
      return "'";
    default:
      if (ref.startsWith("#")) {
        const isHex = ref[1] === "x" || ref[1] === "X";
        const code = parseInt(ref.slice(isHex ? 2 : 1), isHex ? 16 : 10);
        if (!Number.isFinite(code)) return null;
        return String.fromCodePoint(code);
      }
      return null;
  }
}

function utf16Length(s: string): number {
  return s.length;
}
