// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// "Process Project" dialog — opened from the Quick-log view. Staff pick a
// tax year (defaulted from the engagement period), delivery / documents /
// matching dropdowns, and a note, then Print. The generated PDF opens in
// a new tab (browser print). Printing a process project is NOT logged.

import { useEffect, useState } from 'react';

import { Button, Card, tokens } from '@vibe/ui';

import { api, getCsrfToken } from '../../api-client';

const BASE = '/api/staff/process-project';

// Fixed firm option lists (from the firm's PROCESS PROJECT form).
const DELIVERY_OPTIONS = [
  'Pickup Paper',
  'SafeSend',
  'Priority Mail',
  'In Office Meeting',
  'E-Sign',
  'Portal',
];
const DOCUMENTS_OPTIONS = [
  'File Folder Will Need to Scan',
  'File Folder No Scan Needed',
  'Scanned to Tax Folder',
  'Portal Folder',
];
const MATCHING_OPTIONS = [
  'I Will Bring File to match',
  'No Match Send to Client',
  'Set In Office I will Match',
  'Other See Notes',
];

export function ProcessProjectDialog({
  engagementId,
  clientName,
  engagementName,
  onClose,
}: {
  engagementId: string;
  clientName: string;
  engagementName: string;
  onClose: () => void;
}): JSX.Element {
  const [taxYear, setTaxYear] = useState('');
  const [delivery, setDelivery] = useState(DELIVERY_OPTIONS[0]!);
  const [documents, setDocuments] = useState(DOCUMENTS_OPTIONS[0]!);
  const [matching, setMatching] = useState(MATCHING_OPTIONS[0]!);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Default the tax year from the engagement's period.
  useEffect(() => {
    void api<{ taxYear: string | null }>(`${BASE}/engagement/${engagementId}/prefill`)
      .then((r) => {
        if (r.taxYear) setTaxYear(r.taxYear);
      })
      .catch(() => undefined);
  }, [engagementId]);

  async function print(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      // Raw fetch — the response is a PDF blob, not JSON.
      const res = await fetch(`${BASE}/pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() ?? '' },
        credentials: 'same-origin',
        body: JSON.stringify({ engagementId, taxYear, delivery, documents, matching, notes }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `print failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');
      // Revoke after a beat so the new tab can load it.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'print failed';
      setError(msg === 'render_failed' ? 'Could not render the PDF. Try again.' : msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Process project for ${clientName}`}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 56,
        zIndex: 200,
      }}
    >
      <div style={{ width: 'min(560px, 94vw)', maxHeight: '88vh', overflow: 'auto' }}>
        <Card title={`Process project — ${clientName}`}>
          <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 10 }}>
            {engagementName}
          </div>
          {error && (
            <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
              {error}
            </p>
          )}
          <div style={{ display: 'grid', gap: 12 }}>
            <Field label="Tax Year">
              <input
                value={taxYear}
                onChange={(e) => setTaxYear(e.target.value)}
                style={inputStyle}
                placeholder="e.g. 2025"
              />
            </Field>
            <Field label="Delivery">
              <Select value={delivery} onChange={setDelivery} options={DELIVERY_OPTIONS} />
            </Field>
            <Field label="Documents">
              <Select value={documents} onChange={setDocuments} options={DOCUMENTS_OPTIONS} />
            </Field>
            <Field label="Matching">
              <Select value={matching} onChange={setMatching} options={MATCHING_OPTIONS} />
            </Field>
            <Field label="Notes">
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={4}
                placeholder="Special instructions / handling / notes"
                style={{ ...inputStyle, resize: 'vertical' }}
              />
            </Field>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                Close
              </Button>
              <Button onClick={() => void print()} disabled={busy}>
                {busy ? 'Rendering…' : 'Print'}
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <span style={{ fontSize: 11, color: tokens.color.textMuted }}>{label}</span>
      {children}
    </div>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
}): JSX.Element {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle}>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: 8,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  background: tokens.color.bg,
  color: tokens.color.text,
  fontSize: 13,
};
