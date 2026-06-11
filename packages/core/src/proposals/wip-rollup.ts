// SPDX-License-Identifier: Elastic-2.0
//
// P23 — Engagement WIP rollup + realization math.
//
// Pure helpers. The API endpoint hands raw time-entry rows in, the
// helpers fold them into per-user / per-work-code / per-engagement
// totals and compute realization. No DB access here.
//
// Realization conventions (from the addendum):
//   • Fixed-fee engagements: realization = fee / WIP$. A WIP of $1,200
//     against a $1,000 fixed fee shows 83% realization (under-priced),
//     while WIP of $800 against $1,000 shows 125% (over-priced).
//   • T&M (HOURLY / HOURLY_NTE) engagements: realization is 100% by
//     definition unless billings exist that differ from WIP. We expose
//     `billedCents` for that case but default to WIP.
//   • RECURRING_SUBSCRIPTION: realization = (sum of recurring fees
//     billed across the WIP period) / WIP$. Caller passes
//     `billedCents` directly — this helper doesn't query invoices.

export type WipFeeStructure =
  | 'HOURLY'
  | 'HOURLY_NTE'
  | 'FIXED_FEE'
  | 'FIXED_FEE_WITH_MILESTONES'
  | 'RECURRING_SUBSCRIPTION';

export interface TimeEntryForWip {
  appUserId: string;
  workCodeId: string | null;
  // hours stored as numeric in PG — accept string or number; we normalize.
  hours: string | number;
  standardRateSnapshotCents: number;
  billableFlag: boolean;
  inScopeFlag: boolean;
  outOfScopeOverride: boolean;
}

export interface WipRollupInput {
  feeStructure: WipFeeStructure;
  // Fee-amount-cents on the engagement. Required for FIXED_FEE
  // realization. Caller passes 0 / null and we treat as missing.
  feeAmountCents: number | null;
  // Optional billed amount (sum of invoice totals tied to this
  // engagement). Caller computes from invoices/line_items; this helper
  // doesn't touch the DB.
  billedCents?: number;
  entries: TimeEntryForWip[];
}

export interface WipPerUser {
  appUserId: string;
  hours: number;
  amountCents: number;
}

export interface WipPerWorkCode {
  // Null is grouped together under the synthetic key '__no_work_code'.
  workCodeId: string | null;
  hours: number;
  amountCents: number;
}

export interface WipRollupResult {
  totalHours: number;
  // Standard-rate WIP. Sum across every entry (billable or not).
  wipCents: number;
  // Just the billable subset. Useful for realization on T&M where
  // un-billable hours are pure write-offs.
  billableWipCents: number;
  // In-scope subset, factoring the out-of-scope-override veto. Drives
  // mixed-mode realization.
  inScopeWipCents: number;
  byUser: WipPerUser[];
  byWorkCode: WipPerWorkCode[];
  // realizationBps: null means "not meaningful" (zero WIP, or T&M
  // with no billed override). 10_000 = 100%.
  realizationBps: number | null;
  // Helper for the UI: explains how the realization was computed.
  realizationBasis: 'FIXED_FEE' | 'T_AND_M' | 'RECURRING_BILLED' | 'NONE';
}

function toHours(raw: string | number): number {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return Number.isFinite(n) ? n : 0;
}

const NO_WORK_CODE = '__no_work_code';

