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
import { createOpenAiCompatibleProvider } from './ai/openai-compatible';
import {
  createConsoleMailProvider,
  createPostmarkProvider,
  createResendProvider,
  createSmtpMailProvider,
  type MailProvider,
} from './mail/provider';
import {
  createConsoleSmsProvider,
  createTextLinkSmsProvider,
  createTwilioSmsProvider,
  type SmsProvider,
} from './sms/provider';
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
// their config is present. AI_OPENAI_BASE_URL elects the OpenAI-compatible
// path (Phase 23 #4); use it for hosted gateways like Groq/Together or for
// vLLM-style on-prem inference servers.
const localAiProvider: AiProvider | null = config.AI_OPENAI_BASE_URL
  ? createOpenAiCompatibleProvider({
      baseUrl: config.AI_OPENAI_BASE_URL,
      apiKey: config.AI_OPENAI_API_KEY,
      model: config.AI_OPENAI_MODEL ?? config.AI_LOCAL_MODEL ?? 'gpt-4o-mini',
      costPer1kInputCents: config.AI_OPENAI_COST_INPUT_CENTS,
      costPer1kOutputCents: config.AI_OPENAI_COST_OUTPUT_CENTS,
    })
  : config.AI_LOCAL_MODEL
    ? createOllamaProvider({ url: config.AI_LOCAL_URL, model: config.AI_LOCAL_MODEL })
    : null;
const cloudAiProvider: AiProvider | null = config.AI_CLOUD_API_KEY
  ? createAnthropicProvider({
      apiKey: config.AI_CLOUD_API_KEY,
      model: config.AI_CLOUD_MODEL,
    })
  : null;

// Mail provider — Q11 abstraction. Defaults to console (which logs the
// link/body) so dev still surfaces magic links via stdout if MailHog is
// down. SMTP path covers MailHog + on-prem mail servers.
const mailer: MailProvider = (() => {
  switch (config.MAIL_PROVIDER) {
    case 'postmark':
      return config.MAIL_POSTMARK_TOKEN
        ? createPostmarkProvider(
            { token: config.MAIL_POSTMARK_TOKEN, from: config.MAIL_FROM },
            logger,
          )
        : createConsoleMailProvider(logger);
    case 'resend':
      return config.MAIL_RESEND_API_KEY
        ? createResendProvider(
            { apiKey: config.MAIL_RESEND_API_KEY, from: config.MAIL_FROM },
            logger,
          )
        : createConsoleMailProvider(logger);
    case 'smtp':
      return createSmtpMailProvider(
        {
          host: config.MAIL_SMTP_HOST,
          port: config.MAIL_SMTP_PORT,
          secure: config.MAIL_SMTP_SECURE,
          user: config.MAIL_SMTP_USER,
          pass: config.MAIL_SMTP_PASS,
          from: config.MAIL_FROM,
        },
        logger,
      );
    default:
      return createConsoleMailProvider(logger);
  }
})();

// SMS provider — Q16. Console fallback in dev.
const smsProvider: SmsProvider = (() => {
  switch (config.SMS_PROVIDER) {
    case 'twilio':
      return config.SMS_TWILIO_ACCOUNT_SID && config.SMS_TWILIO_AUTH_TOKEN && config.SMS_TWILIO_FROM
        ? createTwilioSmsProvider(
            {
              accountSid: config.SMS_TWILIO_ACCOUNT_SID,
              authToken: config.SMS_TWILIO_AUTH_TOKEN,
              from: config.SMS_TWILIO_FROM,
            },
            logger,
          )
        : createConsoleSmsProvider(logger);
    case 'textlink':
      return config.SMS_TEXTLINK_API_KEY
        ? createTextLinkSmsProvider({ apiKey: config.SMS_TEXTLINK_API_KEY }, logger)
        : createConsoleSmsProvider(logger);
    default:
      return createConsoleSmsProvider(logger);
  }
})();

// Wrap the providers into the shapes the auth routes expect.
const sendMagicLink = async (args: {
  email: string;
  firmId: string;
  link: string;
}): Promise<void> => {
  await mailer.send({
    to: args.email,
    subject: 'Your sign-in link',
    body: `Click here to sign in: ${args.link}\n\nThis link expires in ${config.MAGIC_LINK_TTL_MINUTES} minutes.`,
  });
};

const sendPortalEmail = async (args: {
  to: string;
  subject: string;
  body: string;
}): Promise<void> => {
  await mailer.send(args);
};

const sendPortalSms = async (args: { to: string; body: string }): Promise<void> => {
  await smsProvider.send(args);
};

const app = createApp({
  db,
  redis,
  sessionStore,
  chargeInvoice,
  cloudAiProvider,
  localAiProvider,
  stripeProvider: stripe,
  stripeWebhookSecret: config.STRIPE_WEBHOOK_SECRET ?? null,
  sendMagicLink,
  sendPortalEmail,
  sendPortalSms,
});

app.listen(config.PORT, () => {
  logger.info(
    {
      port: config.PORT,
      env: config.NODE_ENV,
      stripeWired: Boolean(stripe),
      cloudAiWired: Boolean(cloudAiProvider),
      localAiWired: Boolean(localAiProvider),
      mailProvider: mailer.id,
      smsProvider: smsProvider.id,
      portalEnabled: Boolean(config.COMMERCIAL_LICENSE_TOKEN),
    },
    'vibe-tb-api listening',
  );
});
