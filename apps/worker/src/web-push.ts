// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Web Push sender for the installable client-portal PWA (Phase 26). Reused by
// the staged-notification worker job: whenever a portal_notification is
// created, we also push to that identity's registered devices. VAPID keys come
// from env (same pattern as the mail/SMS dispatchers); when unset this is a
// silent no-op. Dead endpoints (HTTP 404/410 from the push service) are pruned
// so the table self-heals.

import webpush from 'web-push';
import { and, eq, isNull } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { portalPushSubscription } from '@vibe/db/schema';

export interface WebPushPayload {
  title: string;
  body: string | null;
  url: string | null;
}

let configured: boolean | null = null;

/** Configure web-push from env once. Returns false when VAPID keys are absent. */
function ensureConfigured(): boolean {
  if (configured != null) return configured;
  const pub = process.env['VAPID_PUBLIC_KEY'];
  const priv = process.env['VAPID_PRIVATE_KEY'];
  const subject = process.env['VAPID_SUBJECT'] ?? 'mailto:[email protected]';
  if (!pub || !priv) {
    configured = false;
    return false;
  }
  webpush.setVapidDetails(subject, pub, priv);
  configured = true;
  return true;
}

interface PushError {
  statusCode?: number;
}

/**
 * Push a notification to every active subscription for a portal identity.
 * Returns the number of successful sends. Best-effort: failures are swallowed
 * (logged by the caller if desired) and gone endpoints are deleted.
 */
export async function sendWebPushToIdentity(
  db: Database,
  identityId: string,
  payload: WebPushPayload,
): Promise<number> {
  if (!ensureConfigured()) return 0;

  const subs = await db
    .select()
    .from(portalPushSubscription)
    .where(
      and(
        eq(portalPushSubscription.portalIdentityId, identityId),
        isNull(portalPushSubscription.disabledAt),
      ),
    );
  if (subs.length === 0) return 0;

  const json = JSON.stringify({
    title: payload.title,
    body: payload.body ?? '',
    url: payload.url ?? '/',
  });

  let ok = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        json,
      );
      ok += 1;
      await db
        .update(portalPushSubscription)
        .set({ lastUsedAt: new Date(), failureCount: 0 })
        .where(eq(portalPushSubscription.id, sub.id))
        .catch(() => undefined);
    } catch (err) {
      const status = (err as PushError).statusCode;
      if (status === 404 || status === 410) {
        // Subscription is gone for good — remove it.
        await db
          .delete(portalPushSubscription)
          .where(eq(portalPushSubscription.id, sub.id))
          .catch(() => undefined);
      } else {
        // Transient — bump the failure counter; disable after repeated misses.
        await db
          .update(portalPushSubscription)
          .set({
            failureCount: (sub.failureCount ?? 0) + 1,
            disabledAt: (sub.failureCount ?? 0) + 1 >= 10 ? new Date() : null,
          })
          .where(eq(portalPushSubscription.id, sub.id))
          .catch(() => undefined);
      }
    }
  }
  return ok;
}
