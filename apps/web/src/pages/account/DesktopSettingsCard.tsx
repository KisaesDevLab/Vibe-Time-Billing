// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Account → Desktop. Only rendered inside the Tauri shell. Everything here
// is per-workstation (lib/desktop-settings.ts); the bridges push changes
// into Rust as they happen, so there is no save button. The one server
// touch is the remembered-devices list (DS-3).

import { useEffect, useState } from 'react';
import { Button, Card, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import {
  appVersion,
  checkForUpdate,
  clearServerUrl,
  getServerUrl,
  installUpdate,
  isDesktop,
  setHotkeys,
  setTimerWidgetVisible,
  testNotification,
  type HotkeyKind,
  type HotkeyRegistration,
} from '../../lib/desktop';
import {
  enrollDesktopDevice,
  forgetDesktopCredential,
  hasDesktopCredential,
} from '../../lib/desktop-session';
import {
  NOTIFY_CATEGORIES,
  updateDesktopSettings,
  useDesktopSettings,
  type NotifyCategory,
} from '../../lib/desktop-settings';

interface DeviceRow {
  id: string;
  deviceId: string;
  deviceName: string;
  createdAt: string;
  lastUsedAt: string;
  lastIp: string | null;
}

const row: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '8px 0',
  borderBottom: `1px solid ${tokens.color.border}`,
  fontSize: 13,
};
const hint: React.CSSProperties = {
  fontSize: 12,
  color: tokens.color.textMuted,
  margin: '2px 0 0',
};
const input: React.CSSProperties = {
  padding: '4px 8px',
  fontSize: 13,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: 6,
  background: tokens.color.surface,
  color: tokens.color.text,
};

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}): JSX.Element {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function DesktopSettingsCard(): JSX.Element | null {
  const s = useDesktopSettings();
  const [version, setVersion] = useState<string>('');
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [hotkeyStatus, setHotkeyStatus] = useState<HotkeyRegistration | null>(null);
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [thisDeviceRemembered, setThisDeviceRemembered] = useState(false);
  const [busy, setBusy] = useState(false);

  const desktop = isDesktop();

  useEffect(() => {
    if (!desktop) return;
    void appVersion()
      .then(setVersion)
      .catch(() => undefined);
    void getServerUrl()
      .then(setServerUrl)
      .catch(() => undefined);
    void loadDevices();
    void hasDesktopCredential().then(setThisDeviceRemembered);
  }, [desktop]);

  async function loadDevices(): Promise<void> {
    try {
      const r = await api<{ items: DeviceRow[] }>('/api/staff/desktop/devices');
      setDevices(r.items);
    } catch {
      setDevices([]);
    }
  }

  if (!desktop) return null;

  const setHotkey = (kind: HotkeyKind, value: string): void => {
    const next = { ...s.hotkeys, [kind]: value.trim() || null };
    updateDesktopSettings({ hotkeys: next });
    void setHotkeys(next)
      .then(setHotkeyStatus)
      .catch(() => undefined);
  };

  const toggleMute = (c: NotifyCategory, muted: boolean): void => {
    const set = new Set(s.mutedCategories);
    if (muted) set.add(c);
    else set.delete(c);
    updateDesktopSettings({ mutedCategories: [...set] });
  };

  async function rememberToggle(v: boolean): Promise<void> {
    setBusy(true);
    try {
      updateDesktopSettings({ rememberDevice: v });
      if (v) {
        await enrollDesktopDevice();
      } else {
        await forgetDesktopCredential();
      }
      setThisDeviceRemembered(await hasDesktopCredential());
      await loadDevices();
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string): Promise<void> {
    await api(`/api/staff/desktop/devices/${id}`, { method: 'DELETE' }).catch(() => undefined);
    await loadDevices();
    setThisDeviceRemembered(await hasDesktopCredential());
  }

  return (
    <Card title="Desktop app">
      <div style={{ display: 'grid', gap: tokens.space.md }}>
        <div style={row}>
          <div>
            <div>Version</div>
            <p style={hint}>{version || '—'}</p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {updateMsg && <span style={{ fontSize: 12 }}>{updateMsg}</span>}
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                void checkForUpdate()
                  .then((r) =>
                    setUpdateMsg(r.available ? `Update ${r.version} available` : 'Up to date'),
                  )
                  .catch(() => setUpdateMsg('Update check failed'))
              }
            >
              Check for updates
            </Button>
            {updateMsg?.startsWith('Update ') && (
              <Button size="sm" onClick={() => void installUpdate()}>
                Install & restart
              </Button>
            )}
          </div>
        </div>

        <div style={row}>
          <div>
            <div>Server</div>
            <p style={hint}>{serverUrl ?? '—'}</p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (
                window.confirm(
                  'Disconnect from this server? The app will restart and ask for a server address.',
                )
              ) {
                void clearServerUrl();
              }
            }}
          >
            Change server…
          </Button>
        </div>

        <section>
          <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>Window</h4>
          <div style={{ display: 'grid', gap: 6, fontSize: 13 }}>
            <Toggle
              checked={s.closeToTray}
              onChange={(v) => updateDesktopSettings({ closeToTray: v })}
              label="Close button minimizes to the tray (timers keep running)"
            />
            <Toggle
              checked={s.autostart}
              onChange={(v) => updateDesktopSettings({ autostart: v })}
              label="Start when I sign in to Windows"
            />
            <Toggle
              checked={s.timerWidgetOnLaunch}
              onChange={(v) => updateDesktopSettings({ timerWidgetOnLaunch: v })}
              label="Show the floating timer widget on launch"
            />
            <div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void setTimerWidgetVisible(true)}
              >
                Show timer widget now
              </Button>
            </div>
          </div>
        </section>

        <section>
          <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>Keyboard shortcuts</h4>
          <p style={hint}>
            Global — they work while you are in UltraTax or any other app. Use names like
            <code> CommandOrControl+Shift+T</code>, <code>Alt+F9</code>. Leave blank to disable.
          </p>
          {(
            [
              ['toggle', 'Pause / resume the running timer'],
              ['start', 'Open Vibe and start a timer'],
              ['widget', 'Show the floating timer widget'],
            ] as Array<[HotkeyKind, string]>
          ).map(([kind, label]) => {
            const failed = hotkeyStatus?.failed.find((f) => f.kind === kind);
            return (
              <div key={kind} style={row}>
                <span>{label}</span>
                <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {failed && <Pill tone="warning">not registered</Pill>}
                  <input
                    style={{ ...input, width: 220, fontFamily: 'monospace' }}
                    defaultValue={s.hotkeys[kind] ?? ''}
                    onBlur={(e) => setHotkey(kind, e.target.value)}
                    placeholder="disabled"
                  />
                </span>
              </div>
            );
          })}
        </section>

        <section>
          <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>Timer</h4>
          <div style={row}>
            <div>
              <div>Ask what to do with idle time after</div>
              <p style={hint}>0 turns idle detection off.</p>
            </div>
            <span>
              <input
                type="number"
                min={0}
                max={240}
                style={{ ...input, width: 70 }}
                value={s.idleThresholdMinutes}
                onChange={(e) =>
                  updateDesktopSettings({
                    idleThresholdMinutes: Math.max(0, Math.min(240, Number(e.target.value) || 0)),
                  })
                }
              />{' '}
              min
            </span>
          </div>
          <div style={{ padding: '8px 0' }}>
            <Toggle
              checked={s.foregroundSuggestions}
              onChange={(v) => updateDesktopSettings({ foregroundSuggestions: v })}
              label="Suggest starting a timer when UltraTax shows a client I'm not timing"
            />
            <p style={hint}>
              Reads only the window title (the Client ID), never the screen contents.
            </p>
          </div>
          <div style={{ padding: '8px 0' }}>
            <Toggle
              checked={s.outboxWatch}
              onChange={(v) => updateDesktopSettings({ outboxWatch: v })}
              label="Watch my VibeTB\\Outbox folder for printed PDFs to attach"
            />
            <p style={hint}>
              Print to PDF from UltraTax into that folder and Vibe offers to attach the file to a
              client, then deletes it from the folder.
            </p>
          </div>
        </section>

        <section>
          <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>Notifications</h4>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <Toggle
              checked={s.notificationsEnabled}
              onChange={(v) => updateDesktopSettings({ notificationsEnabled: v })}
              label="Show Windows notifications while Vibe is in the background"
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                void testNotification().catch((e: unknown) =>
                  window.alert(
                    `Notification failed: ${e instanceof Error ? e.message : String(e)}`,
                  ),
                )
              }
            >
              Send test notification
            </Button>
          </div>
          <div style={{ display: 'grid', gap: 4, margin: '8px 0 8px 22px', fontSize: 13 }}>
            {NOTIFY_CATEGORIES.map((c) => (
              <Toggle
                key={c.key}
                checked={!s.mutedCategories.includes(c.key)}
                onChange={(v) => toggleMute(c.key, !v)}
                label={c.label}
              />
            ))}
          </div>
          <div style={{ ...row, borderBottom: 'none' }}>
            <span>Quiet hours</span>
            <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="time"
                style={input}
                value={s.quietFrom ?? ''}
                onChange={(e) => updateDesktopSettings({ quietFrom: e.target.value || null })}
              />
              <span>to</span>
              <input
                type="time"
                style={input}
                value={s.quietTo ?? ''}
                onChange={(e) => updateDesktopSettings({ quietTo: e.target.value || null })}
              />
            </span>
          </div>
        </section>

        <section>
          <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>Remembered devices</h4>
          <Toggle
            checked={s.rememberDevice && thisDeviceRemembered}
            onChange={(v) => void rememberToggle(v)}
            label="Keep me signed in on this computer"
          />
          <p style={hint}>
            Stores a device credential in Windows Credential Manager. Sensitive actions still ask
            for your second factor. Sign out to forget it.
          </p>
          {devices.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {devices.map((d) => (
                <div key={d.id} style={row}>
                  <div>
                    <div>{d.deviceName}</div>
                    <p style={hint}>
                      last used {new Date(d.lastUsedAt).toLocaleString()}
                      {d.lastIp ? ` · ${d.lastIp}` : ''}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void revoke(d.id)}
                  >
                    Revoke
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </Card>
  );
}
