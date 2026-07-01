/* eslint-disable jsx-a11y/label-has-associated-control -- labels sit next to their controls inside grid containers, matching the sibling Clients.tsx dialogs; revisit with htmlFor/id in a polish pass */
// SPDX-License-Identifier: Elastic-2.0
//
// Mail merge — pick a firm letter template, preview it against the first
// selected client, then download one combined PDF (a page-run per
// client). Modeled on BulkEmailDialog. Phase 1 output is download-only;
// Save-to-Files and Email land in later phases.

import { useEffect, useState } from 'react';

import { Button, Card, tokens } from '@vibe/ui';

import { api, getCsrfToken } from '../../api-client';

interface LetterTemplate {
  id: string;
  name: string;
  engagementTypeId: string | null;
}

interface MailMergeTarget {
  id: string;
  name: string;
}

export function MailMergeDialog({
  targets,
  onClose,
  onDone,
}: {
  targets: MailMergeTarget[];
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const [templates, setTemplates] = useState<LetterTemplate[] | null>(null);
  const [templateId, setTemplateId] = useState<string>('');
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the active letter templates once.
  useEffect(() => {
    api<{ items: LetterTemplate[] }>('/api/staff/clients/mail-merge-templates')
      .then((r) => setTemplates(r.items))
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load templates'));
  }, []);

  // Refresh the preview whenever the chosen template changes.
  useEffect(() => {
    if (!templateId || targets.length === 0) {
      setPreviewHtml(null);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    setError(null);
    api<{ html: string }>('/api/staff/clients/mail-merge-preview', {
      method: 'POST',
      body: JSON.stringify({ templateId, clientId: targets[0]!.id }),
    })
      .then((r) => {
        if (!cancelled) setPreviewHtml(r.html);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Preview failed');
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [templateId, targets]);

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
        body: JSON.stringify({ templateId, clientIds: targets.map((t) => t.id) }),
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
      URL.revokeObjectURL(url);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed');
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
          <div style={{ display: 'grid', gap: 12 }}>
            <p style={{ fontSize: 13, margin: 0 }}>
              Generate a personalized letter for each of <strong>{targets.length}</strong> selected
              client{targets.length === 1 ? '' : 's'} and download them as one combined PDF (one
              page-run per client).
            </p>
            <div style={{ display: 'grid', gap: 4 }}>
              <label style={{ fontSize: 11, color: tokens.color.textMuted }}>Letter template</label>
              <select
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                style={{
                  padding: '8px 10px',
                  fontSize: 13,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.sm,
                  background: tokens.color.bg,
                  color: tokens.color.text,
                }}
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
                  height: 360,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.sm,
                  background: '#fff',
                }}
              />
            </div>

            {error && (
              <p style={{ color: tokens.color.danger, fontSize: 12, margin: 0 }} role="alert">
                {error}
              </p>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button disabled={busy || !templateId} onClick={() => void downloadPdf()}>
                {busy ? 'Generating…' : `Download PDF (${targets.length})`}
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
