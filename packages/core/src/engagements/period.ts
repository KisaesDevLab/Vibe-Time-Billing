// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Period helpers for recurring engagements + template name patterns.
//
// Pure functions, no DB. Used by:
//   - apps/api engagement-create endpoint (resolveEngagementName)
//   - apps/api recurrence router and apps/worker recurring-engagement
//     job (advancePeriod)
//   - apps/web EngagementCreate live preview (resolveEngagementName)
//
// A `Period` is the (year, month, label) triple the user attaches to
// an engagement at creation. The free-text label is purely cosmetic —
// the worker carries it forward unchanged when spawning the next
// occurrence (firm can edit on the spawned engagement directly).

import type { RecurringFrequency } from '../billing/recurring';
import { resolveMergeTokens, type MergeContext, type MergeResult } from '../proposals/merge-tokens';

export interface Period {
  /** 4-digit calendar year. */
  year: number | null;
  /** 1-12, calendar month. */
  month: number | null;
  /** Free-form label like 'Q1 2026' / 'April 2026' / 'FY26'. */
  label: string | null;
}

/**
 * Roll a (year, month) forward by one cadence step. Returns a new
 * Period; the label is carried through unchanged because labels are
 * purely free-text and the firm may want to edit after spawn.
 *
 * Cadence semantics:
 *   WEEKLY / BIWEEKLY  — month + year stay (a week never crosses
 *                        boundaries in a useful way for the "period"
 *                        column; firms using weekly recurrence
 *                        typically don't fill the month field).
 *   MONTHLY            — +1 month, year rolls on Dec → Jan.
 *   QUARTERLY          — +3 months, year rolls.
 *   SEMIANNUAL         — +6 months, year rolls.
 *   ANNUAL             — +1 year, month stays.
 *
 * When `year` or `month` is null, the returned slot stays null. Worker
 * callers should still call this to keep the label pass-through, even
 * for null-year/null-month recurrences.
 */
export function advancePeriod(current: Period, frequency: RecurringFrequency): Period {
  const { year, month, label } = current;
  if (year == null && month == null) {
    return { year: null, month: null, label };
  }
  if (frequency === 'WEEKLY' || frequency === 'BIWEEKLY') {
    return { year, month, label };
  }
  if (frequency === 'ANNUAL') {
    return { year: year == null ? null : year + 1, month, label };
  }
  const step = frequency === 'MONTHLY' ? 1 : frequency === 'QUARTERLY' ? 3 : 6;
  if (month == null) {
    // No month to advance — bump year only when the step is >= 12.
    return { year, month, label };
  }
  // Convert (year, month) to a 0-indexed month count, advance, decode.
  const baseYear = year ?? 0;
  const total = baseYear * 12 + (month - 1) + step;
  const newYear = year == null ? null : Math.floor(total / 12);
  const newMonth = (((total % 12) + 12) % 12) + 1;
  return { year: newYear, month: newMonth, label };
}

export interface EngagementNameContext {
  client?: { name?: string | null } & Record<string, unknown>;
  engagement?: Record<string, unknown>;
  period?: Period;
  today?: string;
}

/**
 * Resolve an engagement-template name pattern against a context. Thin
 * wrapper around resolveMergeTokens that adapts our (Period | null,
 * client, today) shape into the MergeContext the resolver expects.
 *
 * Returns the resolved string + any tokens the pattern referenced
 * that we couldn't bind (UI can surface as a validation warning).
 *
 * Empty/null pattern returns empty output + no unresolved tokens.
 */
export function resolveEngagementName(
  pattern: string | null | undefined,
  ctx: EngagementNameContext,
): MergeResult {
  if (!pattern || pattern.trim().length === 0) {
    return { output: '', unresolvedTokens: [] };
  }
  const merge: MergeContext = {};
  if (ctx.client) {
    merge['client'] = ctx.client as Record<string, unknown>;
  }
  if (ctx.engagement) {
    merge['engagement'] = ctx.engagement;
  }
  if (ctx.period) {
    merge['period'] = {
      year: ctx.period.year == null ? '' : String(ctx.period.year),
      month: ctx.period.month == null ? '' : String(ctx.period.month),
      label: ctx.period.label ?? '',
    };
  }
  if (ctx.today) {
    merge['today'] = ctx.today;
  }
  return resolveMergeTokens(pattern, merge);
}
