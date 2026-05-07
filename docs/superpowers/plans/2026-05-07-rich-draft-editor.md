# Rich Draft Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the plain textarea in `DraftBlock` with a TipTap rich text editor (bold, italic, underline, lists, blockquote, links) while keeping the existing autosave, version history, and AI refine/regenerate flows working.

**Architecture:** A new headless `RichDraftEditor` component wraps TipTap, exposes `{ content, onChange, readOnly }` props, and plugs into the existing `DraftBlock` `saveBody()` debounce. LLM draft generation prompts are updated to request Markdown output; a server-side `markdownToHtml()` utility converts the output before storage. Archived versions (read-only) render via the same component in `readOnly` mode — TipTap renders HTML safely in its own container without any raw HTML injection.

**Tech Stack:** `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-underline`, `@tiptap/extension-link`, `marked` (Markdown to HTML conversion, server-side)

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `app/components/RichDraftEditor.tsx` | TipTap editor + toolbar |
| Create | `app/components/RichDraftEditor.css` | Editor and toolbar styles |
| Create | `app/lib/support/markdown-to-html.ts` | `markdownToHtml(md)` utility |
| Create | `app/lib/support/__tests__/markdown-to-html.test.ts` | Unit tests for markdown conversion |
| Modify | `app/lib/support/llm-draft.ts` | Request Markdown output, convert to HTML |
| Modify | `app/lib/gmail/refine-draft.ts` | Request Markdown output, strip HTML input, convert output |
| Modify | `app/routes/app.inbox.tsx` | Replace `<s-text-area>` with `<RichDraftEditor>`, update version display |

---

## Task 1: Install dependencies

**Files:**
- Modify: `package.json` (via npm install)

- [ ] **Step 1: Install TipTap and marked packages**

```bash
npm install @tiptap/react @tiptap/pm @tiptap/starter-kit @tiptap/extension-underline @tiptap/extension-link marked
```

Expected: packages added to `node_modules` and `package.json` dependencies section.

- [ ] **Step 2: Verify install**

```bash
node -e "require('@tiptap/react'); require('marked'); console.log('OK')"
```

Expected output: `OK`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: install tiptap and marked for rich draft editor"
```

---

## Task 2: Markdown to HTML utility (TDD)

**Files:**
- Create: `app/lib/support/markdown-to-html.ts`
- Create: `app/lib/support/__tests__/markdown-to-html.test.ts`

- [ ] **Step 1: Write failing tests**

Create `app/lib/support/__tests__/markdown-to-html.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { markdownToHtml } from "../markdown-to-html";

