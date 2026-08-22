// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// DS-4 — "Attach from UltraTax". The desktop shell watches a print-to-PDF
// outbox folder; when a PDF lands there it emits desktop:outbox-file and
// the Shell opens this dialog. The user picks a client (and optionally a
// subfolder), we upload through the normal presigned-PUT path, then the
// shell deletes the file from the outbox so no client PDF lingers on disk.

import { useEffect, useState } from 'react';
import { Button, Modal, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { uploadOneClientFile } from '../lib/client-files-upload';
import { deleteOutboxFile, readOutboxFile, type OutboxFile } from '../lib/desktop';

interface ClientHit {
  id: string;
  name: string;
  externalId?: string | null;
}

export function OutboxAttachDialog({
  file,
  onClose,
}: {
  file: OutboxFile;
  onClose: () => void;
}): JSX.Element {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<ClientHit[]>([]);
  const [client, setClient] = useState<ClientHit | null>(null);
  const [category, setCategory] = useState<'correspondence' | 'other'>('other');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    let alive = true;
    const h = setTimeout(() => {
      void api<{ items: ClientHit[] }>(`/api/staff/clients?q=${encodeURIComponent(q.trim())}`)
        .then((r) => {
          if (alive) setHits(r.items.slice(0, 8));
        })
        .catch(() => undefined);
    }, 200);
    return () => {
      alive = false;
      clearTimeout(h);
    };
  }, [q]);

  async function attach(): Promise<void> {
    if (!client) return;
    setBusy(true);
    setError(null);
    try {
      const bytes = await readOutboxFile(file.path);
      // Copy into a plain ArrayBuffer-backed view so the File ctor's BlobPart typing is satisfied.
      const f = new File([new Uint8Array(bytes).buffer as ArrayBuffer], file.name, {
        type: 'application/pdf',
      });
      await uploadOneClientFile(client.id, f, category);
      await deleteOutboxFile(file.path).catch(() => undefined);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'upload_failed');
    } finally {
      setBusy(false);
    }
  }

  async function discard(): Promise<void> {
    await deleteOutboxFile(file.path).catch(() => undefined);
    onClose();
  }

  const mb = (file.size / (1024 * 1024)).toFixed(1);

  return (
    <Modal title="Attach printed PDF" onClose={onClose} minWidth={460}>
      <p style={{ margin: '0 0 12px', fontSize: 13 }}>
        <strong>{file.name}</strong>{' '}
        <span style={{ color: tokens.color.textMuted }}>({mb} MB) landed in your outbox.</span>
      </p>
      {done ? (
        <>
          <p style={{ fontSize: 13 }}>
            Attached to <strong>{client?.name}</strong> and removed from the outbox.
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={onClose}>Done</Button>
          </div>
        </>
      ) : (
        <>
          <label style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>
            Client
            <input
              value={client ? client.name : q}
              onChange={(e) => {
                setClient(null);
                setQ(e.target.value);
              }}
              placeholder="Search by name or Client ID…"
              style={{
                display: 'block',
                width: '100%',
                marginTop: 4,
                padding: '8px 10px',
                fontSize: 13,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: 6,
                background: tokens.color.surface,
                color: tokens.color.text,
              }}
            />
          </label>
          {!client && hits.length > 0 && (
            <ul
              style={{
                listStyle: 'none',
                margin: '0 0 12px',
                padding: 0,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: 6,
                maxHeight: 180,
                overflowY: 'auto',
              }}
            >
              {hits.map((h) => (
                <li key={h.id}>
                  <button
                    type="button"
                    onClick={() => setClient(h)}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      width: '100%',
                      textAlign: 'left',
                      padding: '6px 10px',
                      fontSize: 13,
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: tokens.color.text,
                    }}
                  >
                    <span>{h.name}</span>
                    {h.externalId && (
                      <span style={{ color: tokens.color.textMuted }}>{h.externalId}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <label style={{ display: 'block', fontSize: 12, margin: '8px 0 16px' }}>
            File type
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as typeof category)}
              style={{
                display: 'block',
                marginTop: 4,
                padding: '6px 8px',
                fontSize: 13,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: 6,
                background: tokens.color.surface,
                color: tokens.color.text,
              }}
            >
              <option value="other">Other (routes to the client&apos;s default subfolder)</option>
              <option value="correspondence">Correspondence</option>
            </select>
          </label>
          {error && (
            <p style={{ color: tokens.color.danger, fontSize: 12, margin: '0 0 12px' }}>{error}</p>
          )}
          <div style={{ display: 'flex', gap: tokens.space.sm, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => void discard()} disabled={busy}>
              Delete file
            </Button>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Later
            </Button>
            <Button onClick={() => void attach()} disabled={busy || !client}>
              {busy ? 'Uploading…' : 'Attach to client'}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
