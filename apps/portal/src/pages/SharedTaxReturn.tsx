// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// TR-7 — Public 3rd-party recipient page for a shared tax return.
//
// Reached via the link a client sends (…/shared/tax/:token). No portal
// auth — the token in the URL is the credential. Resolves the share, then
// renders the scoped, watermarked PDF through the same canvas viewer the
// portal uses (no download/print). Calls the public API at
// /api/shared-tax/:token{,/pdf}.

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import { Card, Pill, tokens } from '@vibe/ui';

import { ProtectedPdfViewer } from '../components/ProtectedPdfViewer';

interface ShareMeta {
  shareId: string;
  organization: string;
  recipientEmailDomain: string;
  requires2fa: boolean;
  verifyChannel: 'SMS' | 'EMAIL' | 'NONE';
  channelHint: string | null;
  accessLevel: 'view_only' | 'view_download';
  watermark: boolean;
}

export function SharedTaxReturnPage(): JSX.Element {
  const { token } = useParams<{ token: string }>();
  const [meta, setMeta] = useState<ShareMeta | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    void (async () => {
      try {
        const res = await fetch(`/api/shared-tax/${encodeURIComponent(token)}`, {
          credentials: 'same-origin',
        });
        if (!res.ok) {
          setError('not_found');
          return;
        }
        setMeta((await res.json()) as ShareMeta);
      } catch {
        setError('failed');
      }
    })();
  }, [token]);

  const shell = (children: JSX.Element): JSX.Element => (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: tokens.space.lg }}>{children}</div>
  );

  if (error) {
    return shell(
      <Card title="Link unavailable">
        <p style={{ fontSize: 14, color: tokens.color.textMuted }}>
          This link is invalid, has expired, or was revoked. Please ask the sender for a new link.
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

  return shell(
    <div style={{ display: 'grid', gap: tokens.space.lg }}>
      <Card title="Shared tax return">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          {meta.organization && <Pill tone="accent">{meta.organization}</Pill>}
          <Pill tone={meta.accessLevel === 'view_download' ? 'success' : 'neutral'}>
            {meta.accessLevel === 'view_download' ? 'Download enabled' : 'View only'}
          </Pill>
        </div>
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
          A tax return has been securely shared with you
          {meta.recipientEmailDomain ? ` (${meta.recipientEmailDomain})` : ''}. This document is
          watermarked and the access is logged.
        </p>
      </Card>

      {meta.requires2fa ? (
        <Card title="Verification required">
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
            This link requires identity verification, which isn’t available on this link yet. Please
            ask the sender to reshare without the verification requirement.
          </p>
        </Card>
      ) : (
        <Card title="Document">
          <ProtectedPdfViewer
            url={`/api/shared-tax/${encodeURIComponent(token ?? '')}/pdf`}
            canDownload={meta.accessLevel === 'view_download'}
            filename="tax-return.pdf"
          />
        </Card>
      )}
    </div>,
  );
}
