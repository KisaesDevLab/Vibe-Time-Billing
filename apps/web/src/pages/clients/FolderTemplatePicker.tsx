// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Modal listing the firm's active folder templates. Pick one → POST
// /clients/:id/folders/from-template to spawn the tree.

import { useEffect, useMemo, useState } from 'react';

import { Button, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface TreeNode {
  name: string;
  children?: TreeNode[];
}

interface Template {
  id: string;
  key: string;
  name: string;
  structureJson: TreeNode[] | unknown;
  isSystem: boolean;
  status: string;
}

interface Props {
  clientId: string;
  open: boolean;
  onClose: () => void;
  onPicked: (templateId: string) => Promise<void> | void;
}

export function FolderTemplatePicker({
  clientId,
  open,
  onClose,
  onPicked,
}: Props): JSX.Element | null {
  const [items, setItems] = useState<Template[]>([]);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const r = await api<{ items: Template[] }>(
          `/api/staff/clients/${clientId}/folder-templates`,
        );
        const list = (r.items ?? []).filter((t) => t.status === 'ACTIVE');
        setItems(list);
        setPickedId(list[0]?.id ?? null);
      } catch {
        setItems([]);
      }
    })();
  }, [open, clientId]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const picked = useMemo(() => items.find((t) => t.id === pickedId) ?? null, [items, pickedId]);

  if (!open) return null;

  function renderTree(nodes: TreeNode[], depth = 0): JSX.Element {
    return (
      <ul style={{ margin: 0, paddingLeft: depth === 0 ? 0 : 14, listStyle: 'none' }}>
        {nodes.map((n, i) => (
          <li key={`${depth}-${i}-${n.name}`} style={{ fontSize: 12, padding: '2px 0' }}>
            📁 {n.name}
            {n.children && n.children.length > 0 && renderTree(n.children, depth + 1)}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Pick a folder template"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div
        aria-hidden="true"
        onClick={onClose}
        style={{ position: 'absolute', inset: 0, cursor: 'pointer' }}
      />
      <div
        style={{
          position: 'relative',
          width: 'min(640px, 100%)',
          background: tokens.color.bg,
          borderRadius: tokens.radius.lg,
          boxShadow: '0 24px 60px rgba(0,0,0,0.3)',
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18 }}>Folder template</h2>
        <p style={{ margin: 0, fontSize: 12, color: tokens.color.textMuted }}>
          Spawns a folder tree under the selected location.
        </p>
        {items.length === 0 ? (
          <div style={{ fontSize: 13, color: tokens.color.textMuted }}>
            No templates available. Admins can manage them in Admin → Folder templates.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 12 }}>
            <div
              role="listbox"
              aria-label="Templates"
              style={{
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.md,
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              {items.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="option"
                  aria-selected={t.id === pickedId}
                  onClick={() => setPickedId(t.id)}
                  style={{
                    textAlign: 'left',
                    padding: '8px 10px',
                    fontSize: 13,
                    background: t.id === pickedId ? tokens.color.surface : tokens.color.bg,
                    border: 'none',
                    borderBottom: `1px solid ${tokens.color.border}`,
                    cursor: 'pointer',
                    color: tokens.color.text,
                  }}
                >
                  {t.name}
                  {t.isSystem && (
                    <span
                      style={{ fontSize: 10, color: tokens.color.textMuted, marginLeft: 6 }}
                      aria-label="System template"
                    >
                      sys
                    </span>
                  )}
                </button>
              ))}
            </div>
            <div
              style={{
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.md,
                padding: 12,
                maxHeight: 280,
                overflow: 'auto',
              }}
            >
              {picked &&
                Array.isArray(picked.structureJson) &&
                renderTree(picked.structureJson as TreeNode[])}
            </div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            disabled={!pickedId || busy}
            onClick={async () => {
              if (!pickedId) return;
              setBusy(true);
              try {
                await onPicked(pickedId);
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Spawning…' : 'Spawn folders'}
          </Button>
        </div>
      </div>
    </div>
  );
}
