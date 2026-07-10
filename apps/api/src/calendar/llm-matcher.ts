// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// CAL-4 — LLM matching tier STUB (v1.5). Interface + feature flag only; the
// body is intentionally unimplemented. Enable via FEATURE_LLM_CALENDAR_MATCH
// once a local Qwen3 matcher is wired (deferred). Callers must check
// isLlmMatchEnabled() before invoking.

import type { ClientForMatch, EventForMatch, MatchResult } from './matcher';

export function isLlmMatchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['FEATURE_LLM_CALENDAR_MATCH'] === 'true';
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function matchWithLLM(
  _event: EventForMatch,
  _clients: ClientForMatch[],
  _firmId: string,
): Promise<MatchResult> {
  throw new Error('LLM matching not implemented in v1');
}
