// SPDX-License-Identifier: Elastic-2.0
//
// 0150 — Public recipient landing page for a shared file
// (…/shared/file/:token). No portal auth — the token in the URL plus a
// one-time access code (emailed/texted to the share's recipient) gate
// the document. Calls /api/shared-file/:token/{meta,send-code,verify,
// content,download}; the post-verify grant rides an HttpOnly cookie set
// by the API, so this page holds no secret state.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';

import { Button, Card, Pill, tokens } from '@vibe/ui';

import { ProtectedPdfViewer } from '../components/ProtectedPdfViewer';

interface ShareFileEntry {
  fileId: string;
  fileName: string;
  isPdf: boolean;
}

interface ShareMeta {
  state: 'ok' | 'expired' | 'revoked';
  gated?: boolean;
  verified?: boolean;
  fileName?: string;
  isPdf?: boolean;
  // 0154 — combined (bundle) shares carry the full file list.
  bundle?: boolean;
  files?: ShareFileEntry[];
  accessLevel?: 'view' | 'download';
  watermark?: boolean;
  expiresAt?: string | null;
  organization?: string | null;
  channel?: 'EMAIL' | 'SMS';
  maskedDestination?: string | null;
}

interface Branding {
  displayName: string | null;
  logoUrl: string | null;
  accentColor: string | null;
}

