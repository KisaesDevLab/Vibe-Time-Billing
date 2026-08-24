// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Bridge to the Tauri desktop shell (apps/desktop). The staff SPA also runs
// in a plain browser, so we deliberately avoid a build-time dependency on
// @tauri-apps/api: the shell sets `withGlobalTauri: true`, exposing
// `window.__TAURI__`, and we call through that at runtime. In the browser the
// global is absent, isDesktop() is false, and every desktop-only surface
// stays hidden.
//
// This file is the single contract between the web app and the Rust side
// (apps/desktop/src-tauri/src/*.rs). Command names and event names here
// must match the `#[tauri::command]` fns and `app.emit(...)` calls there.

interface TauriGlobal {
  core: {
    invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  };
  event: {
    listen<T>(
      event: string,
      handler: (e: { event: string; payload: T }) => void,
    ): Promise<() => void>;
  };
}

declare global {
  interface Window {
    __TAURI__?: TauriGlobal;
  }
}

// ---- detection --------------------------------------------------------------

/** True only when running inside the Tauri desktop shell. */
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && !!window.__TAURI__;
}

/** Which Tauri window this document lives in ("main", "timer"). */
export function desktopWindowLabel(): string {
  if (typeof window === 'undefined') return 'main';
  const m = /[?&]__window=([a-z]+)/.exec(window.location.search);
  return m?.[1] ?? 'main';
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = typeof window !== 'undefined' ? window.__TAURI__ : undefined;
  if (!tauri) throw new Error('not_running_in_desktop_shell');
  return tauri.core.invoke<T>(cmd, args);
}

/** Subscribe to a shell event. Returns an unsubscribe; no-op in browser. */
export function onDesktopEvent<T>(event: string, handler: (payload: T) => void): () => void {
  const tauri = typeof window !== 'undefined' ? window.__TAURI__ : undefined;
  if (!tauri) return () => undefined;
  let disposed = false;
  let unlisten: (() => void) | null = null;
  void tauri.event
    .listen<T>(event, (e) => {
      if (!disposed) handler(e.payload);
    })
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch(() => undefined);
  return () => {
    disposed = true;
    unlisten?.();
  };
}

// ---- capture (Capture Client Info) ---------------------------------------------

