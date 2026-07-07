// SPDX-License-Identifier: Elastic-2.0
//
// Capture Client Info — desktop-only modal. Lists on-screen windows, captures
// the chosen one (silently, in-memory), sends the PNG to the local GLM-OCR
// endpoint, and shows a confirm-before-fill summary of what will be pushed
// into the New Client wizard. Nothing is saved here: "Apply to form" hands the
// mapped values back to the wizard, where the user reviews, edits, and saves.

import { useEffect, useState } from 'react';

import { Button, Pill, tokens } from '@vibe/ui';

import { api, type ApiError } from '../../api-client';
import {
  captureWindow,
  isDesktop,
  listCapturableWindows,
  looksLikeUltraTax,
  type CapturableWindow,
} from '../../lib/desktop';
import { fileToPngBase64 } from '../../lib/rasterize';

export interface MappedClient {
  name: string;
  clientType: 'INDIVIDUAL' | 'BUSINESS';
  filingStatus?: 'SINGLE' | 'MFJ' | 'MFS' | 'HOH' | 'QW';
  mailingStreet1?: string;
  mailingCity?: string;
  mailingState?: string;
  mailingPostal?: string;
  mailingCountry?: string;
  customFields?: Record<string, string>;
}

export interface MappedContact {
  name: string;
  email?: string;
  phone?: string;
}

export interface MappedIntake {
  client: MappedClient;
  contact: MappedContact | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onApply: (mapped: MappedIntake) => void;
}

type Phase = 'pick' | 'preview' | 'extracting' | 'review';

const overlay: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  padding: 24,
};

const panel: React.CSSProperties = {
  width: 'min(720px, 100%)',
  maxHeight: '90vh',
  overflow: 'auto',
  background: tokens.color.surface,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.lg,
  padding: 20,
  display: 'grid',
  gap: 14,
};

function errorMessage(err: unknown): string {
  const status = (err as ApiError)?.status;
  if (status === 503) return 'OCR is not configured on this appliance (set GLM_OCR_URL).';
  if (status === 502) return 'OCR failed to read the screen. Try recapturing or crop tighter.';
  return err instanceof Error ? err.message : 'capture_failed';
}

