// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Vibe Connect HTTP client implementation of @vibe/core/connect.ConnectClient.

import type { ConnectClient } from '@vibe/core/connect';

export interface ConnectHttpOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export function createConnectClient(opts: ConnectHttpOptions): ConnectClient {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const fetchImpl: typeof fetch =
    opts.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined) ?? notWired;

  return {
    isConfigured: () => Boolean(opts.apiKey && base),
    async health() {
      try {
        const res = await fetchImpl(`${base}/health`, {
          headers: { Authorization: `Bearer ${opts.apiKey}` },
        });
        return { ok: res.ok, reason: res.ok ? undefined : `status_${res.status}` };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : 'unreachable' };
      }
    },
    async sendNotification(args) {
      try {
        const res = await fetchImpl(`${base}/v1/notifications`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            recipient_identity_id: args.portalIdentityId,
            event: args.event,
            payload: args.payload,
          }),
        });
        if (!res.ok) {
          const text = await res.text();
          return { delivered: false, reason: text || `status_${res.status}` };
        }
        return { delivered: true };
      } catch (err) {
        return { delivered: false, reason: err instanceof Error ? err.message : 'unreachable' };
      }
    },
  };
}

function notWired(): never {
  throw new Error('No fetch implementation provided to ConnectClient');
}
