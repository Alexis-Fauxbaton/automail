import sanitizeHtml from "sanitize-html";

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
    if (clean !== att.contentId) map.set(att.contentId, entry);
  }
  return map;
}

/**
 * Sanitize an HTML email body for display in the UI using a real HTML parser
 * (sanitize-html) instead of regex-based heuristics:
 * - Removes dangerous tags: script, iframe, object, embed, form, base, link, meta
 * - Removes all on* event handlers
 * - Rewrites javascript: hrefs to "#"
 * - Rewrites cid: src attributes with data: URIs (when inlineData is available)
 *   or falls back to the proxy URL
 * - Adds target="_blank" and rel="noopener noreferrer" to all <a> tags
 * - Allows standard email HTML tags and safe attributes
 */
export function sanitizeEmailHtml(
  html: string,
  cidMap: Map<string, { id: string; mimeType: string; inlineData: string | null }>,
): string {
  // Step 1: rewrite cid: src attributes BEFORE parsing so the parser sees the
  // final data: or /api/ URL and can apply the allowedSchemes check.
  // Single regex with backreferenced quote so logic isn't duplicated per-quote.
  const cidResolved = html.replace(
    /src\s*=\s*(["'])cid:([^"']+)\1/gi,
    (_, q, cid) => {
      const att = cidMap.get(cid.trim());
      if (!att) return `src=${q}${q}`;
      if (att.inlineData) return `src=${q}data:${att.mimeType};base64,${att.inlineData}${q}`;
      return `src=${q}/api/incoming-attachment?id=${att.id}${q}`;
    },
  );

  // Step 2: run the parser-based sanitizer.
  const sanitized = sanitizeHtml(cidResolved, {
    // ------------------------------------------------------------------ tags
    allowedTags: [
      // document structure
      "html", "head", "body",
      // text blocks
      "p", "div", "span", "pre", "code", "blockquote",
      // headings
      "h1", "h2", "h3", "h4", "h5", "h6",
      // lists
      "ul", "ol", "li", "dl", "dt", "dd",
      // inline formatting
      "strong", "em", "b", "i", "u", "s", "strike", "sub", "sup",
      "small", "big", "abbr", "cite", "del", "ins", "mark",
      // links & media
      "a", "img",
      // table
      "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "col", "colgroup",
      // misc
      "br", "hr", "wbr",
      "figure", "figcaption",
      "address",
      "center",  // common in legacy email HTML
      "font",    // common in legacy email HTML
      "tt",      // common in legacy email HTML
    ],
    // ------------------------------------------------------------------ attributes
    allowedAttributes: {
      // Allow style on everything for inline-styled email HTML
      "*": ["style", "class", "id", "dir", "lang"],
      "a": [
        "href",
        "title",
        "target",
        "rel",
        "name",
      ],
      "img": [
        "src",
        "alt",
        "title",
        "width",
        "height",
        "border",
        "align",
        "hspace",
        "vspace",
      ],
      "table": ["width", "height", "border", "cellpadding", "cellspacing", "align", "bgcolor", "summary"],
      "tr":    ["align", "valign", "bgcolor", "height"],
      "th":    ["align", "valign", "bgcolor", "width", "height", "colspan", "rowspan", "scope", "abbr"],
      "td":    ["align", "valign", "bgcolor", "width", "height", "colspan", "rowspan", "nowrap"],
      "col":      ["width", "align", "valign", "span"],
      "colgroup": ["width", "align", "valign", "span"],
      "font":  ["color", "size", "face"],
      "div":   ["align"],
      "p":     ["align"],
      "center": [],
      "hr":    ["width", "size", "align", "color"],
      "blockquote": ["type", "cite"],
      "ol":    ["type", "start"],
      "ul":    ["type"],
      "li":    ["type", "value"],
    },
    // ------------------------------------------------------------------ schemes
    allowedSchemes: ["https", "http", "mailto", "data"],
    allowedSchemesByTag: {
      // Only allow data: on img (for inline CID images); blocked on links.
      img: ["https", "http", "data"],
      a:   ["https", "http", "mailto"],
    },
    // Relative /api/ paths must pass through; allowedSchemes only handles
    // absolute URIs. We'll handle relative src post-sanitize (below).
    allowRelativeUrls: true,

    // ------------------------------------------------------------------ style
    // Allow inline styles but strip any expression(), behavior:, or url()
    // pointing at javascript: / data:text URIs.
    allowedStyles: {
      "*": {
        // Permit any CSS property value EXCEPT those with dangerous patterns.
        // sanitize-html filters style properties by regex; we use a permissive
        // catch-all and rely on the exclusion list below to strip dangerous values.
        "color":               [/.*/],
        "background":          [/^(?!.*javascript:)(?!.*expression\s*\().*$/i],
        "background-color":    [/.*/],
        "background-image":    [/^(?!.*javascript:)(?!.*expression\s*\().*$/i],
        "font-size":           [/.*/],
        "font-family":         [/.*/],
        "font-weight":         [/.*/],
        "font-style":          [/.*/],
        "text-align":          [/.*/],
        "text-decoration":     [/.*/],
        "text-indent":         [/.*/],
        "line-height":         [/.*/],
        "letter-spacing":      [/.*/],
        "word-spacing":        [/.*/],
        "vertical-align":      [/.*/],
        "width":               [/.*/],
        "max-width":           [/.*/],
        "min-width":           [/.*/],
        "height":              [/.*/],
        "max-height":          [/.*/],
        "min-height":          [/.*/],
        "margin":              [/.*/],
        "margin-top":          [/.*/],
        "margin-right":        [/.*/],
        "margin-bottom":       [/.*/],
        "margin-left":         [/.*/],
        "padding":             [/.*/],
        "padding-top":         [/.*/],
        "padding-right":       [/.*/],
        "padding-bottom":      [/.*/],
        "padding-left":        [/.*/],
        "border":              [/.*/],
        "border-top":          [/.*/],
        "border-right":        [/.*/],
        "border-bottom":       [/.*/],
        "border-left":         [/.*/],
        "border-color":        [/.*/],
        "border-width":        [/.*/],
        "border-style":        [/.*/],
        "border-radius":       [/.*/],
        "border-collapse":     [/.*/],
        "border-spacing":      [/.*/],
        "display":             [/.*/],
        "overflow":            [/.*/],
        "overflow-x":          [/.*/],
        "overflow-y":          [/.*/],
        "float":               [/.*/],
        "clear":               [/.*/],
        "position":            [/^(static|relative|sticky)$/i],
        "top":                 [/.*/],
        "right":               [/.*/],
        "bottom":              [/.*/],
        "left":                [/.*/],
        "z-index":             [/.*/],
        "flex":                [/.*/],
        "flex-direction":      [/.*/],
        "flex-wrap":           [/.*/],
        "justify-content":     [/.*/],
        "align-items":         [/.*/],
        "align-self":          [/.*/],
        "gap":                 [/.*/],
        "table-layout":        [/.*/],
        "border-left-color":   [/.*/],
        "border-left-width":   [/.*/],
        "border-left-style":   [/.*/],
        "opacity":             [/.*/],
        "visibility":          [/.*/],
        "white-space":         [/.*/],
        "word-break":          [/.*/],
        "word-wrap":           [/.*/],
        "list-style":          [/.*/],
        "list-style-type":     [/.*/],
        "caption-side":        [/.*/],
        "empty-cells":         [/.*/],
        "direction":           [/.*/],
        "mso-line-height-rule":[/.*/],  // Outlook-specific
        "mso-padding-alt":     [/.*/],
      },
    },

    // ------------------------------------------------------------------ hooks
    // Post-process each tag for link safety and other fixups.
    transformTags: {
      // Ensure all <a> tags open in a new tab safely and have no javascript: href.
      "a": (tagName, attribs) => {
        const href = attribs.href ?? "";
        // Block javascript: and any remaining data: on links (belt-and-suspenders)
        const safeHref = /^javascript:/i.test(href) || /^data:/i.test(href)
          ? "#"
          : href;
        return {
          tagName,
          attribs: {
            ...attribs,
            href: safeHref,
            target: "_blank",
            rel: "noopener noreferrer",
          },
        };
      },
      // Block data:text/html and data:application/ on img src (belt-and-suspenders).
      "img": (tagName, attribs) => {
        const src = attribs.src ?? "";
        const safeSrc = /^data:(?:text|application)/i.test(src) ? "" : src;
        return { tagName, attribs: { ...attribs, src: safeSrc } };
      },
    },

    // Strip unknown/disallowed tags entirely (don't keep their content for
    // dangerous tags; for others content is kept).
    nonTextTags: ["script", "style", "iframe", "object", "embed", "form", "base", "link", "meta", "noscript", "template"],
    disallowedTagsMode: "discard",
  });

  // Step 3: strip any relative src that isn't an /api/ proxy path.
  // sanitize-html with allowRelativeUrls:true passes through ALL relative URLs,
  // including bare paths like "image.gif" that would resolve against our app.
  // We only want to keep /api/ proxy paths; everything else gets blanked.
  return sanitized
    .replace(/src\s*=\s*"(?!https?:\/\/|data:|\/api\/)([^"]*)"/gi, 'src=""')
    .replace(/src\s*=\s*'(?!https?:\/\/|data:|\/api\/)([^']*)'/gi, "src=''");
}
