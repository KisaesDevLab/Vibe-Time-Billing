// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Firm branding asset uploader (wide logo or square app icon). Three-leg flow,
// mirroring the client-file upload: ask the API for a presigned PUT URL, PUT
// the file straight to storage, then POST /complete so the server records it
// (and, for the icon, resizes it into the PWA/Apple icons). Preview reads the
// public branding endpoint with a cache-bust nonce.

import { useRef, useState } from 'react';

import { Button, tokens } from '@vibe/ui';

import { api } from '../../api-client';

const ACCEPT: Record<'logo' | 'icon', string> = {
  logo: 'image/png,image/jpeg,image/svg+xml,image/webp',
  icon: 'image/png,image/jpeg,image/webp',
};

const PREVIEW_PATH: Record<'logo' | 'icon', string> = {
  logo: '/api/portal/branding/logo',
  icon: '/api/portal/branding/icon-192.png',
};

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

export function BrandingUpload({
  kind,
  label,
  help,
  onChanged,
}: {
  kind: 'logo' | 'icon';
  label: string;
  help: string;
  /** Called after a successful upload/remove so the parent can refetch
   *  settings (an uploaded logo updates brand_logo_url server-side). */
  onChanged?: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped after a successful upload/remove to refresh the <img> preview.
  const [nonce, setNonce] = useState(() => Date.now());
  const [hasAsset, setHasAsset] = useState<boolean>(true); // assume present; img onError hides
  const fileRef = useRef<HTMLInputElement>(null);

  async function upload(file: File): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('File is too large (max 5MB).');
      const dataBase64 = await readAsDataUrl(file);
      // Bytes go through the API (server stores them) — small images, and it
      // avoids any cross-origin upload constraints.
      await api(`/api/staff/admin/branding/${kind}`, {
        method: 'POST',
        body: JSON.stringify({ contentType: file.type, dataBase64 }),
      });
      setHasAsset(true);
      setNonce(Date.now());
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'upload_failed');
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/admin/branding/${kind}`, { method: 'DELETE' });
      setHasAsset(false);
      setNonce(Date.now());
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'remove_failed');
    } finally {
      setBusy(false);
    }
  }

  const previewBg = kind === 'icon' ? tokens.color.surface : 'transparent';

  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <span style={{ fontSize: 13 }}>{label}</span>
      <span style={{ fontSize: 11, color: tokens.color.textMuted }}>{help}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        {hasAsset && (
          <img
            src={`${PREVIEW_PATH[kind]}?v=${nonce}`}
            alt=""
            onError={() => setHasAsset(false)}
            style={{
              height: kind === 'icon' ? 56 : 40,
              width: kind === 'icon' ? 56 : 'auto',
              maxWidth: 200,
              objectFit: 'contain',
              background: previewBg,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: kind === 'icon' ? tokens.radius.md : tokens.radius.sm,
              padding: 4,
            }}
          />
        )}
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT[kind]}
          disabled={busy}
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
            e.target.value = '';
          }}
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          {busy ? 'Uploading…' : 'Upload'}
        </Button>
        {hasAsset && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove()}>
            Remove
          </Button>
        )}
      </div>
      {error && <span style={{ fontSize: 12, color: tokens.color.danger }}>{error}</span>}
    </div>
  );
}
