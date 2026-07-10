/* eslint-disable jsx-a11y/label-has-associated-control -- labels sit next to their controls inside grid containers, matching the sibling Clients.tsx dialogs; revisit with htmlFor/id in a polish pass */
// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Mail merge — pick a firm letter template, preview it against the first
// selected client, then deliver the personalized letters one of three
// ways: download a single combined PDF (a page-run per client), save a
// PDF into each client's Files folder, or email each client their letter
// as a PDF attachment. Modeled on BulkEmailDialog.

import { useEffect, useState } from 'react';

import { Button, Card, tokens } from '@vibe/ui';

import { api, getCsrfToken } from '../../api-client';

interface LetterTemplate {
  id: string;
  name: string;
  engagementTypeId: string | null;
}

interface MailMergeTarget {
  /** Client id (all modes carry it for labeling). */
  id: string;
  name: string;
  /** Set in appointments mode — the selected appointment id. */
  appointmentId?: string;
  /** Set in engagements mode — the selected engagement id. */
  engagementId?: string;
}

// Unified per-client outcome view, shared by Save-to-Files and Email.
interface RunResult {
  title: string;
  rows: Array<{ clientId: string; clientName: string; ok: boolean; detail: string }>;
}

const inputStyle = {
  padding: '8px 10px',
  fontSize: 13,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  background: tokens.color.bg,
  color: tokens.color.text,
} as const;