export interface CapturableWindow {
  id: number;
  title: string;
  appName: string;
  width: number;
  height: number;
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
export function looksLikeUltraTax(w: { title: string; appName: string }): boolean {
  const hay = `${w.title} ${w.appName}`.toLowerCase();
  return hay.includes('ultratax') || /\but20\d{2}\b/.test(hay) || hay.includes('cs ');
}

// ---- tray / timer --------------------------------------------------------------

export interface TrayTimer {
  id: string;
  label: string;
  status: 'RUNNING' | 'PAUSED';
}

export interface TrayState {
  timers: TrayTimer[];
  activeId: string | null;
  activeLabel: string | null;
  /** Elapsed seconds at `syncedAtMs`; the tray advances locally from here. */
  activeElapsedSeconds: number;
  syncedAtMs: number;
}

export type TrayActionKind =
  | 'start'
  | 'pause'
  | 'resume'
  | 'switch'
  | 'finish'
  | 'open'
  | 'widget'
  | 'discard';

export interface TrayAction {
  kind: TrayActionKind;
  timerId?: string | null;
  /** Set by the shell so the two delivery paths can be de-duplicated. */
  nonce?: number;
}

/**
 * Shell actions arrive two ways — a Tauri event and a DOM CustomEvent the
 * shell `eval`s into this window (independent of event permissions). This
 * subscribes to both and drops duplicates by nonce.
 */
function onDualChannel<T extends { nonce?: number }>(
  tauriEvent: string,
  domEvent: string,
  handler: (p: T) => void,
): () => void {
  const seen = new Set<number>();
  const once = (p: T): void => {
    if (p.nonce != null) {
      if (seen.has(p.nonce)) return;
      seen.add(p.nonce);
      if (seen.size > 200) seen.delete(seen.values().next().value as number);
    }
    handler(p);
  };
  const offTauri = onDesktopEvent<T>(tauriEvent, once);
  const onDom = (e: Event): void => once((e as CustomEvent<T>).detail);
  if (typeof window !== 'undefined') window.addEventListener(domEvent, onDom);
  return () => {
    offTauri();
    if (typeof window !== 'undefined') window.removeEventListener(domEvent, onDom);
  };
}

export function syncTray(state: TrayState): Promise<void> {
  return invoke('set_tray_state', { newState: state });
}

export function onTrayAction(handler: (a: TrayAction) => void): () => void {
  return onDualChannel<TrayAction>('tray:action', 'vibe:desktop-action', handler);
}

export function showMainWindow(): Promise<void> {
  return invoke('show_main_window');
}

/** Tell every shell window a timer mutation happened (they resync). */
export function broadcastTimersChanged(): Promise<void> {
  return invoke('broadcast_timers_changed');
}

export function setCloseToTray(enabled: boolean): Promise<void> {
  return invoke('set_close_to_tray', { enabled });
}

export interface TimerWidgetState {
  visible: boolean;
}

export function setTimerWidgetVisible(visible: boolean): Promise<void> {
  return invoke('show_timer_widget', { show: visible });
}

/** Widget asks the shell to grow/shrink its window (logical px). */
export function resizeTimerWidget(height: number): Promise<void> {
  return invoke('resize_timer_widget', { height });
}

/** Focus the main window and navigate it to `path` (used from the widget,
 *  which has its own document and cannot call the main router directly). */
export function openMainAt(path: string): Promise<void> {
  return invoke('open_main_at', { path });
}

/** Show ↔ hide; resolves with the new visibility. */
export function toggleTimerWidget(): Promise<boolean> {
  return invoke<boolean>('toggle_timer_widget');
}

export function timerWidgetVisible(): Promise<boolean> {
  return invoke<boolean>('timer_widget_visible');
}

// ---- hotkeys ----------------------------------------------------------------------

export interface Hotkeys {
  /** Pause/resume the running timer (or resume the last parked one). */
  toggle: string | null;
  /** Focus the app and open "Start timer". */
  start: string | null;
  /** Toggle the always-on-top mini widget. */
  widget: string | null;
}

export type HotkeyKind = keyof Hotkeys;

export interface HotkeyRegistration {
  ok: HotkeyKind[];
  failed: Array<{ kind: HotkeyKind; error: string }>;
}

export function setHotkeys(hotkeys: Hotkeys): Promise<HotkeyRegistration> {
  return invoke<HotkeyRegistration>('set_hotkeys', { hotkeys });
}

export function onHotkey(handler: (kind: HotkeyKind) => void): () => void {
  return onDesktopEvent<{ kind: HotkeyKind }>('desktop:hotkey', (p) => handler(p.kind));
}

// ---- idle ---------------------------------------------------------------------------

/** 0 disables idle detection. */
export function setIdleThreshold(seconds: number): Promise<void> {
  return invoke('set_idle_threshold', { seconds });
}

export function onIdleReturn(handler: (idleSeconds: number) => void): () => void {
  return onDesktopEvent<{ idleSeconds: number }>('desktop:idle-return', (p) =>
    handler(p.idleSeconds),
  );
}

// ---- foreground window (opt-in timer suggestions) -----------------------------------

export interface ForegroundWindow {
  title: string;
  appName: string;
}

export function setForegroundWatch(enabled: boolean): Promise<void> {
  return invoke('set_foreground_watch', { enabled });
}

export function onForegroundWindow(handler: (w: ForegroundWindow) => void): () => void {
  return onDesktopEvent<ForegroundWindow>('desktop:foreground-window', handler);
}

// ---- notifications --------------------------------------------------------------------

export interface NativeNotification {
  id: string;
  title: string;
  body?: string | null;
  href?: string | null;
  category?: string;
}

export function notify(n: NativeNotification): Promise<void> {
  return invoke('notify', { notification: n });
}

export function onNotificationClick(handler: (n: { id: string; href: string | null }) => void) {
  return onDesktopEvent<{ id: string; href: string | null }>('desktop:notification-click', handler);
}

/** Fires a sample toast so the user can confirm Windows notifications work. */
export function testNotification(): Promise<void> {
  return invoke('test_notification');
}

// ---- native menu ---------------------------------------------------------------------------

export type MenuActionKind =
  | 'settings'
  | 'change-server'
  | 'help'
  | 'check-update'
  | 'add-favorite'
  | 'manage-favorites';

export function onMenuAction(handler: (kind: MenuActionKind) => void): () => void {
  return onDualChannel<{ kind: MenuActionKind; nonce?: number }>(
    'menu:action',
    'vibe:desktop-menu',
    (p) => handler(p.kind),
  );
}

export interface FavoriteEntry {
  id: string;
  label: string;
  path: string;
}

/** Push the Favorites list into the native menu. */
export function setFavorites(favorites: FavoriteEntry[]): Promise<void> {
  return invoke('set_favorites', { favorites });
}

/** A Favorites menu click (or any shell-initiated navigation). */
export function onMenuNavigate(handler: (path: string) => void): () => void {
  return onDualChannel<{ path: string; nonce?: number }>(
    'menu:navigate',
    'vibe:desktop-navigate',
    (p) => handler(p.path),
  );
}

export function onMenuAbout(handler: (info: { name: string; version: string }) => void) {
  return onDesktopEvent<{ name: string; version: string }>('menu:about', handler);
}

export function setBadge(count: number): Promise<void> {
  return invoke('set_badge', { count });
}

// ---- deep links -----------------------------------------------------------------------------

export function onDeepLink(handler: (url: string) => void): () => void {
  return onDesktopEvent<{ url: string }>('desktop:deep-link', (p) => handler(p.url));
}

/** `vibetb://requests/123?x=1` → `/requests/123?x=1` (null when not ours). */
export function deepLinkToPath(url: string): string | null {
  const m = /^vibetb:\/\/(.*)$/i.exec(url.trim());
  if (!m) return null;
  const rest = m[1] ?? '';
  const path = '/' + rest.replace(/^\/+/, '');
  // Never allow protocol-relative or external redirects.
  if (path.startsWith('//')) return null;
  return path;
}

// ---- auto-update ---------------------------------------------------------------------------

export interface UpdateCheck {
  available: boolean;
  version: string | null;
  notes: string | null;
  currentVersion: string;
}

export function checkForUpdate(): Promise<UpdateCheck> {
  return invoke<UpdateCheck>('check_for_update');
}

/** Downloads + installs the pending update, then relaunches. */
export function installUpdate(): Promise<void> {
  return invoke('install_update');
}

export function onUpdateAvailable(handler: (u: { version: string; notes: string | null }) => void) {
  return onDesktopEvent<{ version: string; notes: string | null }>(
    'desktop:update-available',
    handler,
  );
}

// ---- autostart ----------------------------------------------------------------------------------

export function getAutostart(): Promise<boolean> {
  return invoke<boolean>('get_autostart');
}

export function setAutostart(enabled: boolean): Promise<void> {
  return invoke('set_autostart', { enabled });
}

// ---- secrets + device identity (OS credential store) --------------------------------------------

export interface DeviceInfo {
  /** Stable per-install id (generated once, kept in the credential store). */
  deviceId: string;
  hostname: string;
  os: string;
  appVersion: string;
}

export function deviceInfo(): Promise<DeviceInfo> {
  return invoke<DeviceInfo>('device_info');
}

export function secretGet(key: string): Promise<string | null> {
  return invoke<string | null>('secret_get', { key });
}

export function secretSet(key: string, value: string): Promise<void> {
  return invoke('secret_set', { key, value });
}

export function secretDelete(key: string): Promise<void> {
  return invoke('secret_delete', { key });
}

// ---- files ------------------------------------------------------------------------------------------

/** Download a (presigned) URL into the app cache and open it with the OS
 *  default application. The cache is purged on quit and after 24 h. */
export function downloadAndOpen(url: string, filename: string): Promise<void> {
  return invoke('download_and_open', { url, filename });
}

export function openExternal(url: string): Promise<void> {
  return invoke('open_external', { url });
}

export interface OutboxFile {
  path: string;
  name: string;
  size: number;
}

/** Watch the print-to-PDF outbox folder. Resolves with the folder path. */
export function setOutboxWatch(enabled: boolean): Promise<string> {
  return invoke<string>('set_outbox_watch', { enabled });
}

export function onOutboxFile(handler: (f: OutboxFile) => void): () => void {
  return onDesktopEvent<OutboxFile>('desktop:outbox-file', handler);
}

/** Read an outbox file's bytes (restricted to the outbox folder). */
export async function readOutboxFile(path: string): Promise<Uint8Array> {
  const data = await invoke<ArrayBuffer | number[]>('read_outbox_file', { path });
  return data instanceof ArrayBuffer ? new Uint8Array(data) : Uint8Array.from(data);
}

export function deleteOutboxFile(path: string): Promise<void> {
  return invoke('delete_outbox_file', { path });
}

// ---- server (which appliance the shell is connected to) --------------------------------------------

export function getServerUrl(): Promise<string | null> {
  return invoke<string | null>('get_server_url');
}

/** Forgets the server and restarts the shell on the connect page. */
export function clearServerUrl(): Promise<void> {
  return invoke('clear_server_url');
}

// ---- misc ---------------------------------------------------------------------------------------------

export function appVersion(): Promise<string> {
  return invoke<string>('app_version');
}
