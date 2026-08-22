// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Per-machine desktop preferences (tray, hotkeys, idle, notifications,
// autostart, foreground suggestions). They describe this workstation, not
// the user's account, so they live in localStorage of the shell's webview
// — the shell's WebView2 profile is per-OS-user and persists across
// restarts. Account → Desktop edits them; TimerProvider and the Shell
// push the relevant bits into Rust whenever they change.

import { useSyncExternalStore } from 'react';

import type { Hotkeys } from './desktop';

export type NotifyCategory =
  | 'message'
  | 'team'
  | 'intake'
  | 'request'
  | 'alert'
  | 'approval'
  | 'appointment'
  | 'system';

export const NOTIFY_CATEGORIES: Array<{ key: NotifyCategory; label: string }> = [
  { key: 'message', label: 'Client messages' },
  { key: 'team', label: 'Team messages' },
  { key: 'intake', label: 'Intake submissions' },
  { key: 'request', label: 'Client responses on requests' },
  { key: 'approval', label: 'Approvals & booking requests' },
  { key: 'appointment', label: 'Appointment reminders' },
  { key: 'alert', label: 'Alerts (signatures, calendar, system)' },
  { key: 'system', label: 'App updates' },
];

export interface Favorite {
  id: string;
  label: string;
  path: string;
}

export interface DesktopSettings {
  closeToTray: boolean;
  /** Native Favorites menu (per machine). */
  favorites: Favorite[];
  hotkeys: Hotkeys;
  /** Minutes; 0 disables idle detection. */
  idleThresholdMinutes: number;
  notificationsEnabled: boolean;
  mutedCategories: NotifyCategory[];
  /** "22:00" → "07:00" style; both null disables quiet hours. */
  quietFrom: string | null;
  quietTo: string | null;
  autostart: boolean;
  foregroundSuggestions: boolean;
  rememberDevice: boolean;
  outboxWatch: boolean;
  timerWidgetOnLaunch: boolean;
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  closeToTray: true,
  favorites: [],
  hotkeys: {
    toggle: 'CommandOrControl+Shift+T',
    start: 'CommandOrControl+Shift+N',
    widget: 'CommandOrControl+Shift+W',
  },
  idleThresholdMinutes: 10,
  notificationsEnabled: true,
  mutedCategories: [],
  quietFrom: null,
  quietTo: null,
  autostart: true,
  foregroundSuggestions: false,
  rememberDevice: true,
  outboxWatch: true,
  timerWidgetOnLaunch: false,
};

const KEY = '__vibe_desktop_settings';
const listeners = new Set<() => void>();
let cached: DesktopSettings | null = null;

function read(): DesktopSettings {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return (cached = DEFAULT_DESKTOP_SETTINGS);
    const parsed = JSON.parse(raw) as Partial<DesktopSettings>;
    cached = {
      ...DEFAULT_DESKTOP_SETTINGS,
      ...parsed,
      hotkeys: { ...DEFAULT_DESKTOP_SETTINGS.hotkeys, ...(parsed.hotkeys ?? {}) },
      mutedCategories: Array.isArray(parsed.mutedCategories)
        ? parsed.mutedCategories
        : DEFAULT_DESKTOP_SETTINGS.mutedCategories,
      favorites: Array.isArray(parsed.favorites) ? parsed.favorites : [],
    };
    return cached;
  } catch {
    return (cached = DEFAULT_DESKTOP_SETTINGS);
  }
}

export function getDesktopSettings(): DesktopSettings {
  return read();
}

export function updateDesktopSettings(patch: Partial<DesktopSettings>): DesktopSettings {
  const next = { ...read(), ...patch };
  cached = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage unavailable — keep in memory for this session
  }
  for (const l of listeners) l();
  return next;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useDesktopSettings(): DesktopSettings {
  return useSyncExternalStore(subscribe, read, read);
}

/** True when `now` falls inside the configured quiet window. */
export function inQuietHours(s: DesktopSettings, now = new Date()): boolean {
  if (!s.quietFrom || !s.quietTo) return false;
  const toMin = (hhmm: string): number => {
    const [h, m] = hhmm.split(':').map((x) => Number(x));
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const cur = now.getHours() * 60 + now.getMinutes();
  const from = toMin(s.quietFrom);
  const to = toMin(s.quietTo);
  if (from === to) return false;
  // Window crossing midnight (22:00 → 07:00).
  return from < to ? cur >= from && cur < to : cur >= from || cur < to;
}

export function shouldNotify(s: DesktopSettings, category: NotifyCategory): boolean {
  if (!s.notificationsEnabled) return false;
  if (s.mutedCategories.includes(category)) return false;
  if (inQuietHours(s)) return false;
  return true;
}
