// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// API-side tax-return intake: the parse-free core (intake-core.ts) plus a
// best-effort PDF outline parse. The route and any API caller use this;
// the worker uses createTaxReturnFromFileCore directly (no pdfjs).

import type { Database } from '@vibe/db';
import type { StorageClient } from '@vibe/storage';

import { logger } from '../logger';
import { applyParsedSections, parseReturnSections } from './parse';
import {
  createTaxReturnFromFileCore,
  type IntakeTaxReturnArgs,
  type IntakeTaxReturnResult,
} from './intake-core';

export type { IntakeTaxReturnArgs, IntakeTaxReturnResult } from './intake-core';

export async function intakeTaxReturnFromFile(
  db: Database,
  storage: StorageClient | null,
  args: IntakeTaxReturnArgs,
): Promise<IntakeTaxReturnResult> {
  const result = await createTaxReturnFromFileCore(db, args);
  if (!result.ok) return result;

  // Best-effort automated parse — never blocks on failure.
  if (storage && result.fileStorageKey) {
    try {
      const parsedSections = await parseReturnSections({
        storage,
        sourceStorageKey: result.fileStorageKey,
      });
      if (parsedSections.strategy !== 'single') {
        await applyParsedSections(db, result.taxReturnId, parsedSections);
      }
    } catch (err) {
      logger.warn(
        { err, returnId: result.taxReturnId },
        'auto-parse on intake failed; kept catch-all',
      );
    }
  }
  return result;
}