export function MailMergeDialog({
  targets,
  mode = 'clients',
  onClose,
  onDone,
}: {
  targets: MailMergeTarget[];
  /** 'appointments' → one letter per selected appointment; 'engagements' →
   *  one per engagement (pulls its drop-off date + in-range appointment);
   *  'clients' → one per client. */
  mode?: 'clients' | 'appointments' | 'engagements';
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const [templates, setTemplates] = useState<LetterTemplate[] | null>(null);
  const [templateId, setTemplateId] = useState<string>('');
  const [subject, setSubject] = useState('');
  const [coverNote, setCoverNote] = useState('');
  // Engagements mode — optional appointment date-range filter.
  const [apptFrom, setApptFrom] = useState('');
  const [apptTo, setApptTo] = useState('');
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);

  const noun =
    mode === 'appointments' ? 'appointment' : mode === 'engagements' ? 'engagement' : 'client';
  // Only the first target drives the live preview; depend on its stable id
  // (not the array identity, which changes every parent render → refetch spam).
  const previewId =
    mode === 'appointments'
      ? targets[0]?.appointmentId
      : mode === 'engagements'
        ? targets[0]?.engagementId
        : targets[0]?.id;
  const rangeInvalid = Boolean(mode === 'engagements' && apptFrom && apptTo && apptFrom > apptTo);

  // The batch's target field per mode, plus the engagements-only date range.
  const targetPayload: Record<string, unknown> =
    mode === 'appointments'
      ? {
          appointmentIds: targets
            .map((t) => t.appointmentId)
            .filter((x): x is string => Boolean(x)),
        }
      : mode === 'engagements'
        ? {
            engagementIds: targets
              .map((t) => t.engagementId)
              .filter((x): x is string => Boolean(x)),
            ...(apptFrom ? { apptFrom } : {}),
            ...(apptTo ? { apptTo } : {}),
          }
        : { clientIds: targets.map((t) => t.id) };
  // Load the active letter templates once.
  useEffect(() => {
    api<{ items: LetterTemplate[] }>('/api/staff/clients/mail-merge-templates')
      .then((r) => setTemplates(r.items))
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load templates'));
  }, []);

  // Refresh the preview whenever the chosen template changes.
  useEffect(() => {
    if (!templateId || targets.length === 0 || rangeInvalid) {
      setPreviewHtml(null);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    setError(null);
    const previewTarget =
      mode === 'appointments'
        ? { appointmentId: targets[0]?.appointmentId }
        : mode === 'engagements'
          ? {
              engagementId: targets[0]?.engagementId,
              ...(apptFrom ? { apptFrom } : {}),
              ...(apptTo ? { apptTo } : {}),
            }
          : { clientId: targets[0]?.id };
    api<{ html: string }>('/api/staff/clients/mail-merge-preview', {
      method: 'POST',
      body: JSON.stringify({ templateId, ...previewTarget }),
    })
      .then((r) => {
        if (!cancelled) setPreviewHtml(r.html);
      })
      .catch((e) => {
        if (cancelled) return;
        // In engagements mode with a date range, the first engagement may
        // have no in-range appointment (it'll be skipped in the run) — show
        // an informational preview instead of a scary error.
        const msg = e instanceof Error ? e.message : 'Preview failed';
        if (mode === 'engagements' && (apptFrom || apptTo) && msg === 'client_not_found') {
          setPreviewHtml(
            '<p style="font:13px sans-serif;color:#888;padding:16px">The first selected engagement has no appointment in this date range, so it would be skipped. Engagements with an in-range appointment will still generate letters.</p>',
          );
        } else {
          setError(msg);
        }
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Depend on the derived previewId (stable), not the targets array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, previewId, mode, apptFrom, apptTo, rangeInvalid]);

  async function downloadPdf(): Promise<void> {
    if (!templateId) {
      setError('Choose a letter template.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/staff/clients/mail-merge-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() ?? '' },
        credentials: 'same-origin',
        body: JSON.stringify({ templateId, ...targetPayload }),
      });
      if (!res.ok) {
        let reason = res.statusText;
        try {
          const j = (await res.json()) as { error?: string };
          if (j.error) reason = j.error;
        } catch {
          /* ignore */
        }
        throw new Error(reason);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'mail-merge-letters.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke on the next tick — some browsers cancel the download if the
      // object URL is revoked in the same synchronous frame as click().
      setTimeout(() => URL.revokeObjectURL(url), 0);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setBusy(false);
    }
  }

  async function saveToFiles(): Promise<void> {
    if (!templateId) {
      setError('Choose a letter template.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{
        results: Array<{
          clientId: string;
          clientName: string;
          saved: boolean;
          reason: string | null;
        }>;
        summary: { saved: number; skipped: number };
      }>('/api/staff/clients/mail-merge-save-to-files', {
        method: 'POST',
        body: JSON.stringify({ templateId, ...targetPayload }),
      });
      setResult({
        title: `${r.summary.saved} saved to Files · ${r.summary.skipped} skipped.`,
        rows: r.results.map((x) => ({
          clientId: x.clientId,
          clientName: x.clientName,
          ok: x.saved,
          detail: x.saved ? 'saved' : (x.reason ?? 'unknown'),
        })),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  async function emailLetters(): Promise<void> {
    if (!templateId) {
      setError('Choose a letter template.');
      return;
    }
    if (!subject.trim()) {
      setError('An email subject is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{
        results: Array<{
          clientId: string;
          clientName: string;
          sent: boolean;
          to: string | null;
          reason: string | null;
        }>;
        summary: { sent: number; skipped: number };
      }>('/api/staff/clients/mail-merge-email', {
        method: 'POST',
        body: JSON.stringify({
          templateId,
          ...targetPayload,
          subject: subject.trim(),
          body: coverNote.trim() || undefined,
        }),
      });
      setResult({
        title: `${r.summary.sent} emailed · ${r.summary.skipped} skipped.`,
        rows: r.results.map((x) => ({
          clientId: x.clientId,
          clientName: x.clientName,
          ok: x.sent,
          detail: x.sent ? `sent to ${x.to}` : (x.reason ?? 'unknown'),
        })),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Email failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
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
      <div
        style={{ width: 'min(900px, 94vw)', maxWidth: 900, maxHeight: '90vh', overflow: 'auto' }}
      >
        <Card title="Mail merge letter">
          {result ? (
            <div style={{ display: 'grid', gap: 10 }}>
              <p style={{ fontSize: 13, margin: 0 }}>
                <strong>Done.</strong> {result.title}
              </p>
              <ul
                style={{
                  margin: 0,
                  padding: '8px 16px',
                  background: tokens.color.surface,
                  borderRadius: tokens.radius.sm,
                  fontSize: 12,
                  maxHeight: 300,
                  overflow: 'auto',
                }}
              >
                {result.rows.map((r, i) => (
                  <li key={`${r.clientId}-${i}`} style={{ marginBottom: 4 }}>
                    <strong>{r.clientName}</strong> —{' '}
                    <span style={{ color: r.ok ? tokens.color.success : tokens.color.warning }}>
                      {r.ok ? r.detail : `skipped (${r.detail})`}
                    </span>
                  </li>
                ))}
              </ul>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <Button onClick={onDone}>Done</Button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 12 }}>
              <p style={{ fontSize: 13, margin: 0 }}>
                Generate a personalized letter for each of <strong>{targets.length}</strong>{' '}
                selected {noun}
                {targets.length === 1 ? '' : 's'} — download one combined PDF, save a copy to each
                client&apos;s Files, or email each client their letter as a PDF.
              </p>
              <div style={{ display: 'grid', gap: 4 }}>
                <label style={{ fontSize: 11, color: tokens.color.textMuted }}>
                  Letter template
                </label>
                <select
                  value={templateId}
                  onChange={(e) => setTemplateId(e.target.value)}
                  style={inputStyle}
                >
                  <option value="">
                    {templates === null ? 'Loading templates…' : 'Select a template…'}
                  </option>
                  {(templates ?? []).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                {templates !== null && templates.length === 0 && (
                  <span style={{ fontSize: 11, color: tokens.color.warning }}>
                    No letter templates yet — create one in Admin → Templates → Letter.
                  </span>
                )}
              </div>

              {mode === 'engagements' && (
                <div style={{ display: 'grid', gap: 4 }}>
                  <label style={{ fontSize: 11, color: tokens.color.textMuted }}>
                    Appointment date range (optional) — only an appointment starting in this range
                    fills the <code>{'{{ appointment.* }}'}</code> tokens
                  </label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      type="date"
                      value={apptFrom}
                      onChange={(e) => setApptFrom(e.target.value)}
                      style={inputStyle}
                    />
                    <span style={{ fontSize: 12, color: tokens.color.textMuted }}>to</span>
                    <input
                      type="date"
                      value={apptTo}
                      onChange={(e) => setApptTo(e.target.value)}
                      style={inputStyle}
                    />
                  </div>
                  {rangeInvalid && (
                    <span style={{ fontSize: 11, color: tokens.color.danger }}>
                      The start date must be on or before the end date.
                    </span>
                  )}
                </div>
              )}

              <div style={{ display: 'grid', gap: 4 }}>
                <label style={{ fontSize: 11, color: tokens.color.textMuted }}>
                  Preview — {targets[0]?.name ?? 'first client'}
                </label>
                <iframe
                  title="Letter preview"
                  srcDoc={
                    previewLoading
                      ? '<p style="font:13px sans-serif;color:#888;padding:16px">Loading preview…</p>'
                      : (previewHtml ??
                        '<p style="font:13px sans-serif;color:#888;padding:16px">Pick a template to preview.</p>')
                  }
                  style={{
                    width: '100%',
                    height: 320,
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.sm,
                    background: '#fff',
                  }}
                />
              </div>

              <details>
                <summary style={{ fontSize: 12, color: tokens.color.textMuted, cursor: 'pointer' }}>
                  Email options (only used for the Email action)
                </summary>
                <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                  <div style={{ display: 'grid', gap: 4 }}>
                    <label style={{ fontSize: 11, color: tokens.color.textMuted }}>
                      Email subject
                    </label>
                    <input
                      type="text"
                      value={subject}
                      onChange={(e) => setSubject(e.target.value)}
                      placeholder="e.g. A letter from {{ firm.name }}"
                      style={inputStyle}
                    />
                  </div>
                  <div style={{ display: 'grid', gap: 4 }}>
                    <label style={{ fontSize: 11, color: tokens.color.textMuted }}>
                      Cover note (optional)
                    </label>
                    <textarea
                      value={coverNote}
                      onChange={(e) => setCoverNote(e.target.value)}
                      rows={3}
                      placeholder="Short message shown in the email body; the letter is attached as a PDF."
                      style={{ ...inputStyle, resize: 'vertical' }}
                    />
                    <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                      Subject and note support tokens like <code>{'{{ client.name }}'}</code>.
                    </span>
                  </div>
                </div>
              </details>

              {error && (
                <p style={{ color: tokens.color.danger, fontSize: 12, margin: 0 }} role="alert">
                  {error}
                </p>
              )}
              <div
                style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}
              >
                <Button variant="ghost" onClick={onClose} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy || !templateId || rangeInvalid}
                  onClick={() => void saveToFiles()}
                >
                  {busy ? 'Working…' : `Save to Files (${targets.length})`}
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy || !templateId || !subject.trim() || rangeInvalid}
                  onClick={() => void emailLetters()}
                >
                  {busy ? 'Working…' : `Email (${targets.length})`}
                </Button>
                <Button
                  disabled={busy || !templateId || rangeInvalid}
                  onClick={() => void downloadPdf()}
                >
                  {busy ? 'Working…' : `Download PDF (${targets.length})`}
                </Button>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