describe("markdownToHtml", () => {
  it("converts bold", () => {
    expect(markdownToHtml("Hello **world**")).toContain("<strong>world</strong>");
  });

  it("converts italic", () => {
    expect(markdownToHtml("Hello *world*")).toContain("<em>world</em>");
  });

  it("converts unordered list", () => {
    const html = markdownToHtml("- item one\n- item two");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>item one</li>");
  });

  it("converts ordered list", () => {
    const html = markdownToHtml("1. first\n2. second");
    expect(html).toContain("<ol>");
    expect(html).toContain("<li>first</li>");
  });

  it("converts blockquote", () => {
    expect(markdownToHtml("> quoted text")).toContain("<blockquote>");
  });

  it("converts link", () => {
    const html = markdownToHtml("[click here](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("click here");
  });

  it("returns plain paragraphs for plain text", () => {
    const html = markdownToHtml("Hello world");
    expect(html).toContain("Hello world");
    expect(html).not.toContain("<script");
  });

  it("strips script tags for safety", () => {
    const html = markdownToHtml('<script>alert("xss")</script>plain text');
    expect(html).not.toContain("<script");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run app/lib/support/__tests__/markdown-to-html.test.ts
```

Expected: all tests FAIL with "Cannot find module '../markdown-to-html'"

- [ ] **Step 3: Implement `markdownToHtml`**

Create `app/lib/support/markdown-to-html.ts`:

```typescript
import { marked } from "marked";

marked.use({ async: false });

/**
 * Convert LLM-generated Markdown to HTML for draft storage.
 * Output is ingested by TipTap which renders it in its own safe container.
 */
export function markdownToHtml(markdown: string): string {
  // Strip any script tags before parsing (belt-and-suspenders)
  const stripped = markdown.replace(/<script[\s\S]*?<\/script>/gi, "");
  const html = marked.parse(stripped);
  return typeof html === "string" ? html : String(html);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run app/lib/support/__tests__/markdown-to-html.test.ts
```

Expected: all 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add app/lib/support/markdown-to-html.ts app/lib/support/__tests__/markdown-to-html.test.ts
git commit -m "feat: add markdownToHtml utility with tests"
```

---

## Task 3: Update LLM prompts to output Markdown, convert draft outputs

**Files:**
- Modify: `app/lib/support/llm-draft.ts` (lines ~96-97 and ~299-318 and ~345)
- Modify: `app/lib/gmail/refine-draft.ts`

- [ ] **Step 1: Update `buildSystemPrompt` output rule in `llm-draft.ts`**

In `app/lib/support/llm-draft.ts`, find the `## Output` section at the end of `buildSystemPrompt` (line ~96):

```typescript
// BEFORE:
## Output
Plain text only. No subject line, no markdown, no JSON.\``;
```

Replace with:

```typescript
// AFTER:
## Output
Use light Markdown formatting where it helps readability:
- **bold** for key information (order numbers, dates, actions)
- bullet lists (- item) for multiple steps or items
- numbered lists (1. item) for sequential steps
- > blockquote for quoting back something the customer said
- [link text](url) for hyperlinks

No subject line, no JSON. Keep formatting minimal and professional.\``;
```

- [ ] **Step 2: Add the `markdownToHtml` import in `llm-draft.ts`**

At the top of `app/lib/support/llm-draft.ts`, add:

```typescript
import { markdownToHtml } from "./markdown-to-html";
```

- [ ] **Step 3: Wrap the `templateFallback` return in `generateLLMDraft`**

In `generateLLMDraft`, find the block inside the `if (!client)` check (lines ~299-318):

```typescript
// BEFORE:
return templateFallback({
  intent: input.intent,
  order: input.order,
  orderCandidates: input.orderCandidates,
  trackings: input.trackings,
  confidence: "low",
  warnings: input.warnings,
  identifiers: {},
  conversation: {
    messageCount: 1,
    incomingCount: 1,
    outgoingCount: 0,
    lastMessageDirection: "incoming",
    noReplyNeeded: false,
  },
  settings: input.settings,
  parsed: input.parsed,
});
```

Replace with:

```typescript
// AFTER:
return markdownToHtml(templateFallback({
  intent: input.intent,
  order: input.order,
  orderCandidates: input.orderCandidates,
  trackings: input.trackings,
  confidence: "low",
  warnings: input.warnings,
  identifiers: {},
  conversation: {
    messageCount: 1,
    incomingCount: 1,
    outgoingCount: 0,
    lastMessageDirection: "incoming",
    noReplyNeeded: false,
  },
  settings: input.settings,
  parsed: input.parsed,
}));
```

- [ ] **Step 4: Wrap the LLM response return in `generateLLMDraft`**

Inside the `try` block, find the line that returns the LLM response content:

```typescript
// BEFORE:
return response.choices[0]?.message?.content?.trim() ?? "";
```

Replace with:

```typescript
// AFTER:
const markdown = response.choices[0]?.message?.content?.trim() ?? "";
return markdownToHtml(markdown);
```

- [ ] **Step 5: Update `refineDraft` in `app/lib/gmail/refine-draft.ts`**

Replace the entire file content with:

```typescript
import { getOpenAIClient, trackedChatCompletion, type TrackedCallContext } from "../llm/client";
import { markdownToHtml } from "../support/markdown-to-html";

/**
 * Strip HTML tags to plain text for LLM input.
 * Replaces block-level closing tags with newlines to preserve readability.
 */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<\/p>|<\/li>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Refine a draft reply based on user instructions.
 * Accepts HTML draft input (from TipTap), returns HTML output.
 */
export async function refineDraft(
  currentDraft: string,
  instructions: string,
  context?: { subject?: string; body?: string },
  ctx?: Partial<TrackedCallContext>,
): Promise<string> {
  const client = getOpenAIClient();
  if (!client) throw new Error("OpenAI API key not configured");

  // Strip HTML to plain text so the LLM sees clean content, not markup
  const currentDraftText = htmlToPlainText(currentDraft);

  const systemPrompt = `You are a customer support email editor for an e-commerce store.
You will receive:
- The current draft reply to a customer (as plain text)
- The user's instructions on how to modify it
- Optionally, the original customer email for context

Apply the requested changes while keeping the reply:
- Professional and concise
- Factual (never invent information)
- In the same language as the current draft

Use light Markdown formatting where it helps readability:
- **bold** for key information
- bullet lists (- item) for multiple steps or items
- numbered lists (1. item) for sequential steps

Return ONLY the updated email text. No explanation, no quotes.`;

  let userMessage = `Current draft:\n${currentDraftText}\n\nInstructions: ${instructions}`;
  if (context?.subject || context?.body) {
    const original = [
      context.subject ? `Subject: ${context.subject}` : "",
      context.body ? `Body:\n${context.body.slice(0, 800)}` : "",
    ].filter(Boolean).join("\n");
    userMessage += `\n\nOriginal customer email:\n${original}`;
  }

  const response = await trackedChatCompletion(
    client,
    {
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0.3,
      max_tokens: 600,
    },
    { callSite: "refine-draft", ...ctx },
  );

  const markdown = response.choices[0]?.message?.content?.trim() ?? currentDraft;
  return markdownToHtml(markdown);
}
```

- [ ] **Step 6: Run existing tests**

```bash
npx vitest run app/lib/support/__tests__/response-draft.test.ts app/lib/support/__tests__/pipeline.test.ts
```

Expected: all tests PASS (mocked LLM calls are not affected by prompt changes)

- [ ] **Step 7: Commit**

```bash
git add app/lib/support/llm-draft.ts app/lib/gmail/refine-draft.ts
git commit -m "feat: update LLM prompts to output Markdown, convert drafts to HTML"
```

---

## Task 4: Create `RichDraftEditor` component

**Files:**
- Create: `app/components/RichDraftEditor.tsx`
- Create: `app/components/RichDraftEditor.css`

- [ ] **Step 1: Create the CSS file**

Create `app/components/RichDraftEditor.css`:

```css
/* Toolbar */
.rich-draft-toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 6px;
  border: 1px solid var(--p-color-border);
  border-bottom: none;
  border-radius: 8px 8px 0 0;
  background: var(--p-color-bg-surface-secondary);
  flex-wrap: wrap;
}

.rich-draft-toolbar-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  color: var(--p-color-text);
  transition: background 0.1s;
}

.rich-draft-toolbar-btn:hover {
  background: var(--p-color-bg-surface-hover);
}

.rich-draft-toolbar-btn.active {
  background: var(--p-color-bg-surface-active, #e8eaed);
  color: var(--p-color-text-emphasis, #1a1a2e);
}

.rich-draft-toolbar-sep {
  width: 1px;
  height: 20px;
  background: var(--p-color-border);
  margin: 0 4px;
}

/* Link input row */
.rich-draft-link-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border: 1px solid var(--p-color-border);
  border-bottom: none;
  background: var(--p-color-bg-surface);
}

.rich-draft-link-row input {
  flex: 1;
  border: 1px solid var(--p-color-border);
  border-radius: 4px;
  padding: 3px 8px;
  font-size: 12px;
  outline: none;
  background: var(--p-color-bg-surface);
  color: var(--p-color-text);
}

.rich-draft-link-row input:focus {
  border-color: var(--p-color-border-focus, #5c6ac4);
}

.rich-draft-link-row button {
  padding: 3px 10px;
  border: 1px solid var(--p-color-border);
  border-radius: 4px;
  background: var(--p-color-bg-surface);
  cursor: pointer;
  font-size: 12px;
  color: var(--p-color-text);
}

/* Editor content area */
.rich-draft-editor {
  border: 1px solid var(--p-color-border);
  border-radius: 0 0 8px 8px;
  padding: 10px 12px;
  min-height: 220px;
  font-size: 13px;
  font-family: inherit;
  line-height: 1.55;
  color: var(--p-color-text);
  background: var(--p-color-bg-surface);
  outline: none;
  overflow-y: auto;
}

/* When no toolbar (readOnly), full border radius */
.rich-draft-editor--standalone {
  border-radius: 8px;
}

/* Rendered content styles */
.rich-draft-editor p { margin: 0 0 8px; }
.rich-draft-editor p:last-child { margin-bottom: 0; }
.rich-draft-editor strong { font-weight: 600; }
.rich-draft-editor em { font-style: italic; }
.rich-draft-editor u { text-decoration: underline; }
.rich-draft-editor ul, .rich-draft-editor ol { padding-left: 20px; margin: 0 0 8px; }
.rich-draft-editor li { margin-bottom: 2px; }
.rich-draft-editor blockquote {
  border-left: 3px solid var(--p-color-border-strong, #c9cdd3);
  margin: 0 0 8px;
  padding-left: 12px;
  color: var(--p-color-text-subdued);
}
.rich-draft-editor a {
  color: var(--p-color-text-link, #5c6ac4);
  text-decoration: underline;
}
```

- [ ] **Step 2: Create `RichDraftEditor.tsx`**

Create `app/components/RichDraftEditor.tsx`:

```typescript
import { useCallback, useEffect, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import "./RichDraftEditor.css";

export interface RichDraftEditorProps {
  content: string;
  onChange?: (html: string) => void;
  readOnly?: boolean;
}

export function RichDraftEditor({ content, onChange, readOnly = false }: RichDraftEditorProps) {
  const [showLinkInput, setShowLinkInput] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");

  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      Link.configure({ openOnClick: false, autolink: true }),
    ],
    content,
    editable: !readOnly,
    onUpdate: ({ editor: e }) => {
      onChange?.(e.getHTML());
    },
  });

  // Sync content when parent pushes a new draft (e.g. after AI regeneration)
  useEffect(() => {
    if (!editor) return;
    if (editor.getHTML() !== content) {
      editor.commands.setContent(content, false);
    }
  }, [content, editor]);

  const applyLink = useCallback(() => {
    if (!editor) return;
    const url = linkUrl.trim();
    if (!url) {
      editor.chain().focus().unsetLink().run();
    } else {
      const href = url.startsWith("http") ? url : `https://${url}`;
      editor.chain().focus().setLink({ href }).run();
    }
    setShowLinkInput(false);
    setLinkUrl("");
  }, [editor, linkUrl]);

  const handleLinkButtonClick = useCallback(() => {
    if (!editor) return;
    if (editor.isActive("link")) {
      editor.chain().focus().unsetLink().run();
      return;
    }
    const { from, to } = editor.state.selection;
    const selectedText = editor.state.doc.textBetween(from, to);
    if (selectedText.startsWith("http")) setLinkUrl(selectedText);
    setShowLinkInput((v) => !v);
  }, [editor]);

  if (!editor) return null;

  if (readOnly) {
    return (
      <EditorContent
        editor={editor}
        className="rich-draft-editor rich-draft-editor--standalone"
      />
    );
  }

  return (
    <div>
      <div className="rich-draft-toolbar" role="toolbar" aria-label="Formatting options">
        <button
          type="button"
          title="Gras"
          className={`rich-draft-toolbar-btn${editor.isActive("bold") ? " active" : ""}`}
          onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleBold().run(); }}
        >
          <strong>B</strong>
        </button>
        <button
          type="button"
          title="Italique"
          className={`rich-draft-toolbar-btn${editor.isActive("italic") ? " active" : ""}`}
          onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleItalic().run(); }}
        >
          <em>I</em>
        </button>
        <button
          type="button"
          title="Souligné"
          className={`rich-draft-toolbar-btn${editor.isActive("underline") ? " active" : ""}`}
          onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleUnderline().run(); }}
        >
          <u>U</u>
        </button>

        <div className="rich-draft-toolbar-sep" />

        <button
          type="button"
          title="Liste à puces"
          className={`rich-draft-toolbar-btn${editor.isActive("bulletList") ? " active" : ""}`}
          onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleBulletList().run(); }}
        >
          ≡
        </button>
        <button
          type="button"
          title="Liste numérotée"
          className={`rich-draft-toolbar-btn${editor.isActive("orderedList") ? " active" : ""}`}
          onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleOrderedList().run(); }}
        >
          1.
        </button>

        <div className="rich-draft-toolbar-sep" />

        <button
          type="button"
          title="Citation"
          className={`rich-draft-toolbar-btn${editor.isActive("blockquote") ? " active" : ""}`}
          onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleBlockquote().run(); }}
        >
          «
        </button>
        <button
          type="button"
          title={editor.isActive("link") ? "Supprimer le lien" : "Insérer un lien"}
          className={`rich-draft-toolbar-btn${editor.isActive("link") ? " active" : ""}`}
          onMouseDown={(e) => { e.preventDefault(); handleLinkButtonClick(); }}
        >
          🔗
        </button>

        <div className="rich-draft-toolbar-sep" />

        <button
          type="button"
          title="Effacer la mise en forme"
          className="rich-draft-toolbar-btn"
          onMouseDown={(e) => {
            e.preventDefault();
            editor.chain().focus().unsetAllMarks().clearNodes().run();
          }}
        >
          ✕
        </button>
      </div>

      {showLinkInput && (
        <div className="rich-draft-link-row">
          <input
            autoFocus
            type="url"
            placeholder="https://..."
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); applyLink(); }
              if (e.key === "Escape") { setShowLinkInput(false); setLinkUrl(""); }
            }}
          />
          <button type="button" onClick={applyLink}>OK</button>
          <button type="button" onClick={() => { setShowLinkInput(false); setLinkUrl(""); }}>Annuler</button>
        </div>
      )}

      <EditorContent editor={editor} className="rich-draft-editor" />
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add app/components/RichDraftEditor.tsx app/components/RichDraftEditor.css
git commit -m "feat: add RichDraftEditor component with TipTap toolbar"
```

---

## Task 5: Wire `RichDraftEditor` into `DraftBlock`

**Files:**
- Modify: `app/routes/app.inbox.tsx`

- [ ] **Step 1: Add the import at the top of `app.inbox.tsx`**

Near the other component imports (around line 18), add:

```typescript
import { RichDraftEditor } from "../components/RichDraftEditor";
```

- [ ] **Step 2: Remove the shadow-DOM `textareaRef` and its `input` listener**

In `DraftBlock`, remove the following (lines ~1561-1611):

```typescript
// REMOVE: the ref declaration
const textareaRef = useRef<any>(null);

