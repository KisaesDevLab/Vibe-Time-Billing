// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Account → Get the desktop app. Rendered only in the browser (inside the
// Tauri shell the DesktopSettingsCard covers version/updates instead). The
// updater manifest at /desktop/latest.json is public and already carries
// absolute installer URLs, so the card is a thin view over it. Hidden
// entirely when the appliance has no release published (404 no_release).

import { useEffect, useState } from 'react';
import { Card, tokens } from '@vibe/ui';

import { isDesktop } from '../../lib/desktop';

interface Manifest {
  version?: string;
  pub_date?: string;
  platforms?: Record<string, { url?: string }>;
}

const PLATFORM_LABELS: Record<string, string> = {
  'windows-x86_64': 'Windows (64-bit)',
  'darwin-aarch64': 'macOS (Apple Silicon)',
  'darwin-x86_64': 'macOS (Intel)',
  'linux-x86_64': 'Linux (64-bit)',
};

export function DesktopDownloadCard(): JSX.Element | null {
  const [manifest, setManifest] = useState<Manifest | null>(null);

  const desktop = isDesktop();

  useEffect(() => {
    if (desktop) return;
    void fetch('/desktop/latest.json', { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) return;
        const parsed = (await res.json()) as Manifest;
        if (parsed && typeof parsed === 'object') setManifest(parsed);
      })
      .catch(() => undefined);
  }, [desktop]);

  if (desktop || !manifest) return null;

  const downloads = Object.entries(manifest.platforms ?? {}).filter(
    (entry): entry is [string, { url: string }] => typeof entry[1]?.url === 'string',
  );
  if (downloads.length === 0) return null;

  return (
    <Card title="Desktop app">
      <p style={{ fontSize: 13, color: tokens.color.textMuted, marginTop: 0 }}>
        Install the Vibe desktop app for global timer hotkeys, tray timers, UltraTax detection, and
        Windows notifications. Version {manifest.version ?? '—'}
        {manifest.pub_date ? ` · released ${new Date(manifest.pub_date).toLocaleDateString()}` : ''}
        .
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {downloads.map(([platform, { url }]) => (
          <a
            key={platform}
            href={url}
            style={{
              display: 'inline-block',
              padding: '6px 14px',
              fontSize: 13,
              fontWeight: 500,
              color: '#fff',
              background: tokens.color.accent,
              borderRadius: tokens.radius.sm,
              textDecoration: 'none',
            }}
          >
            Download for {PLATFORM_LABELS[platform] ?? platform}
          </a>
        ))}
      </div>
    </Card>
  );
}
