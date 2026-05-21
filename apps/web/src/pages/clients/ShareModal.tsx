// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// UI-only share modal. Send is a stub-toast for now — real email
// dispatch lands alongside the portal binding for visible_in_portal.

import { useEffect, useMemo, useState } from 'react';

import { Button, MultiCombobox, tokens, type ComboboxOption } from '@vibe/ui';

import { api } from '../../api-client';

interface FileMeta {
  id: string;
  fileName: string;
}

interface ContactRow {
  id: string;
  fullName: string;
  email: string | null;
}

interface Props {
  clientId: string | null;
  files: FileMeta[];
  open: boolean;
  onClose: () => void;
}

export function ShareModal({ clientId, files, open, onClose }: Props): JSX.Element | null {
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [includeMessage, setIncludeMessage] = useState(false);
  const [message, setMessage] = useState('');
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !clientId) return;
    void (async () => {
      try {
        const r = await api<{ items: ContactRow[] }>(`/api/staff/clients/${clientId}/contacts`);
        setContacts(r.items ?? []);
      } catch {
        setContacts([]);
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

  const options = useMemo<ComboboxOption[]>(
    () =>
      contacts
        .filter((c) => c.email)
        .map((c) => ({
          value: c.id,
          label: c.fullName,
          description: c.email ?? '',
        })),
    [contacts],
  );

  if (!open) return null;

  function handleSend(): void {
    // v2 Part 1 — UI-only. Real dispatch will use the same email
    // provider abstraction that backs the magic-link / invoice mailers.
    setToast('Share queued — wiring lands when portal binding ships.');
    setTimeout(() => {
      onClose();
      setToast(null);
      setRecipients([]);
      setMessage('');
      setIncludeMessage(false);
    }, 1200);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Share files"
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
          width: 'min(520px, 100%)',
          background: tokens.color.bg,
          borderRadius: tokens.radius.lg,
          boxShadow: '0 24px 60px rgba(0,0,0,0.3)',
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Share files</h2>
          <span
            style={{ fontSize: 12, color: tokens.color.textMuted, marginLeft: 'auto' }}
            aria-hidden="true"
          >
            {files.length} selected
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, color: tokens.color.textMuted }}>Files</span>
          <div
            style={{
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.md,
              padding: 8,
              maxHeight: 120,
              overflow: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            {files.length === 0 ? (
              <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                No files selected.
              </span>
            ) : (
              files.map((f) => (
                <div key={f.id} style={{ fontSize: 12 }}>
                  📄 {f.fileName}
                </div>
              ))
            )}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, color: tokens.color.textMuted }}>Recipients</span>
          <MultiCombobox
            options={options}
            selected={recipients}
            onChange={setRecipients}
            placeholder={
              clientId ? 'Add client contacts (with email)' : 'Pick recipients (firm internal)'
            }
            emptyLabel={clientId ? 'No contacts with email on file' : 'Recipient picker stub'}
            ariaLabel="Share recipients"
          />
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          <input
            type="checkbox"
            checked={includeMessage}
            onChange={(e) => setIncludeMessage(e.target.checked)}
          />
          Include a personalized message
        </label>
        {includeMessage && (
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Message body (stub — templates picker coming soon)"
            rows={4}
            style={{
              padding: 8,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.md,
              fontFamily: 'inherit',
              fontSize: 13,
              resize: 'vertical',
            }}
          />
        )}

        {toast && (
          <div
            role="status"
            style={{
              background: tokens.color.surface,
              borderRadius: tokens.radius.md,
              padding: '8px 10px',
              fontSize: 12,
              color: tokens.color.text,
            }}
          >
            {toast}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSend} disabled={files.length === 0 || recipients.length === 0}>
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
