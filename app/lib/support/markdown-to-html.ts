import { marked } from "marked";

/**
 * Convert LLM-generated Markdown to HTML for draft storage.
 * Output is ingested by TipTap which renders it in its own safe container.
 */
export function markdownToHtml(markdown: string): string {
  // Strip any script tags before parsing (belt-and-suspenders)
  const stripped = markdown.replace(/<script[\s\S]*?<\/script>/gi, "");
  const html = marked(stripped, { async: false });
  return html;
}
