// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// PWA glue for the client portal: service-worker registration, the
// add-to-home-screen install prompt, and Web Push subscribe/unsubscribe.

import { api } from './api-client';

// ---- Service worker registration ----

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  // SWs require a secure context; localhost is treated as secure by browsers.
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

// ---- Install prompt (Android/desktop Chromium) ----

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e as BeforeInstallPromptEvent;
  window.dispatchEvent(new Event('pwa:installable'));
});
window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
});

export function canInstall(): boolean {
  return deferredPrompt != null;
}

/** True for iOS Safari, where install is manual ("Add to Home Screen"). */
export function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iphone|ipad|ipod/i.test(ua) && !/crios|fxios/i.test(ua);
}

export function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export async function promptInstall(): Promise<boolean> {
  if (!deferredPrompt) return false;
  await deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null;
  return outcome === 'accepted';
}

// ---- Web Push ----

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export async function isPushSubscribed(): Promise<boolean> {
  if (!pushSupported()) return false;
  const reg = await navigator.serviceWorker.ready;
  return (await reg.pushManager.getSubscription()) != null;
}

export type EnablePushResult = 'enabled' | 'denied' | 'unsupported' | 'disabled';

/** Request permission, subscribe the browser, and register with the server. */
export async function enablePush(): Promise<EnablePushResult> {
  if (!pushSupported()) return 'unsupported';
  const cfg = await api<{ enabled: boolean; publicKey: string | null }>('/api/portal/push/key');
  if (!cfg.enabled || !cfg.publicKey) return 'disabled';

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';

  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(cfg.publicKey) as BufferSource,
    }));

  const json = sub.toJSON();
  await api('/api/portal/push/subscribe', {
    method: 'POST',
    body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
  });
  return 'enabled';
}

/** Unsubscribe the browser and remove the server-side record. */
export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => undefined);
  await api('/api/portal/push/subscribe', {
    method: 'DELETE',
    body: JSON.stringify({ endpoint }),
  }).catch(() => undefined);
}
