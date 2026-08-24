// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// DS-2/3/4 — Shell-level glue for the desktop app. Renders nothing in the
// browser. Inside the shell it:
//
//   - routes staff events to native toasts when the window is unfocused
//     (in-app toasts otherwise), honouring per-category mute + quiet hours
//   - keeps the taskbar/dock badge in step with the unread total
//   - turns native toast clicks and vibetb:// deep links into navigation
//   - surfaces "update available" (banner + toast) and installs on request
//   - pushes close-to-tray / autostart / outbox-watch settings into Rust
//   - opens the print-to-PDF outbox dialog when a file lands
//
// `useDesktopNotifier` is the half the Shell needs while it owns the
// event stream; `DesktopShellBridge` is the rendered half.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Modal, tokens } from '@vibe/ui';

import {
  checkForUpdate,
  clearServerUrl,
  deepLinkToPath,
  installUpdate,
  isDesktop,
  notify,
  onDeepLink,
  onMenuAbout,
  onMenuAction,
  onMenuNavigate,
  setFavorites,
  onNotificationClick,
  onOutboxFile,
  onUpdateAvailable,
  setAutostart,
  setBadge,
  setCloseToTray,
  setOutboxWatch,
  setTimerWidgetVisible,
  showMainWindow,
  type OutboxFile,
} from '../lib/desktop';
import {
  shouldNotify,
  updateDesktopSettings,
  useDesktopSettings,
  type NotifyCategory,
} from '../lib/desktop-settings';
import { useLocation } from 'react-router-dom';
import type {
  StaffAppointmentEvent,
  StaffCounts,
  StaffEventHandlers,
  StaffNotificationEvent,
} from '../lib/staff-events';
import { OutboxAttachDialog } from './OutboxAttachDialog';
import { pushToast } from './StaffToasts';

/** Window event pages can listen to for "something new arrived" (Messages
 *  refreshes its thread list on message/team events, etc.). */
export const STAFF_EVENT_WINDOW_EVENT = 'vibe:staff-event';

