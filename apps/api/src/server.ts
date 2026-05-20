// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Production wiring. Providers are constructed only if their secrets are
// present in env; otherwise the corresponding API surface returns a
// well-typed "not configured" error and the rest of the appliance runs
// fine.

import { createApp } from './app';
import { loadConfig } from './config';
import { logger } from './logger';
import { getRedis } from './auth/redis-client';
import { createSessionStore } from './auth/session-store';
import { createDb } from '@vibe/db';

import { createStripeProvider } from './payments/stripe';
import { createAnthropicProvider } from './ai/anthropic';
import { createOllamaProvider } from './ai/ollama';
import type { AiProvider } from '@vibe/core/ai';

const config = loadConfig();
const redis = getRedis();
const { db } = createDb({ connectionString: config.DATABASE_URL });
const sessionStore = createSessionStore(redis);

// Stripe — firm-owned keys per Q7.
const stripe = config.STRIPE_SECRET_KEY
  ? createStripeProvider({ secretKey: config.STRIPE_SECRET_KEY })
  : null;

const chargeInvoice = stripe
  ? async (args: { invoiceId: string; amountCents: number; metadata: Record<string, string> }) => {
      // In production the firm has a payment method on file per portal
      // identity; we look it up by activeClientId. For now we charge the
      // default test method which is the simplest demoable wiring.
      const result = await stripe.charge({
        amountCents: args.amountCents,
        currency: 'USD',
        description: `Invoice ${args.metadata['invoice_number'] ?? args.invoiceId}`,
        metadata: args.metadata,
        paymentMethod: {
          providerId: 'stripe',
          providerMethodId: 'pm_card_visa', // Stripe's test card payment method
          kind: 'CARD',
        },
      });
      return {
        ok: result.ok,
        providerChargeId: result.providerChargeId || undefined,
        errorMessage: result.errorMessage,
      };
    }
  : undefined;

// AI providers — Q15: local preferred, cloud fallback. Constructed only if
// their config is present.
const localAiProvider: AiProvider | null = config.AI_LOCAL_MODEL
  ? createOllamaProvider({ url: config.AI_LOCAL_URL, model: config.AI_LOCAL_MODEL })
  : null;
const cloudAiProvider: AiProvider | null = config.AI_CLOUD_API_KEY
  ? createAnthropicProvider({
      apiKey: config.AI_CLOUD_API_KEY,
      model: config.AI_CLOUD_MODEL,
    })
  : null;

const app = createApp({
  db,
  redis,
  sessionStore,
  chargeInvoice,
  cloudAiProvider,
  localAiProvider,
});

app.listen(config.PORT, () => {
  logger.info(
    {
      port: config.PORT,
      env: config.NODE_ENV,
      stripeWired: Boolean(stripe),
      cloudAiWired: Boolean(cloudAiProvider),
      localAiWired: Boolean(localAiProvider),
      portalEnabled: Boolean(config.COMMERCIAL_LICENSE_TOKEN),
    },
    'vibe-tb-api listening',
  );
});
