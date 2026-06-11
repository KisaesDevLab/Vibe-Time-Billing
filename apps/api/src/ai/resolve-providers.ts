// SPDX-License-Identifier: Elastic-2.0
//
// 0100 — request-time AI provider resolution from UI-entered credentials.
//
// AI keys used to come only from env (baked into boot-time singletons).
// With Admin → AI settings, a firm stores MFK-wrapped keys in
// ai_provider_credential. This module decrypts them and builds the
// concrete AiProvider clients on demand, so UI edits take effect without
// a restart. pickProvider() prefers these and falls back to the env
// providers when a firm has configured none.
//
// Results are cached per firm (short TTL) and explicitly invalidated by
// the credential routes on save/delete.

import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { aiProviderCredential } from '@vibe/db/schema';
import type { AiProvider } from '@vibe/core/ai';

import { getFirmKeyManager } from '../crypto/manager';
import { logger } from '../logger';
import { createAnthropicProvider } from './anthropic';
import { createOllamaProvider } from './ollama';
import { createOpenAiCompatibleProvider } from './openai-compatible';

export interface ResolvedFirmProviders {
  cloud: AiProvider | null;
  local: AiProvider | null;
}

interface CacheEntry {
  value: ResolvedFirmProviders;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

/** Drop a firm's cached providers — called whenever its credentials change. */
export function invalidateFirmProviders(firmId: string): void {
  cache.delete(firmId);
}

const EMPTY: ResolvedFirmProviders = { cloud: null, local: null };

/**
 * Build the cloud + local AiProvider for a firm from its stored
 * credentials. Returns nulls (not throwing) when the firm has no usable
 * config or the appliance key store is locked — callers fall back to env.
 */
export async function resolveFirmProviders(
  db: Database | null,
  firmId: string,
): Promise<ResolvedFirmProviders> {
  if (!db) return EMPTY;

  const hit = cache.get(firmId);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  let rows: Array<typeof aiProviderCredential.$inferSelect>;
  try {
    rows = await db
      .select()
      .from(aiProviderCredential)
      .where(and(eq(aiProviderCredential.firmId, firmId), eq(aiProviderCredential.enabled, true)));
  } catch (err) {
    logger.warn({ err, firmId }, 'ai: credential load failed');
    return EMPTY;
  }

  let cloud: AiProvider | null = null;
  let local: AiProvider | null = null;
  const keyMgr = getFirmKeyManager(db);

  for (const row of rows) {
    try {
      const apiKey = row.apiKeyEncrypted
        ? new TextDecoder('utf-8').decode(keyMgr.unwrapTDek(firmId, row.apiKeyEncrypted))
        : undefined;

      if (row.providerId === 'anthropic') {
        if (!apiKey) continue;
        // anthropic factory takes cents-per-1M directly.
        cloud ??= createAnthropicProvider({
          apiKey,
          model: row.model ?? undefined,
          inputCentsPerMTok: row.inputCentsPerMtok ?? undefined,
          outputCentsPerMTok: row.outputCentsPerMtok ?? undefined,
        });
      } else if (row.providerId === 'openai_compatible') {
        if (!row.baseUrl) continue;
        // openai factory takes cents-per-1K — convert from per-1M.
        cloud ??= createOpenAiCompatibleProvider({
          baseUrl: row.baseUrl,
          apiKey,
          model: row.model ?? 'gpt-4o-mini',
          costPer1kInputCents:
            row.inputCentsPerMtok != null ? row.inputCentsPerMtok / 1000 : undefined,
          costPer1kOutputCents:
            row.outputCentsPerMtok != null ? row.outputCentsPerMtok / 1000 : undefined,
        });
      } else if (row.providerId === 'ollama') {
        local ??= createOllamaProvider({
          url: row.baseUrl ?? undefined,
          model: row.model ?? 'qwen3:8b',
        });
      }
    } catch (err) {
      // Most likely the key store is locked — skip this provider.
      logger.warn({ err, firmId, providerId: row.providerId }, 'ai: provider build failed');
    }
  }

  const value: ResolvedFirmProviders = { cloud, local };
  cache.set(firmId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}