export function CaptureClientInfo({ open, onClose, onApply }: Props): JSX.Element | null {
  const [phase, setPhase] = useState<Phase>('pick');
  const [windows, setWindows] = useState<CapturableWindow[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [pngBase64, setPngBase64] = useState<string | null>(null);
  const [intake, setIntake] = useState<MappedIntake | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPhase('pick');
    setWindows([]);
    setSelectedId(null);
    setPngBase64(null);
    setIntake(null);
    setError(null);
    // Native window enumeration only exists in the desktop shell; in the
    // browser the modal opens straight to the upload fallback.
    if (isDesktop()) void refreshWindows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function onUpload(file: File | undefined): Promise<void> {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const png = await fileToPngBase64(file);
      setPngBase64(png);
      setPhase('preview');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function refreshWindows(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const list = await listCapturableWindows();
      // UltraTax matches first, then the rest, each alphabetized by title.
      const sorted = [...list].sort((a, b) => {
        const am = looksLikeUltraTax(a) ? 0 : 1;
        const bm = looksLikeUltraTax(b) ? 0 : 1;
        return am - bm || a.title.localeCompare(b.title);
      });
      setWindows(sorted);
      const auto = sorted.find(looksLikeUltraTax);
      if (auto) setSelectedId(auto.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function capture(): Promise<void> {
    if (selectedId == null) return;
    setBusy(true);
    setError(null);
    try {
      const png = await captureWindow(selectedId);
      setPngBase64(png);
      setPhase('preview');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function extract(): Promise<void> {
    if (!pngBase64) return;
    setBusy(true);
    setError(null);
    setPhase('extracting');
    try {
      const res = await api<{ mapped: MappedIntake }>('/api/staff/ocr/client-intake', {
        method: 'POST',
        body: JSON.stringify({ imageBase64: pngBase64 }),
      });
      setIntake(res.mapped);
      setPhase('review');
    } catch (err) {
      setError(errorMessage(err));
      setPhase('preview');
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label="Capture client info">
      <div style={panel}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong style={{ fontSize: 16 }}>Capture client info</strong>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'transparent',
              border: 'none',
              fontSize: 20,
              cursor: 'pointer',
              color: tokens.color.textMuted,
            }}
          >
            ×
          </button>
        </div>

        {error && <Pill tone="danger">{error}</Pill>}

        {phase === 'pick' && (
          <>
            <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
              {isDesktop()
                ? "Pick the tax-software window showing the client's General Information screen, or upload a screenshot/PDF. The capture stays on this machine and is sent only to your local OCR server."
                : 'Upload a screenshot or a printed PDF of the client’s General Information screen. It is sent only to your local OCR server.'}
            </p>
            {isDesktop() && (
              <>
                <div style={{ display: 'grid', gap: 6, maxHeight: '46vh', overflow: 'auto' }}>
                  {windows.map((w) => (
                    <button
                      key={w.id}
                      type="button"
                      onClick={() => setSelectedId(w.id)}
                      style={{
                        textAlign: 'left',
                        padding: '10px 12px',
                        border: `2px solid ${selectedId === w.id ? tokens.color.accent : tokens.color.border}`,
                        borderRadius: tokens.radius.md,
                        background: selectedId === w.id ? tokens.color.accentMuted : 'transparent',
                        cursor: 'pointer',
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 8,
                      }}
                    >
                      <span style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                        <span
                          style={{
                            fontSize: 13,
                            fontWeight: 600,
                            color: tokens.color.text,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {w.title || '(untitled window)'}
                        </span>
                        <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                          {w.appName} · {w.width}×{w.height}
                        </span>
                      </span>
                      {looksLikeUltraTax(w) && <Pill tone="accent">UltraTax</Pill>}
                    </button>
                  ))}
                  {!busy && windows.length === 0 && (
                    <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
                      No capturable windows found.
                    </p>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
                  <Button variant="ghost" onClick={() => void refreshWindows()} disabled={busy}>
                    Refresh
                  </Button>
                  <Button onClick={() => void capture()} disabled={busy || selectedId == null}>
                    {busy ? 'Capturing…' : 'Capture'}
                  </Button>
                </div>
              </>
            )}

            <label
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'center',
                padding: 12,
                border: `1px dashed ${tokens.color.border}`,
                borderRadius: tokens.radius.md,
                cursor: busy ? 'default' : 'pointer',
                fontSize: 13,
                color: tokens.color.text,
              }}
            >
              <span aria-hidden>📄</span>
              <span style={{ flex: 1 }}>
                {isDesktop() ? 'Or upload a screenshot / PDF' : 'Upload a screenshot or PDF'}
                <span style={{ display: 'block', fontSize: 12, color: tokens.color.textMuted }}>
                  PNG, JPG, or a printed PDF of the General Information screen.
                </span>
              </span>
              <input
                type="file"
                accept="image/png,image/jpeg,application/pdf"
                disabled={busy}
                onChange={(e) => void onUpload(e.target.files?.[0])}
                style={{ display: 'none' }}
              />
            </label>
          </>
        )}

        {(phase === 'preview' || phase === 'extracting') && pngBase64 && (
          <>
            <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
              Confirm the capture is legible, then extract. Small or blurry text reads better if you
              capture with the window maximized.
            </p>
            <img
              src={`data:image/png;base64,${pngBase64}`}
              alt="Captured window"
              style={{
                maxWidth: '100%',
                maxHeight: '46vh',
                objectFit: 'contain',
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.md,
              }}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
              <Button variant="ghost" onClick={() => setPhase('pick')} disabled={busy}>
                Back
              </Button>
              <Button onClick={() => void extract()} disabled={busy}>
                {phase === 'extracting' ? 'Reading…' : 'Extract'}
              </Button>
            </div>
          </>
        )}

        {phase === 'review' && intake && (
          <ReviewSummary
            intake={intake}
            onBack={() => setPhase('preview')}
            onApply={() => {
              onApply(intake);
              onClose();
            }}
          />
        )}
      </div>
    </div>
  );
}

function ReviewSummary({
  intake,
  onBack,
  onApply,
}: {
  intake: MappedIntake;
  onBack: () => void;
  onApply: () => void;
}): JSX.Element {
  const { client, contact } = intake;
  const rows: Array<[string, string]> = [
    ['Type', client.clientType],
    ['Name', client.name],
    ...(client.filingStatus ? [['Filing status', client.filingStatus] as [string, string]] : []),
    ...(client.mailingStreet1 ? [['Address', client.mailingStreet1] as [string, string]] : []),
    ...(client.mailingCity || client.mailingState || client.mailingPostal
      ? ([
          [
            'City/State/ZIP',
            [client.mailingCity, client.mailingState, client.mailingPostal]
              .filter(Boolean)
              .join(', '),
          ],
        ] as Array<[string, string]>)
      : []),
    ...Object.entries(client.customFields ?? {}),
  ];
  if (contact) {
    rows.push([
      'Contact',
      [contact.name, contact.email, contact.phone].filter(Boolean).join(' · '),
    ]);
  }

  return (
    <>
      <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
        Review the extracted values. Applying fills the New Client form — nothing is saved until you
        click Create there. Tax IDs are never captured; enter SSN/EIN manually.
      </p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(120px, 30%) 1fr',
          gap: 8,
          fontSize: 13,
        }}
      >
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <span style={{ color: tokens.color.textMuted }}>{k}</span>
            <span style={{ color: v ? tokens.color.text : tokens.color.textMuted }}>
              {v || '—'}
            </span>
          </div>
        ))}
        {rows.length === 0 && (
          <span style={{ color: tokens.color.textMuted }}>No fields were extracted.</span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onApply} disabled={!client.name}>
          Apply to form
        </Button>
      </div>
    </>
  );
}
