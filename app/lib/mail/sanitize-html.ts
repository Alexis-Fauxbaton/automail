export interface AttachmentForCidMap {
  id: string;
  contentId: string | null;
  mimeType: string;
  inlineData: string | null;
}

/** Build a map from Content-ID → attachment info for cid: URL rewriting. */
export function buildCidMap(
  attachments: AttachmentForCidMap[],
): Map<string, { id: string; mimeType: string; inlineData: string | null }> {
  const map = new Map<string, { id: string; mimeType: string; inlineData: string | null }>();
  for (const att of attachments) {
    if (!att.contentId) continue;
    const entry = { id: att.id, mimeType: att.mimeType, inlineData: att.inlineData };
    const clean = att.contentId.replace(/^<|>$/g, "");
    map.set(clean, entry);
    map.set(att.contentId, entry);
  }
  return map;
}

/**
 * Sanitize an HTML email body for display in the UI:
 * - Removes <script> blocks and on* event handlers
 * - Rewrites javascript: hrefs to "#"
 * - Replaces cid: src attributes with data: URIs (when inlineData is available)
 * - Adds target="_blank" and rel="noopener noreferrer" to all <a> tags
 */
export function sanitizeEmailHtml(
  html: string,
  cidMap: Map<string, { id: string; mimeType: string; inlineData: string | null }>,
): string {
  return html
    // Remove <script> blocks
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    // Remove <style> blocks (may contain expression() or behavior: attacks)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    // Strip on* event handlers from all tags
    .replace(/(\s)on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, "")
    // Replace javascript: hrefs
    .replace(/href\s*=\s*"javascript:[^"]*"/gi, 'href="#"')
    .replace(/href\s*=\s*'javascript:[^']*'/gi, "href='#'")
    // Rewrite cid: src attributes — prefer data: URI (Gmail), fall back to proxy URL (Zoho)
    .replace(/src\s*=\s*"cid:([^"]+)"/gi, (_, cid) => {
      const att = cidMap.get(cid.trim());
      if (!att) return 'src=""';
      if (att.inlineData) return `src="data:${att.mimeType};base64,${att.inlineData}"`;
      return `src="/api/incoming-attachment?id=${att.id}"`;
    })
    .replace(/src\s*=\s*'cid:([^']+)'/gi, (_, cid) => {
      const att = cidMap.get(cid.trim());
      if (!att) return "src=''";
      if (att.inlineData) return `src='data:${att.mimeType};base64,${att.inlineData}'`;
      return `src='/api/incoming-attachment?id=${att.id}'`;
    })
    // Strip relative src attributes — they'd resolve to our app's routes and cause 404s.
    // Absolute https:// and data: are kept; cid: was already handled above.
    .replace(/src\s*=\s*"(?!https?:\/\/|data:)([^"]*)"/gi, 'src=""')
    .replace(/src\s*=\s*'(?!https?:\/\/|data:)([^']*)'/gi, "src=''")
    // Strip relative href attributes (keep https://, mailto:, #, javascript already handled)
    .replace(/href\s*=\s*"(?!https?:\/\/|mailto:|#)([^"]*)"/gi, 'href="#"')
    .replace(/href\s*=\s*'(?!https?:\/\/|mailto:|#)([^']*)'/gi, "href='#'")
    // Make all links open in a new tab safely
    .replace(/<a(\s[^>]*)?>/gi, (match) => {
      if (/target=/i.test(match)) return match;
      return match.replace(/^<a/, '<a target="_blank" rel="noopener noreferrer"');
    });
}
