// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// WYSIWYG rich-text editor for the proposal "Text" block. Non-technical staff
// get a formatting toolbar and never see raw Markdown — but it reads/writes
// **Markdown** (via tiptap-markdown) so the stored block format is unchanged
// and renders identically everywhere it already does.
//
// Mount-time init only: the parent keys this by block id, so switching blocks
// remounts with fresh content (avoids markdown round-trip/setContent edge cases
// and feedback loops).

import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { Markdown } from 'tiptap-markdown';

import { tokens } from '@vibe/ui';

export interface RichTextApi {
  /** Insert plain text (e.g. a merge token) at the cursor. */
  insertText: (text: string) => void;
}

/** A merge variable offered in the toolbar's "Insert variable" dropdown. */
export interface RichTextVariable {
  /** Bare token path, e.g. `client.name` (wrapped as `{{ … }}` on insert). */
  token: string;
  /** Friendly label shown in the dropdown (defaults to the token). */
  label?: string;
  /** Optional one-line description. */
  description?: string;
}

export function RichTextEditor({
  value,
  onChange,
  placeholder,
  onReady,
  variables,
  minHeight,
  format = 'markdown',
}: {
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  /** Called when the editor is ready, exposing an imperative insert API. */
  onReady?: (api: RichTextApi) => void;
  /** When provided, the toolbar shows an "Insert variable" dropdown of these. */
  variables?: RichTextVariable[];
  /** Minimum height (px) of the editable area. Defaults to a compact box. */
  minHeight?: number;
  /** Output format. 'markdown' (default) preserves the historical proposal/
   *  email behavior; 'html' emits HTML via getHTML() for document templates
   *  (letters). Mount-time only — the parent should key the component when
   *  switching format. */
  format?: 'markdown' | 'html';
}): JSX.Element {
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const isHtml = format === 'html';
  const [varOpen, setVarOpen] = useState(false);
  const varMenuRef = useRef<HTMLDivElement | null>(null);
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Link.configure({ openOnClick: false, autolink: true }),
      // Markdown storage only drives markdown mode; in HTML mode we read
      // getHTML() directly and skip it (it would rewrite the HTML).
      ...(isHtml
        ? []
        : [Markdown.configure({ html: false, linkify: true, transformPastedText: true })]),
    ],
    editorProps: {
      attributes: {
        style: `min-height: ${minHeight ?? 120}px`,
      },
    },
    content: value || '',
    onUpdate: ({ editor: ed }) => {
      if (isHtml) {
        onChange(ed.getHTML());
        return;
      }
      const md = (
        ed.storage as { markdown?: { getMarkdown: () => string } }
      ).markdown?.getMarkdown();
      onChange(md ?? ed.getText());
    },
  });

  useEffect(() => {
    if (editor && onReadyRef.current) {
      onReadyRef.current({
        insertText: (t) => editor.chain().focus().insertContent(t).run(),
      });
    }
  }, [editor]);

  // Close the variable dropdown on an outside click.
  useEffect(() => {
    if (!varOpen) return;
    function onDocMouseDown(e: MouseEvent): void {
      if (varMenuRef.current && !varMenuRef.current.contains(e.target as Node)) setVarOpen(false);
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [varOpen]);

  if (!editor) {
    return <div style={{ fontSize: 12, color: tokens.color.textMuted }}>Loading editor…</div>;
  }

  const btn = (active: boolean): React.CSSProperties => ({
    padding: '3px 8px',
    fontSize: 12,
    lineHeight: 1.2,
    cursor: 'pointer',
    border: `1px solid ${active ? tokens.color.accent : tokens.color.border}`,
    background: active ? tokens.color.accentMuted : tokens.color.surface,
    color: active ? tokens.color.accent : tokens.color.text,
    borderRadius: tokens.radius.sm,
  });

  function setLink(): void {
    if (!editor) return;
    const prev = (editor.getAttributes('link')['href'] as string | undefined) ?? '';
    const url = window.prompt('Link URL (leave blank to remove):', prev);
    if (url === null) return;
    if (url.trim() === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run();
  }

  return (
    <div
      style={{
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.sm,
        background: tokens.color.surface,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 4,
          padding: 6,
          borderBottom: `1px solid ${tokens.color.border}`,
        }}
      >
        <button
          type="button"
          style={btn(editor.isActive('bold'))}
          onClick={() => editor.chain().focus().toggleBold().run()}
          title="Bold"
        >
          <strong>B</strong>
        </button>
        <button
          type="button"
          style={btn(editor.isActive('italic'))}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          title="Italic"
        >
          <em>I</em>
        </button>
        {[1, 2, 3].map((lvl) => (
          <button
            key={lvl}
            type="button"
            style={btn(editor.isActive('heading', { level: lvl }))}
            onClick={() =>
              editor
                .chain()
                .focus()
                .toggleHeading({ level: lvl as 1 | 2 | 3 })
                .run()
            }
            title={`Heading ${lvl}`}
          >
            H{lvl}
          </button>
        ))}
        <button
          type="button"
          style={btn(editor.isActive('bulletList'))}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          title="Bulleted list"
        >
          • List
        </button>
        <button
          type="button"
          style={btn(editor.isActive('orderedList'))}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          title="Numbered list"
        >
          1. List
        </button>
        <button
          type="button"
          style={btn(editor.isActive('blockquote'))}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          title="Quote"
        >
          ❝
        </button>
        <button type="button" style={btn(editor.isActive('link'))} onClick={setLink} title="Link">
          🔗
        </button>
        <button
          type="button"
          style={btn(false)}
          onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}
          title="Clear formatting"
        >
          Clear
        </button>
        {variables && variables.length > 0 && (
          <div style={{ position: 'relative' }} ref={varMenuRef}>
            <button
              type="button"
              style={btn(varOpen)}
              onClick={() => setVarOpen((o) => !o)}
              title="Insert a merge variable that fills in automatically"
              aria-haspopup="menu"
              aria-expanded={varOpen}
            >
              {'{ }'} Variable ▾
            </button>
            {varOpen && (
              <div
                role="menu"
                style={{
                  position: 'absolute',
                  zIndex: 30,
                  top: '100%',
                  left: 0,
                  marginTop: 4,
                  minWidth: 250,
                  maxHeight: 280,
                  overflowY: 'auto',
                  background: tokens.color.surface,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.sm,
                  boxShadow: '0 6px 20px rgba(0,0,0,0.14)',
                  padding: 4,
                }}
              >
                {variables.map((v) => (
                  <button
                    key={v.token}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      editor.chain().focus().insertContent(`{{ ${v.token} }}`).run();
                      setVarOpen(false);
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = tokens.color.accentMuted;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent';
                    }}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '6px 8px',
                      border: 0,
                      background: 'transparent',
                      cursor: 'pointer',
                      borderRadius: tokens.radius.sm,
                      color: tokens.color.text,
                    }}
                  >
                    <div style={{ fontSize: 12, fontWeight: 500 }}>{v.label ?? v.token}</div>
                    <div
                      style={{
                        fontSize: 11,
                        color: tokens.color.textMuted,
                        fontFamily: 'ui-monospace, monospace',
                      }}
                    >
                      {`{{ ${v.token} }}`}
                      {v.description ? ` — ${v.description}` : ''}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <div style={{ padding: 10, fontSize: 14 }}>
        <EditorContent editor={editor} />
      </div>
      {placeholder && value.trim() === '' && (
        <div style={{ fontSize: 11, color: tokens.color.textMuted, padding: '0 10px 8px' }}>
          {placeholder}
        </div>
      )}
    </div>
  );
}