export function SharedFilePage(): JSX.Element {
  const { token } = useParams<{ token: string }>();
  const [meta, setMeta] = useState<ShareMeta | null>(null);
  const [branding, setBranding] = useState<Branding | null>(null);
  const [pageError, setPageError] = useState<'not_found' | 'failed' | null>(null);
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const cooldownTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const base = `/api/shared-file/${encodeURIComponent(token ?? '')}`;

  const loadMeta = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`${base}/meta`, { credentials: 'same-origin' });
      if (!res.ok) {
        setPageError('not_found');
        return;
      }
      setMeta((await res.json()) as ShareMeta);
    } catch {
      setPageError('failed');
    }
  }, [base]);

  useEffect(() => {
    if (!token) return;
    void loadMeta();
    void (async () => {
      try {
        const r = await fetch('/api/portal/profile/branding');
        const j = (await r.json()) as { branding: Branding | null };
        setBranding(j.branding);
      } catch {
        // branding is optional
      }
    })();
  }, [token, loadMeta]);

  useEffect(() => {
    return () => {
      if (cooldownTimer.current) clearInterval(cooldownTimer.current);
    };
  }, []);

  // This is a public landing page for external recipients, not a portal
  // user browsing the dark-themed app. Force a clean light theme (all
  // @vibe/ui tokens resolve from data-theme on <html>) so the shared
  // document reads like a printable page. Restore on unmount.
  useEffect(() => {
    const el = document.documentElement;
    const prev = el.dataset.theme;
    el.dataset.theme = 'light';
    return () => {
      if (prev) el.dataset.theme = prev;
      else delete el.dataset.theme;
    };
  }, []);

  function startCooldown(seconds: number): void {
    setCooldown(seconds);
    if (cooldownTimer.current) clearInterval(cooldownTimer.current);
    cooldownTimer.current = setInterval(() => {
      setCooldown((c) => {
        if (c <= 1 && cooldownTimer.current) clearInterval(cooldownTimer.current);
        return Math.max(0, c - 1);
      });
    }, 1000);
  }

  async function sendCode(): Promise<void> {
    setBusy(true);
    setVerifyError(null);
    try {
      const res = await fetch(`${base}/send-code`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      const body = (await res.json()) as {
        ok?: boolean;
        maskedDestination?: string;
        retryAfterSeconds?: number;
        error?: string;
      };
      if (res.ok && body.ok) {
        setCodeSentTo(body.maskedDestination ?? 'your contact on file');
        startCooldown(60);
      } else if (body.error === 'cooldown') {
        setCodeSentTo((prev) => prev ?? 'your contact on file');
        startCooldown(body.retryAfterSeconds ?? 60);
      } else if (body.error === 'too_many_codes') {
        setVerifyError('Too many codes requested. Try again later or ask the sender to reshare.');
      } else {
        setVerifyError('Could not send the code. Please try again or contact the sender.');
      }
    } catch {
      setVerifyError('Could not send the code. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function verify(): Promise<void> {
    setBusy(true);
    setVerifyError(null);
    try {
      const res = await fetch(`${base}/verify`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim() }),
      });
      if (res.ok) {
        setCode('');
        await loadMeta();
        return;
      }
      const body = (await res.json()) as { error?: string; attemptsRemaining?: number };
      if (body.error === 'invalid_code') {
        setVerifyError(
          `That code is not correct. ${body.attemptsRemaining ?? 0} attempt${
            (body.attemptsRemaining ?? 0) === 1 ? '' : 's'
          } remaining.`,
        );
      } else if (body.error === 'locked') {
        setLocked(true);
      } else if (body.error === 'no_active_code') {
        setVerifyError('That code has expired. Request a new one.');
      } else {
        setVerifyError('Verification failed. Please try again.');
      }
    } catch {
      setVerifyError('Verification failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const accent = branding?.accentColor ?? tokens.color.accent;
  const firmLabel = branding?.displayName ?? 'Secure document share';

  const shell = (children: JSX.Element): JSX.Element => (
    <div style={{ maxWidth: 980, margin: '0 auto', padding: tokens.space.lg }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '12px 0',
          marginBottom: tokens.space.md,
          borderBottom: `2px solid ${accent}`,
        }}
      >
        {branding?.logoUrl && (
          <img src={branding.logoUrl} alt="" style={{ height: 28, maxWidth: 140 }} />
        )}
        <span style={{ fontSize: 16, fontWeight: 600, color: tokens.color.text }}>{firmLabel}</span>
        <span style={{ marginLeft: 'auto' }}>
          <Pill tone="accent">secure share</Pill>
        </span>
      </div>
      {children}
    </div>
  );

  if (pageError) {
    return shell(
      <Card title="Link unavailable">
        <p style={{ fontSize: 14, color: tokens.color.textMuted }}>
          This link is invalid. Please ask the sender for a new link.
        </p>
      </Card>,
    );
  }
  if (locked) {
    return shell(
      <Card title="Access locked">
        <p style={{ fontSize: 14, color: tokens.color.textMuted }}>
          Too many incorrect codes were entered, so this link has been locked. Please contact the
          sender and ask them to share the document again.
        </p>
      </Card>,
    );
  }
  if (!meta) {
    return shell(
      <Card title="Loading…">
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>One moment.</p>
      </Card>,
    );
  }
  if (meta.state === 'expired') {
    return shell(
      <Card title="Link expired">
        <p style={{ fontSize: 14, color: tokens.color.textMuted }}>
          This link has expired. Please ask the sender to share the document again.
        </p>
      </Card>,
    );
  }
  if (meta.state === 'revoked') {
    return shell(
      <Card title="Link revoked">
        <p style={{ fontSize: 14, color: tokens.color.textMuted }}>
          This link is no longer active. Please contact the sender if you still need the document.
        </p>
      </Card>,
    );
  }

  const expiryLine = meta.expiresAt
    ? `Available until ${new Date(meta.expiresAt).toLocaleDateString()}`
    : 'Available until revoked';

  // ---- Verified (or legacy ungated): show the document(s). ----
  if (meta.verified) {
    const isBundle = Boolean(meta.bundle) && (meta.files?.length ?? 0) > 1;
    const canDownload = meta.accessLevel === 'download';
    const header = (
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        {meta.organization && <Pill tone="accent">{meta.organization}</Pill>}
        <Pill tone={canDownload ? 'success' : 'neutral'}>
          {canDownload ? 'Download enabled' : 'View only'}
        </Pill>
        <span style={{ fontSize: 12, color: tokens.color.textMuted, alignSelf: 'center' }}>
          {expiryLine}
        </span>
      </div>
    );
    const watermarkNote = meta.watermark ? (
      <p style={{ fontSize: 11, color: tokens.color.textMuted, marginTop: 0 }}>
        These documents are watermarked and access is logged.
      </p>
    ) : null;

    if (isBundle) {
      const files = meta.files ?? [];
      return shell(
        <div style={{ display: 'grid', gap: tokens.space.lg }}>
          <Card title={`Shared documents (${files.length})`}>
            {header}
            {watermarkNote}
            <div style={{ display: 'grid', gap: 8 }}>
              {files.map((f) => {
                const q = `fileId=${encodeURIComponent(f.fileId)}`;
                return (
                  <div
                    key={f.fileId}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                      padding: '10px 12px',
                      border: `1px solid ${tokens.color.border}`,
                      borderRadius: tokens.radius.sm,
                    }}
                  >
                    <span style={{ fontSize: 13, wordBreak: 'break-all' }}>{f.fileName}</span>
                    <span style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                      <a href={`${base}/content?${q}`} target="_blank" rel="noreferrer">
                        <Button variant="secondary">Open</Button>
                      </a>
                      {canDownload && (
                        <a href={`${base}/download?${q}`}>
                          <Button>Download</Button>
                        </a>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>,
      );
    }

    // Single file — first entry's id keeps the URL explicit (also valid
    // for legacy single shares, which default to the share's one file).
    const only = meta.files?.[0];
    const q = only ? `?fileId=${encodeURIComponent(only.fileId)}` : '';
    const downloadHref = `${base}/download${q}`;
    const contentHref = `${base}/content${q}`;
    // Prominent, solid primary action at the TOP of the card so the
    // recipient can't miss it. Shown whenever there's an explicit action:
    // any download, or a non-PDF that has no inline viewer. A PDF that is
    // view-only relies on the viewer below (no top button needed).
    const showTopAction = canDownload || !meta.isPdf;
    const topAction = showTopAction ? (
      <div style={{ marginBottom: tokens.space.md }}>
        <a
          href={canDownload ? downloadHref : contentHref}
          {...(canDownload
            ? { download: meta.fileName ?? true }
            : { target: '_blank', rel: 'noreferrer' })}
          style={{ textDecoration: 'none' }}
        >
          <Button variant="primary" style={{ padding: '12px 24px', fontSize: 15, fontWeight: 600 }}>
            {canDownload ? `⬇  Download ${meta.isPdf ? 'PDF' : 'file'}` : 'Open file'}
          </Button>
        </a>
      </div>
    ) : null;
    return shell(
      <div style={{ display: 'grid', gap: tokens.space.lg }}>
        <Card title={meta.fileName ?? 'Shared document'}>
          {header}
          {topAction}
          {watermarkNote}
          {meta.isPdf && (
            <ProtectedPdfViewer
              url={contentHref}
              downloadUrl={downloadHref}
              canDownload={canDownload}
              filename={meta.fileName ?? 'document.pdf'}
            />
          )}
        </Card>
      </div>,
    );
  }

  // ---- Gated and not yet verified: the access-code flow. ----
  return shell(
    <Card title={meta.fileName ?? 'Shared document'}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        {meta.organization && <Pill tone="accent">{meta.organization}</Pill>}
        <span style={{ fontSize: 12, color: tokens.color.textMuted, alignSelf: 'center' }}>
          {expiryLine}
        </span>
      </div>
      <p style={{ fontSize: 14, color: tokens.color.text }}>
        To protect this document, a one-time access code is required.
      </p>
      {codeSentTo === null ? (
        <div style={{ display: 'grid', gap: 8, maxWidth: 380 }}>
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
            We&apos;ll send a 6-digit code to <strong>{meta.maskedDestination ?? 'you'}</strong>
            {meta.channel === 'SMS' ? ' by text message.' : ' by email.'}
          </p>
          <Button onClick={() => void sendCode()} disabled={busy}>
            {busy ? 'Sending…' : 'Send access code'}
          </Button>
          {verifyError && (
            <p style={{ fontSize: 12, color: tokens.color.danger, margin: 0 }}>{verifyError}</p>
          )}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8, maxWidth: 380 }}>
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
            Code sent to <strong>{codeSentTo}</strong>. It expires in 10 minutes.
          </p>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            placeholder="Enter 6-digit code"
            aria-label="Access code"
            style={{
              padding: '10px 12px',
              fontSize: 20,
              letterSpacing: 6,
              textAlign: 'center',
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.md,
              background: tokens.color.surface,
              color: tokens.color.text,
            }}
          />
          <Button onClick={() => void verify()} disabled={busy || code.length !== 6}>
            {busy ? 'Verifying…' : 'Verify code'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void sendCode()}
            disabled={busy || cooldown > 0}
          >
            {cooldown > 0 ? `Resend code (${cooldown}s)` : 'Resend code'}
          </Button>
          {verifyError && (
            <p style={{ fontSize: 12, color: tokens.color.danger, margin: 0 }}>{verifyError}</p>
          )}
        </div>
      )}
    </Card>,
  );
}
