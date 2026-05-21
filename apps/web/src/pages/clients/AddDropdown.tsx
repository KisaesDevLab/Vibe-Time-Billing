// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Five-option "Add" dropdown for the file manager:
//   Upload file · Upload link · New folder · Upload folder · Folder template

import { useEffect, useRef, useState } from 'react';

import { Button, tokens } from '@vibe/ui';

interface Props {
  onUploadFile: () => void;
  onUploadLink: () => void;
  onNewFolder: () => void;
  onUploadFolder?: () => void;
  onFolderTemplate: () => void;
  disabled?: boolean;
}

export function AddDropdown({
  onUploadFile,
  onUploadLink,
  onNewFolder,
  onUploadFolder,
  onFolderTemplate,
  disabled,
}: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent): void {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function esc(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', handler);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', handler);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const item = (label: string, icon: string, onClick: () => void, hint?: string): JSX.Element => (
    <button
      type="button"
      onClick={() => {
        setOpen(false);
        onClick();
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 12px',
        background: 'none',
        border: 'none',
        textAlign: 'left',
        cursor: 'pointer',
        fontSize: 13,
        width: '100%',
        color: tokens.color.text,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = tokens.color.surface;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 14 }}>
        {icon}
      </span>
      <span style={{ flex: 1 }}>{label}</span>
      {hint && (
        <span style={{ fontSize: 11, color: tokens.color.textMuted }} aria-hidden="true">
          {hint}
        </span>
      )}
    </button>
  );

  return (
    <div ref={containerRef} style={{ position: 'relative', display: 'inline-block' }}>
      <Button size="sm" onClick={() => setOpen((v) => !v)} disabled={disabled}>
        + Add
      </Button>
      {open && (
        <div
          role="menu"
          aria-label="Add menu"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 4,
            minWidth: 220,
            background: tokens.color.bg,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.md,
            boxShadow: '0 6px 24px rgba(0,0,0,0.12)',
            zIndex: 30,
            padding: 4,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {item('Upload file', '📄', onUploadFile)}
          {item('Upload link', '🔗', onUploadLink, 'URL')}
          {item('New folder', '📁', onNewFolder)}
          {onUploadFolder && item('Upload folder', '🗂️', onUploadFolder, 'soon')}
          {item('Folder template', '📋', onFolderTemplate)}
        </div>
      )}
    </div>
  );
}
