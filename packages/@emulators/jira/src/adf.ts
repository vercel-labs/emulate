import { escapeHtml } from "@emulators/core";
import type { AdfNode } from "./entities.js";

export function isAdfDoc(value: unknown): value is AdfNode {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const doc = value as AdfNode;
  return doc.type === "doc" && doc.version === 1 && Array.isArray(doc.content);
}

/** Plain text (one paragraph per line) to an ADF document. */
export function textToAdf(text: string): AdfNode {
  return {
    type: "doc",
    version: 1,
    content: text.split("\n").map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : [],
    })),
  };
}

const TEXT_BLOCKS = new Set(["paragraph", "heading", "codeBlock"]);

function inlineText(node: AdfNode): string {
  switch (node.type) {
    case "text":
      return node.text ?? "";
    case "hardBreak":
      return "\n";
    case "mention":
    case "emoji":
      return String(node.attrs?.text ?? node.attrs?.shortName ?? node.attrs?.id ?? "");
    case "inlineCard":
      return String(node.attrs?.url ?? "");
    default:
      return (node.content ?? []).map(inlineText).join("");
  }
}

/** Flattens an ADF document to plain text, one line per paragraph, heading, or code block. */
export function adfToText(node: AdfNode | null | undefined): string {
  if (!node) return "";
  const lines: string[] = [];
  const walk = (current: AdfNode): void => {
    if (TEXT_BLOCKS.has(current.type)) lines.push(inlineText(current));
    else if (current.type === "text" || current.type === "hardBreak") lines.push(inlineText(current));
    else for (const child of current.content ?? []) walk(child);
  };
  walk(node);
  return lines.join("\n");
}

/** Minimal HTML rendering used for `renderedFields`. */
export function adfToHtml(node: AdfNode | null | undefined): string {
  if (!node) return "";
  const render = (current: AdfNode): string => {
    const children = (current.content ?? []).map(render).join("");
    switch (current.type) {
      case "doc":
        return children;
      case "paragraph":
        return `<p>${children}</p>`;
      case "heading": {
        const level = Math.min(6, Math.max(1, Number(current.attrs?.level ?? 1)));
        return `<h${level}>${children}</h${level}>`;
      }
      case "bulletList":
        return `<ul>${children}</ul>`;
      case "orderedList":
        return `<ol>${children}</ol>`;
      case "listItem":
        return `<li>${children}</li>`;
      case "codeBlock":
        return `<pre><code>${children}</code></pre>`;
      case "blockquote":
        return `<blockquote>${children}</blockquote>`;
      case "rule":
        return "<hr />";
      case "hardBreak":
        return "<br />";
      case "text": {
        let text = escapeHtml(current.text ?? "");
        for (const mark of current.marks ?? []) {
          if (mark.type === "strong") text = `<b>${text}</b>`;
          else if (mark.type === "em") text = `<em>${text}</em>`;
          else if (mark.type === "code") text = `<tt>${text}</tt>`;
          else if (mark.type === "link") text = `<a href="${escapeHtml(String(mark.attrs?.href ?? ""))}">${text}</a>`;
        }
        return text;
      }
      default:
        return children || escapeHtml(adfToText(current));
    }
  };
  return render(node);
}
