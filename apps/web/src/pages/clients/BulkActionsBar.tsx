// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Selection toolbar for the file table. Appears when 1+ rows are
// checked. Buttons call the bulk endpoints; "Move..." opens a quick
// folder picker; "Share..." opens ShareModal.

import { useEffect, useRef, useState } from 'react';

import { Button, tokens } from '@vibe/ui';

import type { Folder } from './FolderTree';

interface Props {
  selectedCount: number;
  onClearSelection: () => void;
  onMove: (folderId: string | null) => void;
  onSetVisibility: (visible: boolean) => void;
  onDelete: () => void;
  onShare: () => void;
  onDownload?: () => void;
  folders: Folder[];
}

export function BulkActionsBar({
  selectedCount,
  onClearSelection,
  onMove,
  onSetVisibility,
  onDelete,
  onShare,
  onDownload,
  folders,
}: Props): JSX.Element {
  const [moveOpen, setMoveOpen] = useState(false);
  const [visibilityOpen, setVisibilityOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!moveOpen && !visibilityOpen) return;
    function handler(e: MouseEvent): void {
      if (!containerRef.current?.contains(e.target as Node)) {
        setMoveOpen(false);
        setVisibilityOpen(false);
      }
    }
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [moveOpen, visibilityOpen]);

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label="Selection actions"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 10px',
        background: tokens.color.surface,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.md,
      }}
    >
      <span style={{ fontSize: 12, fontWeight: 600 }}>{selectedCount} selected</span>
      <Button size="sm" variant="ghost" onClick={onClearSelection}>
        Clear
      </Button>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, position: 'relative' }}>
        {onDownload && (
          <Button size="sm" variant="secondary" onClick={onDownload}>
            Download
          </Button>
        )}
        <div style={{ position: 'relative' }}>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setVisibilityOpen(false);
              setMoveOpen((v) => !v);
            }}
          >
            Move…
          </Button>
          {moveOpen && (
            <div
              role="menu"
              aria-label="Move to folder"
              style={{
                position: 'absolute',
                top: '100%',
                right: 0,
                marginTop: 4,
                minWidth: 220,
                maxHeight: 280,
                overflowY: 'auto',
                background: tokens.color.bg,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.md,
                boxShadow: '0 6px 24px rgba(0,0,0,0.12)',
                zIndex: 30,
                padding: 4,
              }}
            >
              <button
                type="button"
                onClick={() => {
                  setMoveOpen(false);
                  onMove(null);
                }}
                style={menuItemStyle()}
              >
                📂 Root (no folder)
              </button>
              {folders.length === 0 && (
                <div style={{ padding: '6px 10px', fontSize: 12, color: tokens.color.textMuted }}>
                  No folders yet.
                </div>
              )}
              {folders
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => {
                      setMoveOpen(false);
                      onMove(f.id);
                    }}
                    style={menuItemStyle()}
                  >
                    📁 {f.name}
                  </button>
                ))}
            </div>
          )}
        </div>

        <div style={{ position: 'relative' }}>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setMoveOpen(false);
              setVisibilityOpen((v) => !v);
            }}
          >
            Set visibility…
          </Button>
          {visibilityOpen && (
            <div
              role="menu"
              aria-label="Set portal visibility"
              style={{
                position: 'absolute',
                top: '100%',
                right: 0,
                marginTop: 4,
                minWidth: 200,
                background: tokens.color.bg,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.md,
                boxShadow: '0 6px 24px rgba(0,0,0,0.12)',
                zIndex: 30,
                padding: 4,
              }}
            >
              <button
                type="button"
                onClick={() => {
                  setVisibilityOpen(false);
                  onSetVisibility(true);
                }}
                style={menuItemStyle()}
              >
                👁 Visible in portal
              </button>
              <button
                type="button"
                onClick={() => {
                  setVisibilityOpen(false);
                  onSetVisibility(false);
                }}
                style={menuItemStyle()}
              >
                🚫 Hidden from portal
              </button>
            </div>
          )}
        </div>

        <Button size="sm" variant="secondary" onClick={onShare}>
          Share…
        </Button>
        <Button size="sm" variant="secondary" onClick={onDelete}>
          Delete
        </Button>
      </div>
    </div>
  );
}

function menuItemStyle(): React.CSSProperties {
  return {
    display: 'block',
    width: '100%',
    padding: '6px 10px',
    background: 'none',
    border: 'none',
    textAlign: 'left',
    fontSize: 13,
    cursor: 'pointer',
    color: tokens.color.text,
  };
}
