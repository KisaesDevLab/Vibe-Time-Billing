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
