// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
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
  // 0181 — internet-facing origin that serves the no-login pay-by-link page
  // (/pay/:token) and the public /api/pay surface. Distinct from
  // PORTAL_BASE_URL because the pay page must be reachable WITHOUT a portal
  // session. Defaults to PORTAL_BASE_URL when unset (single-host deploys).
  PUBLIC_BASE_URL: z.string().url().optional(),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  STAFF_JWT_SECRET: z.string().min(16),
  PORTAL_JWT_SECRET: z.string().min(16),
  STAFF_COOKIE_NAME: z.string().default('__vibe_app_session'),
  PORTAL_COOKIE_NAME: z.string().default('__vibe_portal_session'),

  STEP_UP_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(30),
  MAGIC_LINK_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  SMS_OTP_TTL_MINUTES: z.coerce.number().int().positive().default(5),

  MAIL_PROVIDER: z.enum(['smtp', 'postmark', 'resend', 'ses', 'emailit']).default('smtp'),
  // EmailIt v2 attachment delivery. 'inline' (default) embeds base64 bytes in
  // the send payload; 'url' stashes bytes in the in-memory mail-asset store
  // and hands EmailIt a short-lived public URL to fetch. 'url' requires the
  // appliance to be reachable from the internet at PUBLIC_BASE_URL (or
  // PORTAL_BASE_URL) — keep 'inline' on LAN-only deployments.
  MAIL_EMAILIT_ATTACHMENT_MODE: z.enum(['inline', 'url']).default('inline'),
  SMS_PROVIDER: z.enum(['textlink', 'twilio', 'sns']).default('textlink'),

  // v2 Sprint A — at-rest encryption key for DB-backed messaging
  // provider config (AES-256-GCM). 32 bytes encoded as base64 or hex.
  // In dev a deterministic placeholder is used so the API boots without
  // setup. In prod the loader requires an explicit value (see below).
  KMS_KEY: z.string().optional(),

  MCP_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  MCP_PORT: z.coerce.number().int().positive().default(3002),

  AI_DEFAULT_MONTHLY_BUDGET_CENTS: z.coerce.number().int().nonnegative().default(10000),
  // 0185 — Vibe Print LAN gateway fallback (firm DB config overrides these).
  PRINT_GATEWAY_BASE_URL: z.string().optional(),
  PRINT_GATEWAY_API_KEY: z.string().optional(),
  // Provider secrets — all optional; presence drives wiring in server.ts.
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  // 0055 — surfaced to the staff Receive-Payment page via /payments/config
  // so Stripe Elements can initialize without baking the key into the Vite
  // build (rotation would otherwise require a redeploy).
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  // P08 — Stripe Connect Standard OAuth. Platform client id lives at
  // https://dashboard.stripe.com/settings/connect (ca_…). Operator
  // sets STRIPE_CONNECT_CLIENT_ID + STRIPE_SECRET_KEY on the box;
  // firms onboard their own Standard accounts via the OAuth dance.
  STRIPE_CONNECT_CLIENT_ID: z.string().optional(),
  STRIPE_CONNECT_REDIRECT_URI: z.string().optional(),
  // P12 — separate webhook secret for the Connect platform's events
  // stream (account.updated / invoice.paid / subscription.* / etc.).
  // Distinct from STRIPE_WEBHOOK_SECRET which guards the firm's
  // direct-charge events from the BYO Stripe key flow.
  STRIPE_CONNECT_WEBHOOK_SECRET: z.string().optional(),
  // P16 — per-firm signature HMAC keys derive from this seed +
  // firm_id. Falls back to PORTAL_JWT_SECRET if unset so a fresh
  // appliance gets coverage; production should set this to a
  // dedicated 32+-byte value rotated on its own cadence.
  PROPOSAL_SIGNATURE_HMAC_SEED: z.string().optional(),
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
  // MIG-8 — Vibe AI Router dual-mode. "router" sends every AI feature through
  // the appliance's Vibe AI Router (task classes + router policy pick the
  // model; the provider settings above and the firm credential/egress/budget
  // machinery become inert). Requires both URL and token — loadConfig refuses
  // to boot otherwise — and never silently falls back to direct.
  VIBE_AI_MODE: z.enum(['direct', 'router']).default('direct'),
  VIBE_AI_ROUTER_URL: z.string().optional(),
  VIBE_AI_TOKEN: z.string().optional(),
  // Capture Client Info — local GLM-OCR endpoint on the firm's on-prem
  // workstation. Presence of GLM_OCR_URL is what enables the /api/staff/ocr
  // client-intake surface (server.ts wires the client only when set). The
  // reference llama-server is unauthenticated on the LAN, so the API key is
  // optional. All OCR stays on the LAN — screenshots never leave the box.
  GLM_OCR_URL: z.string().url().optional(),
  GLM_OCR_MODEL: z.string().default('glm-ocr'),
  GLM_OCR_API_KEY: z.string().optional(),
  // DS-3 — desktop shell auto-update / installer download. A directory on
  // the appliance holding `latest.json` (Tauri updater manifest) plus the
  // signed installers it references. Unset → /desktop/latest.json answers
  // 404 and the Account page hides the download card.
  DESKTOP_RELEASES_DIR: z.string().optional(),
  GLM_OCR_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  VIBE_CONNECT_URL: z.string().optional(),
  VIBE_CONNECT_API_KEY: z.string().optional(),
  // Q35 — OpenSign e-signature (AGPL; deployed standalone via
  // ops/docker/opensign/, reached over HTTP — see LICENSING.md). All
  // optional: presence of OPENSIGN_URL is what makes the per-firm
  // 'opensign' provider selectable. Absent → native is always used and
  // the admin UI hides the opensign option.
  //
  // OpenSign self-host is a Parse Server; server-to-server auth is the
  // Parse header pair (App-Id + Master-Key), NOT a bearer/x-api-token.
  // OPENSIGN_URL is the Parse API base, e.g.
  //   https://opensign-caddy:4001/api/app  (via caddy), or
  //   http://opensign-server:8080/app      (direct, in-network).
  OPENSIGN_URL: z.string().optional(),
  OPENSIGN_APP_ID: z.string().default('opensign'),
  OPENSIGN_MASTER_KEY: z.string().optional(),
  // Public UI origin for building signer URLs (defaults: derived from
  // OPENSIGN_URL by stripping /api/app or /app).
  OPENSIGN_PUBLIC_URL: z.string().optional(),
  // Operator-provisioned OpenSign account used to mint a Parse session
  // token for the write paths (savefile/savecontact/createdocumentfromapp
  // require request.user). Without these, createEnvelope errors clearly
  // but read/status/cert paths (master-keyed) still work.
  OPENSIGN_API_EMAIL: z.string().optional(),
  OPENSIGN_API_PASSWORD: z.string().optional(),
  // The 64-char "Webhook Security Key" minted in the OpenSign UI
  // (Settings → Webhook). HMAC-SHA256 secret for the x-webhook-signature
  // header on inbound webhooks.
  OPENSIGN_WEBHOOK_SECRET: z.string().optional(),
  // CAL-2 — Appliance-level calendar OAuth app. When set, staff connect
  // their OWN Microsoft 365 / Google calendar by signing in (each user
  // consents only for their own mailbox) — no per-firm app registration and
  // no org-wide admin consent. Used as the fallback when a firm hasn't
  // pasted its own credentials. Register ONE app and point its redirect URI
  // at {APP_BASE_URL}/api/calendar/oauth/callback/{microsoft|google}.
  // Microsoft tenant 'common' = work + personal accounts (multi-tenant).
  CALENDAR_MS_CLIENT_ID: z.string().optional(),
  CALENDAR_MS_CLIENT_SECRET: z.string().optional(),
  CALENDAR_MS_TENANT_ID: z.string().default('common'),
  CALENDAR_GOOGLE_CLIENT_ID: z.string().optional(),
  CALENDAR_GOOGLE_CLIENT_SECRET: z.string().optional(),
  // Mail provider secrets — only the matching one is read per MAIL_PROVIDER.
  MAIL_FROM: z.string().default('Vibe Practice Management <[email protected]>'),
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
  MAIL_EMAILIT_API_KEY: z.string().optional(),
  // SMS provider secrets.
  SMS_TWILIO_ACCOUNT_SID: z.string().optional(),
  SMS_TWILIO_AUTH_TOKEN: z.string().optional(),
  SMS_TWILIO_FROM: z.string().optional(),
  SMS_TEXTLINK_API_KEY: z.string().optional(),
  // 0121 — automated voice (phone-call) appointment reminders via Twilio Voice.
  // May reuse the SMS Twilio account; FROM must be a voice-capable number.
  VOICE_PROVIDER: z.enum(['console', 'twilio']).default('console'),
  VOICE_TWILIO_ACCOUNT_SID: z.string().optional(),
  VOICE_TWILIO_AUTH_TOKEN: z.string().optional(),
  VOICE_TWILIO_FROM: z.string().optional(),
  // Web Push (VAPID) for the installable client portal PWA. All optional —
  // presence of both keys is what enables push (the portal hides the toggle
  // and the worker no-ops otherwise). Generate once with
  // `npx web-push generate-vapid-keys`; the public key is exposed to the
  // portal SPA, the private key signs pushes on the worker.
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:[email protected]'),
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
        // Deterministic dev placeholder so messaging-config round-trip
        // works locally without setup. Production loader (below) requires
        // an explicit value.
        KMS_KEY:
          env['KMS_KEY'] ??
          // 32 bytes of zeros encoded as hex — explicitly insecure, dev only.
          '0000000000000000000000000000000000000000000000000000000000000000',
      };

  const parsed = Schema.safeParse({ ...defaults, ...env });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  if (parsed.data.STAFF_JWT_SECRET === parsed.data.PORTAL_JWT_SECRET) {
    throw new Error('STAFF_JWT_SECRET and PORTAL_JWT_SECRET must differ (cross-realm isolation)');
  }

  if (isProd && !parsed.data.KMS_KEY) {
    throw new Error('KMS_KEY is required in production (32 bytes, base64 or hex)');
  }

  // MIG-8: refuse to boot on a half-configured router mode — limping to
  // request time produces a worse error for every AI feature.
  if (
    parsed.data.VIBE_AI_MODE === 'router' &&
    (!parsed.data.VIBE_AI_ROUTER_URL || !parsed.data.VIBE_AI_TOKEN)
  ) {
    throw new Error(
      'VIBE_AI_MODE=router requires both VIBE_AI_ROUTER_URL and VIBE_AI_TOKEN ' +
        '(the appliance mints the token during "vibe enable"), or set VIBE_AI_MODE=direct.',
    );
  }

  cached = parsed.data;
  return cached;
}

export function resetConfigForTests(): void {
  cached = null;
}