// REMOVE: the entire useEffect that attaches the input listener to textareaRef
useEffect(() => {
  const el = textareaRef.current;
  if (!el) return;
  const handler = (e: Event) => {
    const textarea = (e.target as HTMLElement).shadowRoot?.querySelector("textarea") ??
      (el.shadowRoot?.querySelector("textarea"));
    const value = textarea?.value ?? (e as InputEvent).data ?? "";
    const inner = el.querySelector("textarea") ?? el.shadowRoot?.querySelector("textarea");
    const text = inner?.value ?? value;
    setBodyText(text);
    saveBody(text);
  };
  el.addEventListener("input", handler);
  return () => el.removeEventListener("input", handler);
// eslint-disable-next-line react-hooks/exhaustive-deps
}, []);
```

- [ ] **Step 3: Replace the `<s-text-area>` with `<RichDraftEditor>`**

Find the `<s-text-area>` block (lines ~1755-1761):

```typescript
// BEFORE:
<s-text-area
  ref={textareaRef}
  label={isLatest ? t("inbox.editableDraft") : t("inbox.draftVersion", { n: versionIndex + 1 })}
  rows={10}
  value={isLatest ? bodyText : currentVersion}
  readOnly={!isLatest}
/>
```

Replace with:

```typescript
// AFTER:
{isLatest ? (
  <RichDraftEditor
    content={bodyText}
    onChange={(html) => {
      setBodyText(html);
      saveBody(html);
    }}
  />
) : (
  <RichDraftEditor
    content={currentVersion}
    readOnly
  />
)}
```

- [ ] **Step 4: Verify the `currentDraft` hidden input in the refine form**

The refine form passes `bodyText` (now HTML) as `currentDraft`. Confirm the hidden input is present unchanged:

```typescript
<input type="hidden" name="currentDraft" value={bodyText} />
```

No change needed — `refineDraft` strips HTML to plain text before sending to the LLM.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no type errors. Fix any that appear before moving on.

- [ ] **Step 6: Commit**

```bash
git add app/routes/app.inbox.tsx
git commit -m "feat: replace draft textarea with RichDraftEditor in DraftBlock"
```

---

## Task 6: Run full test suite and verify

- [ ] **Step 1: Run all tests**

```bash
npx vitest run
```

Expected: all tests PASS. If any test asserts on the exact draft content format (plain text vs HTML), update those assertions — wrap expected strings in `<p>` tags or use `toContain` for the text portion only.

- [ ] **Step 2: Check for TypeScript errors**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit if any test fixes were needed**

```bash
git add -p
git commit -m "fix: update test assertions for HTML draft output format"
```

---

## Self-Review Notes

- **Spec coverage:**
  - TipTap in `DraftBlock` only (inbox) — out of scope for support page
  - Toolbar: B/I/U, bullet list, ordered list, blockquote, link, clear formatting
  - HTML storage — no DB schema change, `body` column stores HTML string
  - LLM generates Markdown, converted to HTML in both `generateLLMDraft` and `refineDraft`
  - Autosave via existing `saveBody()` debounce — `onChange` plugs in directly
  - Archived versions display via `RichDraftEditor` with `readOnly={true}` — TipTap renders safely

- **Type consistency:**
  - `RichDraftEditorProps.content`: `string` (HTML)
  - `RichDraftEditorProps.onChange`: `(html: string) => void` — receives `editor.getHTML()`
  - `saveBody(text: string)` receives HTML — consistent throughout `DraftBlock`
  - `refineDraft` returns `Promise<string>` (HTML) — consistent with `upsertReplyDraftBody` caller
  - `markdownToHtml(markdown: string): string` — used in both `llm-draft.ts` and `refine-draft.ts`

- **No placeholders:** All steps include complete code.
