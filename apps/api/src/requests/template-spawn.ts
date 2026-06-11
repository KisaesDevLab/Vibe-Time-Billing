// SPDX-License-Identifier: Elastic-2.0
//
// Pure helper that turns a request template + a target (client +
// engagement + optional overrides) into the row payload(s) needed to
// insert a client_request + its items. Used by both POST /requests
// (single create from template) and POST /requests/bulk (fan-out).
//
// Mustache resolution happens here; the caller writes the rows. No DB
// dependency — pass in the loaded template + items + client name +
// engagement name.

import { resolveMergeTokens } from '@vibe/core/proposals';

export type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
export type ItemKind = 'QUESTION' | 'DOCUMENT' | 'SIGNATURE';

export interface TemplateInput {
  id: string;
  titlePattern: string;
  bodyPattern: string;
  defaultPriority: Priority;
  defaultDueOffsetDays: number | null;
  defaultReminderDaysBefore: number | null;
  defaultAssignedAppUserId: string | null;
  items: ReadonlyArray<{
    ordinal: number;
    label: string;
    body: string;
    itemKind: ItemKind;
    required: boolean;
    defaultDueOffsetDays: number | null;
  }>;
}

export interface SpawnContext {
  clientName: string | null;
  engagementName: string | null;
  today: string; // ISO YYYY-MM-DD
}

export interface SpawnOverrides {
  /** When set, replaces the resolved title. */
  titleOverride?: string;
  /** When set, replaces the resolved body. */
  bodyOverride?: string;
  priorityOverride?: Priority;
  /** Explicit due date overrides the offset calc. */
  dueDateOverride?: string | null;
  /** Explicit reminder overrides the template default. */
  reminderDaysBeforeOverride?: number | null;
  /** Explicit assignee overrides the template default. */
  assignedAppUserIdOverride?: string | null;
  /** Tags applied to the spawned request. */
  tags?: string[];
}

export interface SpawnedRequest {
  title: string;
  body: string;
  priority: Priority;
  dueDate: string | null;
  reminderDaysBefore: number | null;
  assignedAppUserId: string | null;
  tags: string[];
  items: Array<{
    ordinal: number;
    label: string;
    body: string;
    itemKind: ItemKind;
    required: boolean;
    dueDate: string | null;
  }>;
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Build a SpawnedRequest payload from template + context + optional
 * per-target overrides. Pure — no DB writes.
 */
export function spawnFromTemplate(
  tpl: TemplateInput,
  ctx: SpawnContext,
  overrides: SpawnOverrides = {},
): SpawnedRequest {
  const mergeCtx = {
    client: { name: ctx.clientName ?? '' },
    engagement: { name: ctx.engagementName ?? '' },
    today: ctx.today,
  };

  const title = overrides.titleOverride
    ? overrides.titleOverride
    : resolveMergeTokens(tpl.titlePattern, mergeCtx).output.trim();
  const body = overrides.bodyOverride
    ? overrides.bodyOverride
    : resolveMergeTokens(tpl.bodyPattern, mergeCtx).output;

  const dueDate =
    overrides.dueDateOverride !== undefined
      ? overrides.dueDateOverride
      : tpl.defaultDueOffsetDays != null
        ? addDays(ctx.today, tpl.defaultDueOffsetDays)
        : null;

  return {
    title: title || 'Untitled request',
    body,
    priority: overrides.priorityOverride ?? tpl.defaultPriority,
    dueDate,
    reminderDaysBefore:
      overrides.reminderDaysBeforeOverride !== undefined
        ? overrides.reminderDaysBeforeOverride
        : tpl.defaultReminderDaysBefore,
    assignedAppUserId:
      overrides.assignedAppUserIdOverride !== undefined
        ? overrides.assignedAppUserIdOverride
        : tpl.defaultAssignedAppUserId,
    tags: overrides.tags ?? [],
    items: tpl.items.map((it) => ({
      ordinal: it.ordinal,
      label: it.label,
      body: it.body,
      itemKind: it.itemKind,
      required: it.required,
      dueDate:
        it.defaultDueOffsetDays != null ? addDays(ctx.today, it.defaultDueOffsetDays) : dueDate,
    })),
  };
}
