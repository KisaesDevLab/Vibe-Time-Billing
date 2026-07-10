// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// FMv2 — create new folder dialog.

import { useEffect, useState } from 'react';

import { tokens } from '@vibe/ui';

import { api, type ApiError } from '../../../api-client';

interface Props {
  clientId: string;
  defaultName: string;
  onClose: () => void;
  onCreated: (clientFolderId: string, storagePath: string) => void;
}

function sanitizePreview(raw: string): string {
  // Mirror server-side Windows-safe sanitization for the preview.
  let s = raw.replace(/[<>:"|?*]/g, '');
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\x00-\x1f]/g, '');
  return s.replace(/[/\\]/g, '-').replace(/\.+$/, '').replace(/\s+/g, ' ').trim();
}

export function CreateFolderDialog({
  clientId,
  defaultName,
  onClose,
  onCreated,
}: Props): JSX.Element {
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, busy]);

  const preview = sanitizePreview(name);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ client_folder_id: string; storage_path: string }>(
        `/api/staff/clients/${clientId}/folder/create`,
        {
          method: 'POST',
          body: JSON.stringify({ folder_name: name }),
        },
      );
      onCreated(res.client_folder_id, res.storage_path);
    } catch (err) {
      const apiErr = err as ApiError;
      setError(apiErr.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Create new folder"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 60,
      }}
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        disabled={busy}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'transparent',
          border: 'none',
          cursor: busy ? 'wait' : 'pointer',
        }}
      />
      <div
        style={{
          background: tokens.color.surface,
          borderRadius: tokens.radius.md,
          padding: 20,
          minWidth: 420,
          maxWidth: 560,
          boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
          position: 'relative',
          zIndex: 1,
        }}
      >
        <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>Create new folder</h3>
        <label
          htmlFor="fmv2-create-folder-name"
          style={{ display: 'block', fontSize: 13, marginBottom: 4 }}
        >
          Folder name
        </label>
        <input
          id="fmv2-create-folder-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
          // autoFocus removed: jsx-a11y prefers programmatic focus
          // when truly required. The user can tab into the field.
          style={{
            width: '100%',
            padding: 8,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.sm,
            fontSize: 14,
            marginBottom: 8,
          }}
        />
        <div style={{ fontSize: 11, color: tokens.color.textMuted, marginBottom: 12 }}>
          Will be created as <code style={{ fontFamily: tokens.font.mono }}>{preview}/</code>
        </div>
        {error && (
          <div
            style={{
              padding: 10,
              marginBottom: 12,
              background: 'rgba(220, 38, 38, 0.1)',
              border: `1px solid ${tokens.color.danger}`,
              borderRadius: tokens.radius.sm,
              fontSize: 13,
              color: tokens.color.danger,
            }}
          >
            {error}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={{
              padding: '6px 12px',
              background: 'transparent',
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.sm,
              cursor: busy ? 'wait' : 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || preview.length === 0}
            style={{
              padding: '6px 12px',
              background: preview.length === 0 ? tokens.color.border : tokens.color.accent,
              color: 'white',
              border: 'none',
              borderRadius: tokens.radius.sm,
              cursor: busy ? 'wait' : preview.length === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
