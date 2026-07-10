// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Filing-deadline set keyed by the engagement's returnType. Configurable
// constant (a firm-level override is a future enhancement). Each return type
// has a statutory filing deadline and an extension deadline; the rollforward
// date engine anchors to whichever the source date is nearest to (so both the
// 2/1–4/15 filing season and the 8/1–10/15 extension season behave sensibly).

export interface MonthDay {
  month: number; // 1-12
  day: number; // 1-31
}

export interface DeadlineSpec {
  filing: MonthDay;
  extension: MonthDay;
}

// Statutory (not weekend/holiday-observed) dates — see plan Q5.
export const DEADLINES: Readonly<Record<string, DeadlineSpec>> = {
  '1040': { filing: { month: 4, day: 15 }, extension: { month: 10, day: 15 } }, // individual
  '1120': { filing: { month: 4, day: 15 }, extension: { month: 10, day: 15 } }, // C-corp
  '1120S': { filing: { month: 3, day: 15 }, extension: { month: 9, day: 15 } }, // S-corp
  '1065': { filing: { month: 3, day: 15 }, extension: { month: 9, day: 15 } }, // partnership
  '1041': { filing: { month: 4, day: 15 }, extension: { month: 9, day: 30 } }, // estate/trust
  '990': { filing: { month: 5, day: 15 }, extension: { month: 11, day: 15 } }, // nonprofit
};

export function deadlineSpecFor(returnType: string | null | undefined): DeadlineSpec | null {
  if (!returnType) return null;
  return DEADLINES[returnType] ?? null;
}
