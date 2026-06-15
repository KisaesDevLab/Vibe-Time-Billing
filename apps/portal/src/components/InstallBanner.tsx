// SPDX-License-Identifier: Elastic-2.0
//
// Subtle "Install app" banner shown on authenticated portal pages after a few
// visits. Android/desktop Chromium get a one-tap install (beforeinstallprompt);
// iOS Safari gets "Add to Home Screen" instructions (no install API there).

import { useEffect, useState } from 'react';

import { Button, tokens } from '@vibe/ui';

import { canInstall, isIos, isStandalone, promptInstall } from '../pwa';

const DISMISS_KEY = '__vibe_portal_install_dismissed';
const VISITS_KEY = '__vibe_portal_visits';
const MIN_VISITS = 3;

function bumpVisits(): number {
  try {
    const n = (parseInt(localStorage.getItem(VISITS_KEY) ?? '0', 10) || 0) + 1;
    localStorage.setItem(VISITS_KEY, String(n));
    return n;
  } catch {
    return 0;
  }
}

export function InstallBanner(): JSX.Element | null {
  const [show, setShow] = useState(false);
  const [installable, setInstallable] = useState(canInstall());

  useEffect(() => {
    if (isStandalone()) return;
    try {
      if (localStorage.getItem(DISMISS_KEY) === '1') return;
    } catch {
      /* ignore */
    }
    const visits = bumpVisits();
    const onInstallable = (): void => setInstallable(true);
    window.addEventListener('pwa:installable', onInstallable);
    // Show once we have enough visits AND we can either prompt (Android/desktop)
    // or guide the user (iOS).
    if (visits >= MIN_VISITS && (canInstall() || isIos())) setShow(true);
    return () => window.removeEventListener('pwa:installable', onInstallable);
  }, []);

  useEffect(() => {
    if (installable && !isStandalone()) {
      try {
        if (localStorage.getItem(DISMISS_KEY) !== '1') setShow(true);
      } catch {
        setShow(true);
      }
    }
  }, [installable]);

  if (!show) return null;

  function dismiss(): void {
    setShow(false);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* ignore */
    }
  }

  async function install(): Promise<void> {
    const ok = await promptInstall();
    if (ok) dismiss();
  }

  return (
    <div
      role="region"
      aria-label="Install app"
      style={{
        marginBottom: 12,
        padding: '10px 14px',
        background: 'rgba(15, 108, 189, 0.10)',
        border: `1px solid ${tokens.color.accent}`,
        borderRadius: tokens.radius.sm,
        color: tokens.color.text,
        fontSize: 13,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
      }}
    >
      <span style={{ fontWeight: 600 }}>📲 Install this portal</span>
      {isIos() && !installable ? (
        <span style={{ color: tokens.color.textMuted }}>
          Tap the Share button, then “Add to Home Screen” to keep it one tap away (and enable
          notifications).
        </span>
      ) : (
        <span style={{ color: tokens.color.textMuted }}>
          Add it to your home screen for one-tap access and notifications.
        </span>
      )}
      <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
        {installable && (
          <Button size="sm" onClick={() => void install()}>
            Install
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={dismiss}>
          Not now
        </Button>
      </span>
    </div>
  );
}
