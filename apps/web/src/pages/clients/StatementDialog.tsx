// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Generate a statement of account for a client. Two modes: outstanding
// balances (with aging) or account activity for a date range (opening →
// closing balance). Opens the rendered PDF in a new tab via the staff
// statements endpoint.

import { useState } from 'react';

import { Button, Card, tokens } from '@vibe/ui';

interface Props {
  clientId: string;
  clientName: string;
  onClose: () => void;
}

function startOfYear(): string {
  return `${new Date().getFullYear()}-01-01`;
}
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const fieldStyle: React.CSSProperties = {
  padding: '6px 10px',
  background: tokens.color.surface,
  color: tokens.color.text,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  fontSize: 13,
};

export function StatementDialog({ clientId, clientName, onClose }: Props): JSX.Element {
  const [mode, setMode] = useState<'outstanding' | 'activity'>('outstanding');
  const [start, setStart] = useState(startOfYear());
  const [end, setEnd] = useState(today());
  const [error, setError] = useState<string | null>(null);

  function openPdf(): void {
    if (mode === 'activity') {
      if (!start || !end) {
        setError('Choose a start and end date.');
        return;
      }
      if (start > end) {
        setError('Start date must be on or before the end date.');
        return;
      }
    }
    const params = new URLSearchParams({ accept: 'pdf' });
    if (mode === 'activity') {
      params.set('mode', 'activity');
      params.set('start', start);
      params.set('end', end);
    }
    window.open(
      `/api/staff/statements/clients/${clientId}?${params.toString()}`,
      '_blank',
      'noopener,noreferrer',
    );
    onClose();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Generate statement for ${clientName}`}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 64,
        zIndex: 200,
      }}
    >
      <div style={{ width: 460, maxWidth: '92vw' }}>
        <Card title={`Generate statement — ${clientName}`}>
          {error && (
            <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
              {error}
            </p>
          )}
          <div style={{ display: 'grid', gap: 12 }}>
            <div>
              <label
                htmlFor="stmt-mode-outstanding"
                style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}
              >
                <input
                  id="stmt-mode-outstanding"
                  type="radio"
                  name="stmt-mode"
                  checked={mode === 'outstanding'}
                  onChange={() => setMode('outstanding')}
                />
                <strong>Outstanding balances</strong>
              </label>
              <div style={{ color: tokens.color.textMuted, fontSize: 12, paddingLeft: 24 }}>
                All open invoices with aging buckets, as of today.
              </div>
            </div>
            <div>
              <label
                htmlFor="stmt-mode-activity"
                style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}
              >
                <input
                  id="stmt-mode-activity"
                  type="radio"
                  name="stmt-mode"
                  checked={mode === 'activity'}
                  onChange={() => setMode('activity')}
                />
                <strong>Account activity (date range)</strong>
              </label>
              <div style={{ color: tokens.color.textMuted, fontSize: 12, paddingLeft: 24 }}>
                Opening balance, every charge and payment in the range, closing balance.
              </div>
            </div>

            {mode === 'activity' && (
              <div style={{ display: 'flex', gap: 12, paddingLeft: 24, flexWrap: 'wrap' }}>
                <label style={{ fontSize: 12, display: 'grid', gap: 4 }}>
                  From
                  <input
                    type="date"
                    value={start}
                    onChange={(e) => setStart(e.target.value)}
                    style={fieldStyle}
                  />
                </label>
                <label style={{ fontSize: 12, display: 'grid', gap: 4 }}>
                  To
                  <input
                    type="date"
                    value={end}
                    onChange={(e) => setEnd(e.target.value)}
                    style={fieldStyle}
                  />
                </label>
              </div>
            )}

            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 8,
                justifyContent: 'flex-end',
                marginTop: 4,
              }}
            >
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={openPdf}>Open PDF</Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
