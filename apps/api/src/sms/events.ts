// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Real-time fan-out for the SMS inbox (D14). Producers (send service,
// ingest, poll, status callback) publish small envelopes on a per-firm
// Redis channel; the SSE endpoint in routes.ts subscribes and forwards.
// Payloads carry ids only — subscribers fetch what they need with their
// own permissions.

import type { Redis } from 'ioredis';

import type { SmsEvent } from './send-service';

export function smsEventChannel(firmId: string): string {
  return `sms:events:${firmId}`;
}

export function createSmsPublisher(redis: Redis | null): (evt: SmsEvent) => Promise<void> {
  return async (evt) => {
    if (!redis) return;
    try {
      await redis.publish(smsEventChannel(evt.firmId), JSON.stringify(evt));
    } catch {
      /* best-effort */
    }
  };
}
