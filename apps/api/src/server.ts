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
import { createDb, seedKnowledgeBase } from '@vibe/db';
import { firms } from '@vibe/db/schema';
import { bootCrypto } from './crypto/boot';

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
import { wrapMailWithAudit, wrapSmsWithAudit } from './notifications/audit';
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
// down. SMTP path covers MailHog + on-prem mail servers. The base
// provider is wrapped below with wrapMailWithAudit so every send
// appends a notification_log row (Connect H.8).
const baseMailer: MailProvider = (() => {
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

const mailer: MailProvider = wrapMailWithAudit(baseMailer, { db, log: logger });

// SMS provider — Q16. Console fallback in dev. Same audit wrap as mail.
const baseSmsProvider: SmsProvider = (() => {
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

const smsProvider: SmsProvider = wrapSmsWithAudit(baseSmsProvider, { db, log: logger });

// Wrap the providers into the shapes the auth routes expect.
const sendMagicLink = async (args: {
  email: string;
  firmId: string;
  link: string;
}): Promise<void> => {
  // Escape the URL for HTML attribute safety. The token is a JWT (no
  // <,>,",&) but defense in depth keeps a malformed token from
  // smuggling markup.
  const escaped = args.link
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  await mailer.send({
    to: args.email,
    subject: 'Your sign-in link',
    body: `Click here to sign in: ${args.link}\n\nThis link expires in ${config.MAGIC_LINK_TTL_MINUTES} minutes.`,
    html:
      `<p>Click here to sign in:</p>` +
      `<p><a href="${escaped}">${escaped}</a></p>` +
      `<p style="color:#666;font-size:13px">This link expires in ${config.MAGIC_LINK_TTL_MINUTES} minutes.</p>`,
  });
};

const sendPortalEmail = async (args: {
  to: string;
  subject: string;
  body: string;
}): Promise<void> => {
  await mailer.send(args);
};

// 0054 — full-payload mail surface (attachments, HTML body) used by
// statement + invoice email flows. Wraps the same provider so the
// console/MailHog/SMTP/Postmark/Resend swap still applies.
const sendStaffMail = async (args: {
  to: string;
  subject: string;
  body: string;
  html?: string;
  attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>;
}): Promise<void> => {
  const r = await mailer.send(args);
  if (!r.ok) {
    throw new Error(r.error ?? 'mail_send_failed');
  }
};

const sendPortalSms = async (args: { to: string; body: string }): Promise<void> => {
  await smsProvider.send(args);
};

// 0087 — second-factor OTP senders. Without these wired, password
// sign-in (which requires a second factor) can't dispatch its EMAIL/SMS
// code and returns email_dispatcher_unavailable. Reuse the same mailer /
// SMS provider so the console/MailHog/SMTP/Postmark/Resend swap applies.
const sendEmailOtp = async (args: {
  email: string;
  firmId: string;
  code: string;
}): Promise<void> => {
  await mailer.send({
    to: args.email,
    subject: 'Your sign-in code',
    body: `Your sign-in code is ${args.code}. It expires in ${config.SMS_OTP_TTL_MINUTES} minutes.`,
    html:
      `<p>Your sign-in code is <strong style="font-size:18px">${args.code}</strong></p>` +
      `<p style="color:#666;font-size:13px">It expires in ${config.SMS_OTP_TTL_MINUTES} minutes.</p>`,
  });
};

const sendSmsOtp = async (args: { phone: string; firmId: string; code: string }): Promise<void> => {
  await smsProvider.send({ to: args.phone, body: `Your sign-in code is ${args.code}.` });
};

// P4.6 — I.6 — step-up lockout alert to firm admins. Resolves the
// `step_up_lockout` notification template, then sends to every
// app_user with the admin role. Best-effort: failures are logged.
const sendStepUpLockoutAlert = async (args: {
  firmId: string;
  portalIdentityId: string;
  expiresAt: Date;
}): Promise<void> => {
  try {
    const { sql } = await import('drizzle-orm');
    if (!db) return;
    const result = await db.execute(
      sql`
        SELECT au.email,
               au.full_name AS admin_name,
               f.name       AS firm_name
        FROM vibetb.app_user au
        INNER JOIN vibetb.user_role ur ON ur.app_user_id = au.id
        INNER JOIN vibetb.role r       ON r.id = ur.role_id
        INNER JOIN vibetb.firm f       ON f.id = au.firm_id
        WHERE au.firm_id = ${args.firmId}
          AND au.status = 'ACTIVE'
          AND r.slug = 'admin'
      `,
    );
    // reason: postgres-js returns `{ rows: [...] }`, node-postgres returns
    // the array directly. Handle both for portability.
    const rawRows = Array.isArray(result)
      ? (result as unknown as Array<Record<string, unknown>>)
      : ((result as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? []);
    const admins = rawRows.map((r) => ({
      email: String(r['email'] ?? ''),
      admin_name: (r['admin_name'] as string | null) ?? null,
      firm_name: (r['firm_name'] as string | null) ?? null,
    }));
    if (admins.length === 0) return;
    const expires = args.expiresAt.toLocaleString();
    const firmName = admins[0]?.firm_name ?? 'your firm';
    const subject = `Step-up lockout triggered for portal user`;
    const body =
      `A portal user (identity ${args.portalIdentityId}) has been locked out of ` +
      `step-up verification after repeated failed attempts.\n\n` +
      `Lockout expires: ${expires}\n\n` +
      `Review the audit log to investigate.\n\n${firmName}`;
    for (const admin of admins) {
      try {
        await mailer.send({ to: admin.email, subject, body });
      } catch (err) {
        logger.warn({ err, to: admin.email }, 'step-up lockout alert: send failed');
      }
    }
  } catch (err) {
    logger.error({ err }, 'sendStepUpLockoutAlert: resolve admins failed');
  }
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
  sendEmailOtp,
  sendSmsOtp,
  sendPortalEmail,
  sendStaffMail,
  sendPortalSms,
  sendStepUpLockoutAlert,
});

// QA fix — tsx watch's hot-restart races the dying listener: the new
// process tries to bind the port before the OS releases the old socket,
// crashes with EADDRINUSE, and pnpm sees a dead child. Frontend then
// blows up with ECONNREFUSED on every API call. Retry on EADDRINUSE
// with exponential backoff. In dev keep retrying indefinitely (the
// previous process eventually releases the socket); in prod give up
// after ~30s so the container orchestrator can take over.
const server = app.listen(config.PORT, () => {
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

// Stage 1B — boot-time crypto unseal. Fire-and-forget; the lock
// middleware reads the resulting state via getApplianceLockState(),
// so even if this is still in flight when the first request arrives
// the appliance behaves as locked (503) until unseal resolves. Errors
// are logged but don't crash the process — the operator can investigate
// via /api/staff/admin/unlock/status.
void bootCrypto(db)
  .then(async () => {
    // 0094 — after the firm key is unsealed, fold any UI-configured
    // storage credentials into process.env so the existing
    // buildStorageClient(process.env) call sites pick them up. Safe to
    // await: bootCrypto resolves before the server starts handling
    // requests (it's fire-and-forget from this point of view, but the
    // promise chain serializes).
    const { applyStorageSettingsFromDb } = await import('./admin/storage-settings/boot');
    await applyStorageSettingsFromDb(db);
  })
  .catch((err) => {
    logger.error({ err }, 'crypto boot failed — appliance will report locked');
  });

// 0096 — ensure the support knowledge base is seeded for every firm.
// Fire-and-forget + idempotent (insert-missing-only), so it ships KB
// content with each deploy without clobbering admin-edited articles.
// Skipped gracefully if the table isn't migrated yet.
void (async () => {
  try {
    const firmRows = await db.select({ id: firms.id }).from(firms);
    for (const f of firmRows) {
      await seedKnowledgeBase(db, f.id);
    }
    if (firmRows.length > 0) {
      logger.info({ firms: firmRows.length }, 'knowledge base ensured');
    }
  } catch (err) {
    logger.warn({ err }, 'knowledge-base seed skipped (not migrated yet?)');
  }
})();
const isProd = config.NODE_ENV === 'production';
const MAX_LISTEN_ATTEMPTS = isProd ? 16 : Number.POSITIVE_INFINITY;
let listenAttempt = 0;
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE' && listenAttempt < MAX_LISTEN_ATTEMPTS) {
    listenAttempt += 1;
    const delayMs = Math.min(250 * Math.pow(1.5, listenAttempt - 1), 3000);
    logger.warn(
      { port: config.PORT, attempt: listenAttempt, delayMs },
      'api port busy, retrying listen (likely tsx watch hot-reload race)',
    );
    setTimeout(() => server.listen(config.PORT), delayMs);
    return;
  }
  logger.fatal({ err }, 'failed to bind api port — giving up');
  process.exit(1);
});

// QA fix — Node 24 terminates on unhandled promise rejection by default,
// which is too aggressive for an HTTP server: a bug in one handler's
// async path takes down every other request in flight. Log it loudly
// and keep serving; the calling request will already have surfaced a
// 5xx (or whatever express's default error handler emitted).
process.on('unhandledRejection', (reason, promise) => {
  logger.error(
    { reason, promise: String(promise) },
    'unhandled promise rejection — kept process alive',
  );
});
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'uncaught exception — kept process alive');
});

// Graceful shutdown so a SIGTERM/SIGINT from tsx watch releases the
// port promptly instead of leaving it bound until the OS reaps the
// process. Without this the next tsx run wastes 5+ seconds in retries.
function shutdownGracefully(signal: string): void {
  logger.info({ signal }, 'received shutdown signal — closing api server');
  server.close((err) => {
    if (err) logger.warn({ err }, 'server.close errored, exiting anyway');
    process.exit(0);
  });
  // Hard exit if server.close hangs (e.g. lingering keep-alive sockets).
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => shutdownGracefully('SIGTERM'));
process.on('SIGINT', () => shutdownGracefully('SIGINT'));
