// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0100 — Admin → AI settings. Lets a firm enter its own AI provider keys
// through the UI instead of env vars. API keys are MFK-wrapped at rest
// (same firm key manager as the Cloudflare tunnel token) and only ever
// returned to the UI as a last-4 hint. Saving/removing invalidates the
// per-firm provider cache so changes take effect without a restart.
//
//   GET    /                  current providers (redacted) + egress + budget
//   PUT    /:providerId       upsert a provider's config (key optional on edit)
//   POST   /:providerId/test  build the provider and ping it
//   DELETE /:providerId       remove a provider's credentials
//
// Reads: firm:settings:read. Writes/test: firm:settings:write.

import express, { type Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import type { Database } from '@vibe/db';
import { aiProviderCredential, firmConfig, firmSettings } from '@vibe/db/schema';
import type { AiProvider } from '@vibe/core/ai';

import { emitAudit } from '../../auth/audit';
import { requirePermission, type RbacDeps } from '../../auth/rbac-middleware';
import { getApplianceLockState } from '../../crypto/boot';
import { getFirmKeyManager } from '../../crypto/manager';
import { SHIELD_REACHABLE_KEY } from '../../ai/egress';
import { invalidateFirmProviders } from '../../ai/resolve-providers';
import { createAnthropicProvider } from '../../ai/anthropic';
import { aiMode, timeBillingTaskClassDeclarations } from '../../ai/vibe-router';
import { getAiRuntime, refreshAiRuntime } from '../../ai/ai-runtime';
import { VibeAiClient } from '@kisaes/vibe-ai-client';
import { createOllamaProvider } from '../../ai/ollama';
import { createOpenAiCompatibleProvider } from '../../ai/openai-compatible';

const PROVIDERS = ['anthropic', 'openai_compatible', 'ollama'] as const;
type ProviderId = (typeof PROVIDERS)[number];

interface ProviderInput {
  providerId: ProviderId;
  apiKey?: string;
  baseUrl?: string | null;
  model?: string | null;
}

export interface AiCredentialsRoutesDeps extends RbacDeps {
  db: Database | null;
  redis?: Redis;
  /** Injectable for tests — defaults to the real factory-based builder. */
  buildTestProvider?: (input: ProviderInput) => AiProvider | null;
}

const UpsertSchema = z.object({
  apiKey: z.string().min(1).max(400).optional(),
  baseUrl: z.string().url().max(500).nullable().optional(),
  model: z.string().max(200).nullable().optional(),
  inputCentsPerMtok: z.number().int().nonnegative().max(1_000_000).nullable().optional(),
  outputCentsPerMtok: z.number().int().nonnegative().max(1_000_000).nullable().optional(),
  enabled: z.boolean().optional(),
});

function isProviderId(v: string): v is ProviderId {
  return (PROVIDERS as readonly string[]).includes(v);
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function fromBytes(b: Uint8Array): string {
  return new TextDecoder('utf-8').decode(b);
}

function hint(key: string): string {
  return key.length > 4 ? `••••${key.slice(-4)}` : '••••';
}

function defaultBuildProvider(input: ProviderInput): AiProvider | null {
  switch (input.providerId) {
    case 'anthropic':
      return input.apiKey
        ? createAnthropicProvider({ apiKey: input.apiKey, model: input.model ?? undefined })
        : null;
    case 'openai_compatible':
      return input.baseUrl
        ? createOpenAiCompatibleProvider({
            baseUrl: input.baseUrl,
            apiKey: input.apiKey,
            model: input.model ?? 'gpt-4o-mini',
          })
        : null;
    case 'ollama':
      return createOllamaProvider({
        url: input.baseUrl ?? undefined,
        model: input.model ?? 'qwen3:8b',
      });
  }
}

export function createAiCredentialsRouter(deps: AiCredentialsRoutesDeps): Router {
  const router = express.Router();
  const buildProvider = deps.buildTestProvider ?? defaultBuildProvider;

  // -------------------------------------------------------------------
  // GET / — providers (redacted) + egress policy + budget.
  // -------------------------------------------------------------------
  router.get('/', requirePermission(deps, 'firm:settings:read'), async (req, res) => {
    const firmId = req.staffSession?.firmId;
    if (!firmId || !deps.db) {
      res.json({ providers: [], egress: null, budget: null, aiMode: aiMode() });
      return;
    }
    const rows = await deps.db
      .select()
      .from(aiProviderCredential)
      .where(eq(aiProviderCredential.firmId, firmId));
    const [cfg] = await deps.db
      .select({
        aiEgressEnabled: firmConfig.aiEgressEnabled,
        aiEgressMode: firmConfig.aiEgressMode,
        vibeShieldEndpoint: firmConfig.vibeShieldEndpoint,
        aiModeSetting: firmConfig.aiMode,
        aiRouterUrl: firmConfig.aiRouterUrl,
        aiRouterTokenHint: firmConfig.aiRouterTokenHint,
        aiRouterHasToken: firmConfig.aiRouterTokenEncrypted,
        aiRouterStatus: firmConfig.aiRouterStatus,
        aiRouterLastError: firmConfig.aiRouterLastError,
        aiRouterLastTestedAt: firmConfig.aiRouterLastTestedAt,
      })
      .from(firmConfig)
      .where(eq(firmConfig.firmId, firmId))
      .limit(1);
    const [budget] = await deps.db
      .select({
        monthlyBudgetCents: firmSettings.aiMonthlyBudgetCents,
        warnThresholdPct: firmSettings.aiWarnThresholdPct,
      })
      .from(firmSettings)
      .where(eq(firmSettings.firmId, firmId))
      .limit(1);
    const shieldReachable = deps.redis
      ? (await deps.redis.get(SHIELD_REACHABLE_KEY)) === '1'
      : false;

    const rt = getAiRuntime();
    res.json({
      aiMode: aiMode(),
      // 0222 — the switch itself (Admin → AI settings → AI routing).
      aiModeConfig: {
        setting: (cfg?.aiModeSetting ?? 'env') as 'env' | 'direct' | 'router',
        effective: rt.mode,
        source: rt.source,
        problem: rt.problem,
        envMode: process.env['VIBE_AI_MODE'] === 'router' ? 'router' : 'direct',
        envRouterUrl: process.env['VIBE_AI_ROUTER_URL'] ?? null,
        routerUrl: cfg?.aiRouterUrl ?? null,
        hasToken: Boolean(cfg?.aiRouterHasToken),
        tokenHint: cfg?.aiRouterTokenHint ?? null,
        status: cfg?.aiRouterStatus ?? 'UNTESTED',
        lastError: cfg?.aiRouterLastError ?? null,
        lastTestedAt: cfg?.aiRouterLastTestedAt ?? null,
      },
      providers: rows.map((r) => ({
        providerId: r.providerId,
        hasKey: Boolean(r.apiKeyEncrypted),
        keyHint: r.apiKeyHint,
        baseUrl: r.baseUrl,
        model: r.model,
        inputCentsPerMtok: r.inputCentsPerMtok,
        outputCentsPerMtok: r.outputCentsPerMtok,
        enabled: r.enabled,
        status: r.status,
        lastError: r.lastError,
        lastTestedAt: r.lastTestedAt,
      })),
      egress: {
        enabled: cfg?.aiEgressEnabled ?? false,
        mode: cfg?.aiEgressMode ?? 'shield',
        shieldEndpoint: cfg?.vibeShieldEndpoint ?? null,
        shieldReachable,
      },
      budget: budget
        ? {
            monthlyBudgetCents: Number(budget.monthlyBudgetCents),
            warnThresholdPct: budget.warnThresholdPct,
          }
        : null,
    });
  });

  // -------------------------------------------------------------------
  // 0222 — AI routing mode (direct / Vibe AI Router / appliance default).
  // Mounted before /:providerId so the literal path wins.
  // -------------------------------------------------------------------
  const AiModeSchema = z.object({
    mode: z.enum(['env', 'direct', 'router']),
    routerUrl: z.string().url().max(500).optional(),
    // Omit to keep the stored token; send '' to clear it.
    token: z.string().max(4096).optional(),
  });

  async function probeRouter(
    baseUrl: string,
    token: string,
  ): Promise<{ ok: true; registered: number } | { ok: false; error: string }> {
    try {
      const client = new VibeAiClient({ baseUrl, token });
      const r = await client.registerTaskClasses(timeBillingTaskClassDeclarations());
      return { ok: true, registered: r.registered.length };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  router.put('/ai-mode', requirePermission(deps, 'firm:settings:write'), async (req, res) => {
    const firmId = req.staffSession?.firmId;
    const session = req.staffSession!;
    if (!firmId || !deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = AiModeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
      return;
    }
    const d = parsed.data;
    const [existing] = await deps.db
      .select({
        aiMode: firmConfig.aiMode,
        url: firmConfig.aiRouterUrl,
        tokenEnc: firmConfig.aiRouterTokenEncrypted,
      })
      .from(firmConfig)
      .where(eq(firmConfig.firmId, firmId))
      .limit(1);
    const patch: Partial<typeof firmConfig.$inferInsert> = {
      aiMode: d.mode,
      updatedAt: new Date(),
    };
    if (d.routerUrl !== undefined) patch.aiRouterUrl = d.routerUrl.replace(/\/+$/, '');
    if (d.token !== undefined) {
      if (d.token === '') {
        patch.aiRouterTokenEncrypted = null;
        patch.aiRouterTokenHint = null;
      } else {
        const lockState = getApplianceLockState();
        if (lockState.kind !== 'unlocked') {
          res.status(503).json({ error: 'appliance_locked', state: lockState.kind });
          return;
        }
        patch.aiRouterTokenEncrypted = getFirmKeyManager(deps.db).wrapTDek(firmId, utf8(d.token));
        patch.aiRouterTokenHint = hint(d.token);
      }
    }
    if (d.mode === 'router') {
      const url = patch.aiRouterUrl ?? existing?.url;
      const hasToken =
        patch.aiRouterTokenEncrypted !== undefined
          ? patch.aiRouterTokenEncrypted !== null
          : Boolean(existing?.tokenEnc);
      if (!url || !hasToken) {
        res.status(400).json({ error: 'router_requires_url_and_token' });
        return;
      }
    }
    // Saving resets the test status unless nothing router-related changed.
    if (d.routerUrl !== undefined || d.token !== undefined) {
      patch.aiRouterStatus = 'UNTESTED';
      patch.aiRouterLastError = null;
    }
    if (existing) {
      await deps.db.update(firmConfig).set(patch).where(eq(firmConfig.firmId, firmId));
    } else {
      await deps.db.insert(firmConfig).values({ firmId, ...patch });
    }
    await emitAudit(deps.db, {
      action: 'UPDATE',
      entityType: 'firm_config',
      entityId: firmId,
      actorAppUserId: session.appUserId,
      before: { aiMode: existing?.aiMode ?? 'env', aiRouterUrl: existing?.url ?? null },
      after: {
        aiMode: d.mode,
        aiRouterUrl: patch.aiRouterUrl ?? existing?.url ?? null,
        tokenChanged: d.token !== undefined,
      },
    });
    invalidateFirmProviders(firmId);
    const rt = await refreshAiRuntime(deps.db);
    res.json({ ok: true, effective: rt.mode, source: rt.source, problem: rt.problem });
  });

  // POST /ai-mode/test — probe a router (body overrides stored values; the
  // probe registers this app's task classes, which is idempotent).
  router.post('/ai-mode/test', requirePermission(deps, 'firm:settings:write'), async (req, res) => {
    const firmId = req.staffSession?.firmId;
    if (!firmId || !deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const body = z
      .object({ routerUrl: z.string().url().optional(), token: z.string().optional() })
      .safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const [row] = await deps.db
      .select({ url: firmConfig.aiRouterUrl, tokenEnc: firmConfig.aiRouterTokenEncrypted })
      .from(firmConfig)
      .where(eq(firmConfig.firmId, firmId))
      .limit(1);
    const url = (body.data.routerUrl ?? row?.url ?? '').replace(/\/+$/, '');
    let token = body.data.token ?? '';
    if (!token && row?.tokenEnc) {
      if (getApplianceLockState().kind !== 'unlocked') {
        res.status(503).json({ error: 'appliance_locked' });
        return;
      }
      token = fromBytes(getFirmKeyManager(deps.db).unwrapTDek(firmId, row.tokenEnc));
    }
    if (!url || !token) {
      res.status(400).json({ error: 'router_requires_url_and_token' });
      return;
    }
    const result = await probeRouter(url, token);
    await deps.db
      .update(firmConfig)
      .set({
        aiRouterStatus: result.ok ? 'OK' : 'ERROR',
        aiRouterLastError: result.ok ? null : result.error,
        aiRouterLastTestedAt: new Date(),
      })
      .where(eq(firmConfig.firmId, firmId));
    res.status(result.ok ? 200 : 502).json(result);
  });

  // -------------------------------------------------------------------
  // PUT /:providerId — upsert. Omitting apiKey on an existing row keeps
  // the stored key. anthropic requires a key; openai_compatible requires
  // a baseUrl.
  // -------------------------------------------------------------------
  router.put('/:providerId', requirePermission(deps, 'firm:settings:write'), async (req, res) => {
    const firmId = req.staffSession?.firmId;
    const session = req.staffSession!;
    if (!firmId || !deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const providerId = req.params.providerId ?? '';
    if (!isProviderId(providerId)) {
      res.status(400).json({ error: 'unknown_provider' });
      return;
    }
    const parsed = UpsertSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
      return;
    }
    const lockState = getApplianceLockState();
    if (parsed.data.apiKey && lockState.kind !== 'unlocked') {
      res.status(503).json({ error: 'appliance_locked', state: lockState.kind });
      return;
    }
    const d = parsed.data;

    const [existing] = await deps.db
      .select()
      .from(aiProviderCredential)
      .where(
        and(
          eq(aiProviderCredential.firmId, firmId),
          eq(aiProviderCredential.providerId, providerId),
        ),
      )
      .limit(1);

    // Per-provider required-config checks.
    const baseUrl = d.baseUrl !== undefined ? d.baseUrl : (existing?.baseUrl ?? null);
    if (providerId === 'anthropic' && !d.apiKey && !existing?.apiKeyEncrypted) {
      res.status(400).json({ error: 'api_key_required' });
      return;
    }
    if (providerId === 'openai_compatible' && !baseUrl) {
      res.status(400).json({ error: 'base_url_required' });
      return;
    }

    let apiKeyEncrypted = existing?.apiKeyEncrypted ?? null;
    let apiKeyHint = existing?.apiKeyHint ?? null;
    if (d.apiKey) {
      const keyMgr = getFirmKeyManager(deps.db);
      apiKeyEncrypted = keyMgr.wrapTDek(firmId, utf8(d.apiKey));
      apiKeyHint = hint(d.apiKey);
    }

    const values = {
      firmId,
      providerId,
      apiKeyEncrypted,
      apiKeyHint,
      baseUrl,
      model: d.model !== undefined ? d.model : (existing?.model ?? null),
      inputCentsPerMtok:
        d.inputCentsPerMtok !== undefined
          ? d.inputCentsPerMtok
          : (existing?.inputCentsPerMtok ?? null),
      outputCentsPerMtok:
        d.outputCentsPerMtok !== undefined
          ? d.outputCentsPerMtok
          : (existing?.outputCentsPerMtok ?? null),
      enabled: d.enabled !== undefined ? d.enabled : (existing?.enabled ?? true),
      // Config changed → mark untested until the next /test.
      status: 'UNTESTED',
      lastError: null,
      updatedAt: new Date(),
    };

    await deps.db
      .insert(aiProviderCredential)
      .values(values)
      .onConflictDoUpdate({
        target: [aiProviderCredential.firmId, aiProviderCredential.providerId],
        set: {
          apiKeyEncrypted: values.apiKeyEncrypted,
          apiKeyHint: values.apiKeyHint,
          baseUrl: values.baseUrl,
          model: values.model,
          inputCentsPerMtok: values.inputCentsPerMtok,
          outputCentsPerMtok: values.outputCentsPerMtok,
          enabled: values.enabled,
          status: values.status,
          lastError: values.lastError,
          updatedAt: values.updatedAt,
        },
      });
    invalidateFirmProviders(firmId);

    await emitAudit(deps.db, {
      action: 'UPDATE',
      entityType: 'ai_provider_credential',
      entityId: providerId,
      actorAppUserId: session.appUserId,
      after: { providerId, hasKey: Boolean(values.apiKeyEncrypted), enabled: values.enabled },
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    }).catch(() => undefined);

    res.json({ ok: true });
  });

  // -------------------------------------------------------------------
  // POST /:providerId/test — build the provider from submitted-or-stored
  // config and ping it. Makes a real outbound call. Persists the result.
  // -------------------------------------------------------------------
  router.post(
    '/:providerId/test',
    requirePermission(deps, 'firm:settings:write'),
    async (req, res) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const providerId = req.params.providerId ?? '';
      if (!isProviderId(providerId)) {
        res.status(400).json({ error: 'unknown_provider' });
        return;
      }
      const [existing] = await deps.db
        .select()
        .from(aiProviderCredential)
        .where(
          and(
            eq(aiProviderCredential.firmId, firmId),
            eq(aiProviderCredential.providerId, providerId),
          ),
        )
        .limit(1);

      // Use a key from the body if supplied (testing before save), else
      // decrypt the stored one.
      const bodyKey =
        typeof req.body?.apiKey === 'string' ? (req.body.apiKey as string) : undefined;
      let apiKey = bodyKey;
      if (!apiKey && existing?.apiKeyEncrypted) {
        const lockState = getApplianceLockState();
        if (lockState.kind !== 'unlocked') {
          res.status(503).json({ error: 'appliance_locked', state: lockState.kind });
          return;
        }
        apiKey = fromBytes(getFirmKeyManager(deps.db).unwrapTDek(firmId, existing.apiKeyEncrypted));
      }
      const baseUrl =
        typeof req.body?.baseUrl === 'string'
          ? (req.body.baseUrl as string)
          : (existing?.baseUrl ?? null);
      const model =
        typeof req.body?.model === 'string'
          ? (req.body.model as string)
          : (existing?.model ?? null);

      const provider = buildProvider({ providerId, apiKey, baseUrl, model });
      if (!provider) {
        res.status(400).json({ error: 'incomplete_config' });
        return;
      }

      let ok = false;
      let errorMessage: string | null = null;
      try {
        await provider.complete({ userPrompt: 'ping', maxTokens: 1 });
        ok = true;
      } catch (err) {
        errorMessage = err instanceof Error ? err.message : 'test failed';
      }

      // Persist the outcome only when a row already exists.
      if (existing) {
        await deps.db
          .update(aiProviderCredential)
          .set({
            status: ok ? 'OK' : 'ERROR',
            lastError: errorMessage,
            lastTestedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(aiProviderCredential.firmId, firmId),
              eq(aiProviderCredential.providerId, providerId),
            ),
          );
      }

      res.json({ ok, error: errorMessage });
    },
  );

  // -------------------------------------------------------------------
  // DELETE /:providerId — remove the credential row.
  // -------------------------------------------------------------------
  router.delete(
    '/:providerId',
    requirePermission(deps, 'firm:settings:write'),
    async (req, res) => {
      const firmId = req.staffSession?.firmId;
      const session = req.staffSession!;
      if (!firmId || !deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const providerId = req.params.providerId ?? '';
      if (!isProviderId(providerId)) {
        res.status(400).json({ error: 'unknown_provider' });
        return;
      }
      await deps.db
        .delete(aiProviderCredential)
        .where(
          and(
            eq(aiProviderCredential.firmId, firmId),
            eq(aiProviderCredential.providerId, providerId),
          ),
        );
      invalidateFirmProviders(firmId);
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'ai_provider_credential',
        entityId: providerId,
        actorAppUserId: session.appUserId,
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  return router;
}
