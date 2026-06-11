// SPDX-License-Identifier: Elastic-2.0
//
// Dunning schedule. The default sequence sends reminders at day 7 (friendly),
// day 21 (firm), day 45 (escalated), day 60 (partner notify), day 90
// (auto-pause). Each step picks the channel based on the recipient's
// preferred method (EMAIL | SMS) — Q16.

import type { IsoDate } from '@vibe/types';

export type DunningStepKind =
  | 'REMINDER_FRIENDLY'
  | 'REMINDER_FIRM'
  | 'REMINDER_ESCALATED'
  | 'PARTNER_NOTIFY'
  | 'AUTO_PAUSE';

export interface DunningStep {
  daysOverdue: number;
  kind: DunningStepKind;
}

export const DEFAULT_DUNNING_SCHEDULE: DunningStep[] = [
  { daysOverdue: 7, kind: 'REMINDER_FRIENDLY' },
  { daysOverdue: 21, kind: 'REMINDER_FIRM' },
  { daysOverdue: 45, kind: 'REMINDER_ESCALATED' },
  { daysOverdue: 60, kind: 'PARTNER_NOTIFY' },
  { daysOverdue: 90, kind: 'AUTO_PAUSE' },
];

export function stepsDueOn(args: {
  invoiceDueDate: IsoDate;
  today: IsoDate;
  schedule?: DunningStep[];
  alreadySentKinds?: Set<DunningStepKind>;
}): DunningStep[] {
  const days = daysOverdue(args.invoiceDueDate, args.today);
  const sched = args.schedule ?? DEFAULT_DUNNING_SCHEDULE;
  const sent = args.alreadySentKinds ?? new Set();
  return sched.filter((s) => days >= s.daysOverdue && !sent.has(s.kind));
}

function daysOverdue(invoiceDueDate: IsoDate, today: IsoDate): number {
  const due = Date.parse(`${invoiceDueDate}T00:00:00Z`);
  const t = Date.parse(`${today}T00:00:00Z`);
  return Math.floor((t - due) / 86_400_000);
}
