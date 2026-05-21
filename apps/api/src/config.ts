// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Environment configuration with startup validation.
//
// The two JWT secrets are intentionally distinct — staff and portal
// sessions live in separate realms (CLAUDE.md non-negotiable #2). Loading
// fails fast if either is missing in production.

import { z } from 'zod';

const NODE_ENV_VALUES = ['development', 'test', 'production'] as const;

const Schema = z.object({
  NODE_ENV: z.enum(NODE_ENV_VALUES).default('development'),
  LOG_LEVEL: z.string().default('info'),
  PORT: z.coerce.number().int().positive().default(3001),

  APP_BASE_URL: z.string().url().default('http://localhost:5173'),
  PORTAL_BASE_URL: z.string().url().default('http://localhost:5174'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  STAFF_JWT_SECRET: z.string().min(16),
  PORTAL_JWT_SECRET: z.string().min(16),
  STAFF_COOKIE_NAME: z.string().default('__vibe_app_session'),
  PORTAL_COOKIE_NAME: z.string().default('__vibe_portal_session'),

  STEP_UP_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(30),
  MAGIC_LINK_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  SMS_OTP_TTL_MINUTES: z.coerce.number().int().positive().default(5),

  MAIL_PROVIDER: z.enum(['smtp', 'postmark', 'resend', 'ses']).default('smtp'),
  SMS_PROVIDER: z.enum(['textlink', 'twilio', 'sns']).default('textlink'),

  COMMERCIAL_LICENSE_TOKEN: z.string().optional(),
  MCP_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  MCP_PORT: z.coerce.number().int().positive().default(3002),

  AI_DEFAULT_MONTHLY_BUDGET_CENTS: z.coerce.number().int().nonnegative().default(10000),
  // Provider secrets — all optional; presence drives wiring in server.ts.
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  AI_CLOUD_API_KEY: z.string().optional(),
  AI_CLOUD_MODEL: z.string().default('claude-opus-4-7'),
  AI_LOCAL_URL: z.string().default('http://localhost:11434'),
  AI_LOCAL_MODEL: z.string().optional(),
  // Phase 23 #4 — OpenAI-compatible provider (vLLM, Groq, Together, etc.)
  AI_OPENAI_BASE_URL: z.string().optional(),
  AI_OPENAI_API_KEY: z.string().optional(),
  AI_OPENAI_MODEL: z.string().optional(),
  AI_OPENAI_COST_INPUT_CENTS: z.coerce.number().nonnegative().optional(),
  AI_OPENAI_COST_OUTPUT_CENTS: z.coerce.number().nonnegative().optional(),
  VIBE_CONNECT_URL: z.string().optional(),
  VIBE_CONNECT_API_KEY: z.string().optional(),
  // Mail provider secrets — only the matching one is read per MAIL_PROVIDER.
  MAIL_FROM: z.string().default('Vibe Time & Billing <[email protected]>'),
  MAIL_SMTP_HOST: z.string().default('localhost'),
  MAIL_SMTP_PORT: z.coerce.number().int().positive().default(1025),
  MAIL_SMTP_SECURE: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  MAIL_SMTP_USER: z.string().optional(),
  MAIL_SMTP_PASS: z.string().optional(),
  MAIL_POSTMARK_TOKEN: z.string().optional(),
  MAIL_RESEND_API_KEY: z.string().optional(),
  // SMS provider secrets.
  SMS_TWILIO_ACCOUNT_SID: z.string().optional(),
  SMS_TWILIO_AUTH_TOKEN: z.string().optional(),
  SMS_TWILIO_FROM: z.string().optional(),
  SMS_TEXTLINK_API_KEY: z.string().optional(),
});

export type AppConfig = z.infer<typeof Schema>;

let cached: AppConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached) return cached;

  const isProd = env['NODE_ENV'] === 'production';
  // In dev/test we provide gentler defaults so the API boots without
  // configuration; in prod we require explicit values for secrets.
  const defaults = isProd
    ? {}
    : {
        DATABASE_URL: env['DATABASE_URL'] ?? 'postgresql://vibe:vibe@localhost:5432/vibe_tb',
        STAFF_JWT_SECRET: env['STAFF_JWT_SECRET'] ?? 'dev-staff-secret-please-rotate',
        PORTAL_JWT_SECRET: env['PORTAL_JWT_SECRET'] ?? 'dev-portal-secret-please-rotate',
      };

  const parsed = Schema.safeParse({ ...defaults, ...env });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  if (parsed.data.STAFF_JWT_SECRET === parsed.data.PORTAL_JWT_SECRET) {
    throw new Error('STAFF_JWT_SECRET and PORTAL_JWT_SECRET must differ (cross-realm isolation)');
  }

  cached = parsed.data;
  return cached;
}

export function resetConfigForTests(): void {
  cached = null;
}