export function rollUpEngagementWip(input: WipRollupInput): WipRollupResult {
  let totalHours = 0;
  let wipCents = 0;
  let billableWipCents = 0;
  let inScopeWipCents = 0;
  const userAgg = new Map<string, WipPerUser>();
  const wcAgg = new Map<string, WipPerWorkCode>();

  for (const e of input.entries) {
    const hrs = toHours(e.hours);
    if (hrs <= 0) continue;
    const cents = Math.round(hrs * e.standardRateSnapshotCents);
    totalHours += hrs;
    wipCents += cents;
    if (e.billableFlag) billableWipCents += cents;
    if (e.inScopeFlag && !e.outOfScopeOverride) inScopeWipCents += cents;

    const u = userAgg.get(e.appUserId);
    if (u) {
      u.hours += hrs;
      u.amountCents += cents;
    } else {
      userAgg.set(e.appUserId, { appUserId: e.appUserId, hours: hrs, amountCents: cents });
    }
    const wcKey = e.workCodeId ?? NO_WORK_CODE;
    const w = wcAgg.get(wcKey);
    if (w) {
      w.hours += hrs;
      w.amountCents += cents;
    } else {
      wcAgg.set(wcKey, {
        workCodeId: e.workCodeId,
        hours: hrs,
        amountCents: cents,
      });
    }
  }

  // Realization
  let realizationBps: number | null = null;
  let realizationBasis: WipRollupResult['realizationBasis'] = 'NONE';
  if (wipCents > 0) {
    if (
      (input.feeStructure === 'FIXED_FEE' || input.feeStructure === 'FIXED_FEE_WITH_MILESTONES') &&
      input.feeAmountCents != null &&
      input.feeAmountCents > 0
    ) {
      realizationBps = Math.round((input.feeAmountCents / wipCents) * 10_000);
      realizationBasis = 'FIXED_FEE';
    } else if (
      input.feeStructure === 'RECURRING_SUBSCRIPTION' &&
      typeof input.billedCents === 'number' &&
      input.billedCents > 0
    ) {
      realizationBps = Math.round((input.billedCents / wipCents) * 10_000);
      realizationBasis = 'RECURRING_BILLED';
    } else if (input.feeStructure === 'HOURLY' || input.feeStructure === 'HOURLY_NTE') {
      // T&M: 100% by definition. Caller may pass an explicit positive
      // billedCents to surface write-offs (billed < WIP). billedCents of
      // 0 means "no invoices yet" — still 100%.
      if (typeof input.billedCents === 'number' && input.billedCents > 0) {
        realizationBps = Math.round((input.billedCents / wipCents) * 10_000);
      } else {
        realizationBps = 10_000;
      }
      realizationBasis = 'T_AND_M';
    }
  }

  return {
    totalHours: Math.round(totalHours * 100) / 100,
    wipCents,
    billableWipCents,
    inScopeWipCents,
    byUser: Array.from(userAgg.values()).sort((a, b) => b.amountCents - a.amountCents),
    byWorkCode: Array.from(wcAgg.values()).sort((a, b) => b.amountCents - a.amountCents),
    realizationBps,
    realizationBasis,
  };
}

// =====================================================================
// CSV export — pure string builder, no I/O.
//
// One file with three blocks: summary, per-user, per-work-code. Block
// headers are written as comment-like rows so a recipient who only
// opens the first sheet still has context.
// =====================================================================

function csvCell(raw: string | number | null | undefined): string {
  if (raw == null) return '';
  const s = String(raw);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toRow(cells: (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(',');
}

export interface WipCsvContext {
  engagementName: string;
  feeStructure: WipFeeStructure;
  feeAmountCents: number | null;
  userNames?: Record<string, string>;
  workCodeNames?: Record<string, string>;
}

export function wipRollupToCsv(rollup: WipRollupResult, ctx: WipCsvContext): string {
  const lines: string[] = [];
  lines.push(toRow(['# Engagement', ctx.engagementName]));
  lines.push(toRow(['# Fee structure', ctx.feeStructure]));
  if (ctx.feeAmountCents != null) {
    lines.push(toRow(['# Fee amount (cents)', ctx.feeAmountCents]));
  }
  lines.push(toRow(['# Realization basis', rollup.realizationBasis]));
  if (rollup.realizationBps != null) {
    lines.push(toRow(['# Realization', `${(rollup.realizationBps / 100).toFixed(2)}%`]));
  }
  lines.push('');
  lines.push(toRow(['Summary']));
  lines.push(toRow(['total_hours', 'wip_cents', 'billable_wip_cents', 'in_scope_wip_cents']));
  lines.push(
    toRow([rollup.totalHours, rollup.wipCents, rollup.billableWipCents, rollup.inScopeWipCents]),
  );
  lines.push('');
  lines.push(toRow(['By user']));
  lines.push(toRow(['app_user_id', 'user_name', 'hours', 'amount_cents']));
  for (const u of rollup.byUser) {
    lines.push(toRow([u.appUserId, ctx.userNames?.[u.appUserId] ?? '', u.hours, u.amountCents]));
  }
  lines.push('');
  lines.push(toRow(['By work code']));
  lines.push(toRow(['work_code_id', 'work_code_name', 'hours', 'amount_cents']));
  for (const w of rollup.byWorkCode) {
    const id = w.workCodeId ?? '';
    const name = w.workCodeId ? (ctx.workCodeNames?.[w.workCodeId] ?? '') : '(no work code)';
    lines.push(toRow([id, name, w.hours, w.amountCents]));
  }
  return lines.join('\n') + '\n';
}
