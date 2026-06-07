// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// WYSIWYG rich-text editor for the proposal "Text" block. Non-technical staff
// get a formatting toolbar and never see raw Markdown — but it reads/writes
// **Markdown** (via tiptap-markdown) so the stored block format is unchanged
// and renders identically everywhere it already does.
//
// Mount-time init only: the parent keys this by block id, so switching blocks
// remounts with fresh content (avoids markdown round-trip/setContent edge cases
// and feedback loops).

import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { Markdown } from 'tiptap-markdown';

import { tokens } from '@vibe/ui';

export function RichTextEditor({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
}): JSX.Element {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Link.configure({ openOnClick: false, autolink: true }),
      Markdown.configure({ html: false, linkify: true, transformPastedText: true }),
    ],
    content: value || '',
    onUpdate: ({ editor: ed }) => {
      const md = (
        ed.storage as { markdown?: { getMarkdown: () => string } }
      ).markdown?.getMarkdown();
      onChange(md ?? ed.getText());
    },
  });

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
