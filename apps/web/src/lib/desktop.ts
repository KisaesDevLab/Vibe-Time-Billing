// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Bridge to the Tauri desktop shell (apps/desktop). The staff SPA also runs
// in a plain browser, so we deliberately avoid a build-time dependency on
// @tauri-apps/api: the shell sets `withGlobalTauri: true`, exposing
// `window.__TAURI__`, and we call through that at runtime. In the browser the
// global is absent, isDesktop() is false, and the capture UI stays hidden.

interface TauriGlobal {
  core: {
    invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  };
}

declare global {
  interface Window {
    __TAURI__?: TauriGlobal;
  }
}

export interface CapturableWindow {
  id: number;
  title: string;
  appName: string;
  width: number;
  height: number;
}

/** True only when running inside the Tauri desktop shell. */
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && !!window.__TAURI__;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = typeof window !== 'undefined' ? window.__TAURI__ : undefined;
  if (!tauri) throw new Error('not_running_in_desktop_shell');
  return tauri.core.invoke<T>(cmd, args);
}

/** Enumerate on-screen windows for the capture picker. */
export function listCapturableWindows(): Promise<CapturableWindow[]> {
  return invoke<CapturableWindow[]>('list_capturable_windows');
}

/** Capture a window by id; resolves to a base64 PNG (no data: prefix). */
export function captureWindow(id: number): Promise<string> {
  return invoke<string>('capture_window', { id });
}

/** Heuristic: which enumerated windows look like UltraTax CS. */
export function looksLikeUltraTax(w: CapturableWindow): boolean {
  const hay = `${w.title} ${w.appName}`.toLowerCase();
  return hay.includes('ultratax') || /\but20\d{2}\b/.test(hay) || hay.includes('cs ');
}

// ----- Notifications (0234 — SMS inbox, D13a) ----------------------------
//
// In the desktop shell we call tauri-plugin-notification through the
// global (`plugin:notification|…` commands); in a browser we fall back to
// the Notification API. Both need a permission grant; the request must
// come from a user gesture in browsers, so the Account page toggle calls
// requestNotifyPermission() explicitly.

export function notificationsSupported(): boolean {
  if (isDesktop()) return true;
  return typeof window !== 'undefined' && 'Notification' in window;
}

export async function requestNotifyPermission(): Promise<'granted' | 'denied' | 'unsupported'> {
  if (isDesktop()) {
    try {
      const granted = await invoke<boolean>('plugin:notification|is_permission_granted');
      if (granted) return 'granted';
      const r = await invoke<string>('plugin:notification|request_permission');
      return r === 'granted' ? 'granted' : 'denied';
    } catch {
      return 'denied';
    }
  }
  if (!notificationsSupported()) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  try {
    return (await Notification.requestPermission()) === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}

export async function notifyDesktop(
  title: string,
  body: string,
  opts: { tag?: string; onClick?: () => void } = {},
): Promise<'shown' | 'denied' | 'unsupported'> {
  if (isDesktop()) {
    try {
      const granted = await invoke<boolean>('plugin:notification|is_permission_granted');
      if (!granted) return 'denied';
      await invoke('plugin:notification|notify', { options: { title, body } });
      return 'shown';
    } catch {
      return 'denied';
    }
  }
  if (!notificationsSupported()) return 'unsupported';
  if (Notification.permission !== 'granted') return 'denied';
  try {
    const n = new Notification(title, { body, tag: opts.tag });
    n.onclick = () => {
      window.focus();
      opts.onClick?.();
      n.close();
    };
    return 'shown';
  } catch {
    return 'denied';
  }
}
