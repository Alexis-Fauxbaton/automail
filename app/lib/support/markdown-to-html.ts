import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

/**
 * Convert LLM-generated Markdown to HTML for draft storage.
 * Output is ingested by TipTap which renders it in its own safe container,
 * but we still allow-list HTML tags after parsing — `marked` lets raw HTML
 * (including `<img onerror>`, `<iframe>`, etc.) through by default.
 */
export function markdownToHtml(markdown: string): string {
  const html = marked(markdown, { async: false });
  return sanitizeHtml(html, {
    allowedTags: [
      "p", "br", "strong", "em", "u", "s", "ul", "ol", "li",
      "blockquote", "a", "code", "pre", "h1", "h2", "h3", "h4", "h5", "h6",
    ],
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    disallowedTagsMode: "discard",
  });
}
