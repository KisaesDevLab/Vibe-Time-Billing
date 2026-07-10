// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Resolve the Stripe credentials to use for a firm's connected-account calls
// (SetupIntents, off-session charges). Two supported configurations:
//
//   1. Connect OAuth (Standard): the platform secret key + the firm's
//      connected `stripe_account_id` (sent as the Stripe-Account header).
//   2. Direct firm keys: the firm pasted its own secret key (Admin → Billing →
//      Stripe Connect, encrypted at rest). The key already scopes to the firm's
//      account, so no Stripe-Account header (empty `stripeAccountId`).
//
// Falls back to the platform env key alone (single-firm appliance where the
// env STRIPE_SECRET_KEY IS the firm's own account key).

import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { firmSettingsProposals } from '@vibe/db/schema';

import { loadFirmStripeConfig } from './stripe-resolver';

export interface FirmStripeCreds {
  secretKey: string;
  /** Publishable key for the browser Stripe.js (matches the account model). */
  publishableKey: string;
  /** '' for direct firm keys; the connected account id for Connect OAuth. */
  stripeAccountId: string;
}

export async function resolveFirmStripe(
  db: Database,
  firmId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<FirmStripeCreds | null> {
  const platformKey = env['STRIPE_SECRET_KEY'] || '';
  const platformPub = env['STRIPE_PUBLISHABLE_KEY'] || '';

  // 1. Connect OAuth — platform key + the firm's connected account.
  const [conn] = await db
    .select({
      acct: firmSettingsProposals.stripeAccountId,
      pub: firmSettingsProposals.stripePublishableKey,
    })
    .from(firmSettingsProposals)
    .where(and(eq(firmSettingsProposals.firmId, firmId)))
    .limit(1);
  if (conn?.acct && platformKey) {
    return {
      secretKey: platformKey,
      publishableKey: conn.pub || platformPub,
      stripeAccountId: conn.acct,
    };
  }

  // 2. Direct firm keys (pasted secret key, encrypted at rest).
  const cfg = await loadFirmStripeConfig(db, firmId);
  if (cfg?.secretKey) {
    return {
      secretKey: cfg.secretKey,
      publishableKey: cfg.publishableKey || platformPub,
      stripeAccountId: '',
    };
  }

  // 3. Fallback — the appliance env key is the firm's own account key.
  if (platformKey) {
    return { secretKey: platformKey, publishableKey: platformPub, stripeAccountId: '' };
  }
  return null;
}