export function useDesktopNotifier(): StaffEventHandlers {
  const settings = useDesktopSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const desktop = isDesktop();

  const deliver = useCallback(
    (
      category: NotifyCategory,
      n: { id: string; title: string; body?: string | null; href?: string | null },
    ) => {
      window.dispatchEvent(
        new CustomEvent(STAFF_EVENT_WINDOW_EVENT, { detail: { category, ...n } }),
      );
      if (!shouldNotify(settingsRef.current, category)) return;
      const focused = typeof document !== 'undefined' && document.hasFocus();
      if (desktop && !focused) {
        void notify({ id: n.id, title: n.title, body: n.body, href: n.href, category }).catch(
          () => undefined,
        );
      } else {
        pushToast({
          id: n.id,
          title: n.title,
          body: n.body,
          href: n.href,
          tone: category === 'appointment' ? 'accent' : 'default',
        });
      }
    },
    [desktop],
  );

  return useMemo<StaffEventHandlers>(
    () => ({
      onNotification: (n: StaffNotificationEvent) =>
        deliver(n.category, { id: n.id, title: n.title, body: n.body, href: n.href }),
      onAppointment: (a: StaffAppointmentEvent) =>
        deliver('appointment', {
          id: `appt:${a.id}`,
          title: `${a.title} starts in ${a.minutesUntil} min`,
          body: new Date(a.startsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
          href: a.href,
        }),
    }),
    [deliver],
  );
}

export function DesktopShellBridge({ counts }: { counts: StaffCounts }): JSX.Element | null {
  const desktop = isDesktop();
  const settings = useDesktopSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const navigate = useNavigate();
  const location = useLocation();
  const locationRef = useRef(location);
  locationRef.current = location;
  const [outbox, setOutbox] = useState<OutboxFile[]>([]);

  // Favorites → native menu (and back).
  useEffect(() => {
    if (!desktop) return;
    void setFavorites(settings.favorites).catch(() => undefined);
  }, [desktop, settings.favorites]);
  useEffect(() => {
    if (!desktop) return;
    return onMenuNavigate((path) => {
      if (path.startsWith('/')) navigate(path);
    });
  }, [desktop, navigate]);
  const [update, setUpdate] = useState<{ version: string; notes: string | null } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [about, setAbout] = useState<{ name: string; version: string } | null>(null);

  // Native menu bar (File / Timer / View / Help). Timer items arrive as
  // tray:action and are handled by DesktopTimerBridge.
  useEffect(() => {
    if (!desktop) return;
    const offAction = onMenuAction((kind) => {
      switch (kind) {
        case 'settings':
          navigate('/account');
          return;
        case 'help':
          navigate('/help');
          return;
        case 'add-favorite': {
          const loc = locationRef.current;
          const path = loc.pathname + loc.search;
          const current = document.title.replace(/\s+—\s+.*$/, '').replace(/^⏱[^·]*·\s*/, '');
          const label = window.prompt('Name this favorite', current || path);
          if (!label) return;
          const favorites = [
            ...settingsRef.current.favorites.filter((f) => f.path !== path),
            { id: `${Date.now().toString(36)}`, label: label.trim().slice(0, 60), path },
          ].slice(-30);
          updateDesktopSettings({ favorites });
          pushToast({ id: `fav:${path}`, title: `Added "${label.trim()}" to Favorites` });
          return;
        }
        case 'manage-favorites':
          navigate('/account#favorites');
          return;
        case 'change-server':
          if (
            window.confirm(
              'Disconnect from this server? The app will restart and ask for a server address.',
            )
          ) {
            void clearServerUrl();
          }
          return;
        case 'check-update':
          void checkForUpdate()
            .then((r) => {
              if (r.available && r.version) {
                setUpdate({ version: r.version, notes: r.notes });
              } else {
                pushToast({ id: 'update:none', title: `Vibe ${r.currentVersion} is up to date` });
              }
            })
            .catch(() =>
              pushToast({ id: 'update:err', title: 'Update check failed', tone: 'warn' }),
            );
          return;
      }
    });
    const offAbout = onMenuAbout(setAbout);
    return () => {
      offAction();
      offAbout();
    };
  }, [desktop, navigate]);

  // Badge = everything the nav highlights.
  useEffect(() => {
    if (!desktop) return;
    const total = counts.teamUnread + counts.notifUnread + counts.requestsNew + counts.intakeNew;
    void setBadge(total).catch(() => undefined);
  }, [desktop, counts]);

  // Navigation from native toasts + deep links.
  useEffect(() => {
    if (!desktop) return;
    const go = (href: string | null): void => {
      if (!href || href.includes('://')) return;
      void showMainWindow().catch(() => undefined);
      navigate(href);
    };
    const offClick = onNotificationClick(({ href }) => go(href));
    const offLink = onDeepLink((url) => go(deepLinkToPath(url)));
    return () => {
      offClick();
      offLink();
    };
  }, [desktop, navigate]);

  // Settings → Rust.
  useEffect(() => {
    if (!desktop) return;
    void setCloseToTray(settings.closeToTray).catch(() => undefined);
  }, [desktop, settings.closeToTray]);
  useEffect(() => {
    if (!desktop) return;
    void setAutostart(settings.autostart).catch(() => undefined);
  }, [desktop, settings.autostart]);
  useEffect(() => {
    if (!desktop) return;
    void setOutboxWatch(settings.outboxWatch).catch(() => undefined);
  }, [desktop, settings.outboxWatch]);

  // Floating widget on launch (once per window lifetime).
  const widgetShown = useRef(false);
  useEffect(() => {
    if (!desktop || widgetShown.current || !settings.timerWidgetOnLaunch) return;
    widgetShown.current = true;
    void setTimerWidgetVisible(true).catch(() => undefined);
  }, [desktop, settings.timerWidgetOnLaunch]);

  // Outbox files.
  useEffect(() => {
    if (!desktop) return;
    return onOutboxFile((f) => {
      setOutbox((xs) => (xs.some((x) => x.path === f.path) ? xs : [...xs, f]));
      void showMainWindow().catch(() => undefined);
    });
  }, [desktop]);

  // Updates: the shell checks on launch + every 6 h and emits; we also
  // check once here so a long-running window learns about releases.
  useEffect(() => {
    if (!desktop) return;
    const off = onUpdateAvailable((u) => {
      setUpdate(u);
      if (shouldNotify(settings, 'system')) {
        void notify({
          id: `update:${u.version}`,
          title: `Vibe ${u.version} is ready`,
          body: 'Restart to update.',
          category: 'system',
        }).catch(() => undefined);
      }
    });
    void checkForUpdate()
      .then((r) => {
        if (r.available && r.version) setUpdate({ version: r.version, notes: r.notes });
      })
      .catch(() => undefined);
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktop]);

  if (!desktop) return null;
  const current = outbox[0];
  return (
    <>
      {update && (
        <div
          role="status"
          style={{
            position: 'fixed',
            top: 8,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 900,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '8px 14px',
            borderRadius: 999,
            background: tokens.color.surface,
            border: `1px solid ${tokens.color.accent}`,
            boxShadow: '0 6px 20px rgba(0,0,0,0.15)',
            fontSize: 13,
            fontFamily: tokens.font.body,
          }}
        >
          <span>
            Vibe <strong>{update.version}</strong> is ready to install.
          </span>
          <Button
            size="sm"
            disabled={installing}
            onClick={() => {
              setInstalling(true);
              void installUpdate().catch(() => setInstalling(false));
            }}
          >
            {installing ? 'Installing…' : 'Restart to update'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setUpdate(null)}>
            Later
          </Button>
        </div>
      )}
      {about && (
        <Modal title={about.name} onClose={() => setAbout(null)} minWidth={360}>
          <p style={{ fontSize: 14, margin: '0 0 6px' }}>
            Desktop app <strong>v{about.version}</strong>
          </p>
          <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
            © Kisaes LLC · PolyForm Small Business License 1.0.0
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
            <Button size="sm" onClick={() => setAbout(null)}>
              Close
            </Button>
          </div>
        </Modal>
      )}
      {current && (
        <OutboxAttachDialog
          key={current.path}
          file={current}
          onClose={() => setOutbox((xs) => xs.filter((x) => x.path !== current.path))}
        />
      )}
    </>
  );
}
