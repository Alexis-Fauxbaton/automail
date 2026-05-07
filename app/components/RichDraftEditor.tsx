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
    immediatelyRender: false,
    onUpdate: ({ editor: e }) => {
      onChange?.(e.getHTML());
    },
  });

  // Sync content when parent pushes a new draft (e.g. after AI regeneration)
  useEffect(() => {
    if (!editor) return;
    if (editor.getHTML() !== content) {
      editor.commands.setContent(content, { emitUpdate: false });
    }
  }, [content, editor]);

  // Sync editable state when parent toggles readOnly
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!readOnly);
  }, [editor, readOnly]);

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

  return (
    <div>
      {!readOnly && (
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
      )}

      {!readOnly && showLinkInput && (
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

      <EditorContent
        editor={editor}
        className={`rich-draft-editor${readOnly ? " rich-draft-editor--standalone" : ""}`}
      />
    </div>
  );
}
