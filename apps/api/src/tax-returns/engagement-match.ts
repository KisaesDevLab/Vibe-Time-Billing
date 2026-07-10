// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Best-effort matching of a tax return to the client's engagement. A return
// carries (clientId, formCode, taxYear); an engagement carries returnType
// ('1040'|'1065'|'1120'|'1120S'|'1041'|'990') + taxYear. We link only on a
// single unambiguous ACTIVE, non-workflow-terminal match — zero or 2+ matches
// leave it null for manual override (staff pick it on the return).

import { and, eq, notInArray } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { engagements } from '@vibe/db/schema';

// Mirrors route-sheets/payment-import: workflow-terminal engagements are not
// live targets even while their lifecycle status is ACTIVE.
const TERMINAL_WORKFLOW = ['COMPLETED', 'CANCELED'];

/** Map a free-text return formCode to an engagement.returnType value, or null
 *  when it isn't one of the six tax families we recognize. */
export function formCodeToReturnType(formCode: string | null | undefined): string | null {
  const code = (formCode ?? '').trim().toUpperCase();
  if (!code) return null;
  if (code.startsWith('1040')) return '1040'; // 1040 / 1040-SR / 1040-NR
  if (code.startsWith('1120-S') || code === '1120S') return '1120S';
  if (code.startsWith('1120')) return '1120';
  if (code.startsWith('1065')) return '1065';
  if (code.startsWith('1041')) return '1041';
  if (code.startsWith('990')) return '990'; // 990 / 990-PF / 990-T
  return null;
}

export interface MatchEngagementArgs {
  clientId: string;
  formCode: string | null | undefined;
  taxYear: number;
}

/** Returns the single matching engagement id, or null when there's no
 *  unambiguous match (0 or 2+ candidates → leave for manual override). */
export async function matchEngagementForReturn(
  db: Database,
  args: MatchEngagementArgs,
): Promise<string | null> {
  const returnType = formCodeToReturnType(args.formCode);
  if (!returnType) return null;
  const rows = await db
    .select({ id: engagements.id })
    .from(engagements)
    .where(
      and(
        eq(engagements.clientId, args.clientId),
        eq(engagements.status, 'ACTIVE'),
        eq(engagements.returnType, returnType),
        eq(engagements.taxYear, args.taxYear),
        notInArray(engagements.workflowState, TERMINAL_WORKFLOW),
      ),
    )
    .limit(2);
  return rows.length === 1 ? rows[0]!.id : null;
}
