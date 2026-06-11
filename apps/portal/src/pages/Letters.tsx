// SPDX-License-Identifier: Elastic-2.0
import { useEffect, useState } from 'react';

import { Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { PayToUnlockBanner, useUnlockStatus } from '../components/PayToUnlockBanner';
import { SignaturePad } from '../components/SignaturePad';

interface Letter {
  id: string;
  version: number;
  status: string;
  sentAt: string | null;
  engagementId: string;
  engagementName: string;
}

export function LettersPage(): JSX.Element {
  const [items, setItems] = useState<Letter[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [activeLetter, setActiveLetter] = useState<Letter | null>(null);
  const [signatureSvg, setSignatureSvg] = useState<string | null>(null);
  const [signedFullName, setSignedFullName] = useState('');
  const unlock = useUnlockStatus();
  const locked = unlock.blockers.some((b) => b.gatingKind === 'EXPLICIT');

  async function load(): Promise<void> {
    try {
      const r = await api<{ items: Letter[] }>('/api/portal/letters/awaiting');
      setItems(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  function openAcceptModal(letter: Letter): void {
    setActiveLetter(letter);
    setSignatureSvg(null);
    setSignedFullName('');
    setError(null);
  }

  function closeAcceptModal(): void {
    setActiveLetter(null);
    setSignatureSvg(null);
    setSignedFullName('');
  }

  async function submitAccept(): Promise<void> {
    if (!activeLetter) return;
    if (!signedFullName.trim()) {
      setError('Please type your full name to confirm.');
      return;
    }
    setBusy(activeLetter.id);
    try {
      await api(`/api/portal/letters/${activeLetter.id}/accept`, {
        method: 'POST',
        body: JSON.stringify({
          signatureSvg: signatureSvg ?? undefined,
          signedFullName: signedFullName.trim(),
        }),
      });
      closeAcceptModal();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 900 }}>
      <PayToUnlockBanner />
      <Card title="Engagement letters awaiting your acceptance">
        {error && !activeLetter && (
          <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>
        )}
        <Table<Letter>
          columns={[
            { key: 'eng', header: 'Engagement', render: (l) => l.engagementName },
            { key: 'v', header: 'Version', align: 'right', render: (l) => `v${l.version}` },
            {
              key: 'sent',
              header: 'Sent',
              render: (l) => (l.sentAt ? new Date(l.sentAt).toLocaleString() : '—'),
            },
            {
              key: 'status',
              header: 'Status',
              render: (l) => <Pill tone="warning">{l.status}</Pill>,
            },
            {
              key: 'actions',
              header: '',
              render: (l) =>
                locked ? (
                  <Pill tone="danger">Locked — pay invoice to unlock</Pill>
                ) : (
                  <span style={{ display: 'flex', gap: 6 }}>
                    <a
                      href={`/api/portal/letters/${l.id}/render.html`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Button size="sm" variant="secondary">
                        Read
                      </Button>
                    </a>
                    <Button size="sm" onClick={() => openAcceptModal(l)}>
                      Accept
                    </Button>
                  </span>
                ),
            },
          ]}
          rows={items}
          rowKey={(l) => l.id}
          empty="No letters awaiting your acceptance."
        />
      </Card>

      {activeLetter && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="letter-accept-title"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: tokens.space.md,
          }}
        >
          <div
            style={{
              background: tokens.color.bg,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.lg,
              padding: tokens.space.lg,
              maxWidth: 560,
              width: '100%',
              maxHeight: '90vh',
              overflowY: 'auto',
            }}
          >
            <h2 id="letter-accept-title" style={{ margin: 0, fontSize: 18 }}>
              Accept engagement letter
            </h2>
            <p style={{ fontSize: 13, color: tokens.color.textMuted, marginTop: 8 }}>
              By signing below, you accept the terms of the engagement letter v
              {activeLetter.version} for <strong>{activeLetter.engagementName}</strong>. Your
              acceptance will be recorded with date, IP, and the signature you draw.
            </p>
            <div style={{ marginTop: tokens.space.md }}>
              <div
                style={{
                  fontSize: 12,
                  color: tokens.color.textMuted,
                  marginBottom: 4,
                }}
              >
                Signature
              </div>
              <SignaturePad onChange={setSignatureSvg} />
            </div>
            <div style={{ marginTop: tokens.space.md }}>
              <Input
                label="Type your full name *"
                value={signedFullName}
                onChange={(e) => setSignedFullName(e.target.value)}
                placeholder="Jane Smith"
              />
            </div>
            {error && (
              <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }}>{error}</p>
            )}
            <div
              style={{
                display: 'flex',
                gap: 8,
                justifyContent: 'flex-end',
                marginTop: tokens.space.lg,
              }}
            >
              <Button
                type="button"
                variant="ghost"
                onClick={closeAcceptModal}
                disabled={busy === activeLetter.id}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => void submitAccept()}
                disabled={busy === activeLetter.id || !signedFullName.trim()}
              >
                {busy === activeLetter.id ? 'Accepting…' : 'Accept letter'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
