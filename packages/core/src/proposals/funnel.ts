// SPDX-License-Identifier: Elastic-2.0
//
// P28 — Pipeline + conversion funnel math.
//
// Pure helpers. The API hands in proposal rows + activity rows; we
// project them into:
//   • status-bucket counts for the kanban
//   • a 5-stage funnel: sent → viewed → started signing → accepted
//   • time-to-sign median + p90 (only for accepted proposals)
//   • abandoners: viewed but never accepted, sorted desc by $ value
//   • stale alerts: VIEWED for >7 days with no activity
//
// All inputs are POJOs. No DB access. No date math beyond Date.parse,
// and the helper takes a `now` for deterministic tests.

export type ProposalStatus =
  | 'DRAFT'
  | 'SENT'
  | 'VIEWED'
  | 'IN_PROGRESS'
  | 'ACCEPTED'
  | 'DECLINED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'COUNTERED';

export interface ProposalForFunnel {
  id: string;
  status: ProposalStatus;
  totalOneTimeCents: number;
  totalRecurringCents: number;
  // ISO strings — we keep them strings to dodge timezone bugs that come
  // from Date round-trips through JSON.
  sentAt: string | null;
  firstViewedAt: string | null;
  acceptedAt: string | null;
  // Last activity timestamp (max from proposal_activity). Drives the
  // "stale" alert.
  lastActivityAt: string | null;
}

// We only need to know *whether* a SIGNATURE_STARTED activity exists per
// proposal, not the full activity list. The caller pre-aggregates.
export interface FunnelInput {
  proposals: ProposalForFunnel[];
  // Set of proposal ids that have at least one SIGNATURE_STARTED
  // activity (or SIGNATURE_COMPLETED — both count as "started signing").
  signatureStartedIds: Set<string>;
  // ISO datetime — caller passes `new Date().toISOString()` in prod.
  now: string;
  // 7 days by default.
  staleThresholdDays?: number;
}

export interface KanbanCount {
  status: ProposalStatus;
  count: number;
  totalValueCents: number;
}

export interface FunnelStage {
  stage: 'SENT' | 'VIEWED' | 'SIGNATURE_STARTED' | 'ACCEPTED';
  count: number;
  // Drop-off vs the previous stage. Null on SENT (no prior stage).
  dropOffPct: number | null;
  // Cumulative conversion vs SENT.
  conversionPctFromSent: number;
}

export interface FunnelResult {
  kanban: KanbanCount[];
  funnel: FunnelStage[];
  timeToSign: {
    medianHours: number | null;
    p90Hours: number | null;
    sampleSize: number;
  };
  abandoners: {
    proposalId: string;
    valueCents: number;
    firstViewedAt: string;
  }[];
  stale: {
    proposalId: string;
    lastActivityAt: string;
    daysSince: number;
  }[];
  summary: {
    totalSent: number;
    totalAccepted: number;
    totalDeclined: number;
    pipelineValueCents: number;
  };
}

const KANBAN_ORDER: ProposalStatus[] = [
  'DRAFT',
  'SENT',
  'VIEWED',
  'IN_PROGRESS',
  'ACCEPTED',
  'DECLINED',
  'EXPIRED',
  'CANCELLED',
  'COUNTERED',
];

function valueOf(p: ProposalForFunnel): number {
  // Pipeline value = one-time + 12 months of recurring (annualized
  // basis — matches how firms quote a "first-year value").
  return p.totalOneTimeCents + p.totalRecurringCents * 12;
}

function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo]!;
  const frac = idx - lo;
  return sortedAsc[lo]! * (1 - frac) + sortedAsc[hi]! * frac;
}

export function computeProposalFunnel(input: FunnelInput): FunnelResult {
  const now = Date.parse(input.now);
  const staleDays = input.staleThresholdDays ?? 7;
  const staleCutoff = now - staleDays * 86_400_000;

  // ---- Kanban -----------------------------------------------------
  const kanbanMap = new Map<ProposalStatus, KanbanCount>();
  for (const s of KANBAN_ORDER) {
    kanbanMap.set(s, { status: s, count: 0, totalValueCents: 0 });
  }
  for (const p of input.proposals) {
    const k = kanbanMap.get(p.status);
    if (!k) continue;
    k.count += 1;
    k.totalValueCents += valueOf(p);
  }

  // ---- Funnel -----------------------------------------------------
  let sent = 0;
  let viewed = 0;
  let started = 0;
  let accepted = 0;
  for (const p of input.proposals) {
    // SENT proposals = anything that has been sent at least once, even
    // if since accepted/declined/expired. sentAt is the source of truth.
    if (p.sentAt) sent += 1;
    if (p.firstViewedAt) viewed += 1;
    if (input.signatureStartedIds.has(p.id)) started += 1;
    if (p.acceptedAt) accepted += 1;
  }

  function stage(name: FunnelStage['stage'], count: number, prev: number | null): FunnelStage {
    const dropOff = prev == null || prev === 0 ? null : ((prev - count) / prev) * 100;
    const conv = sent === 0 ? 0 : (count / sent) * 100;
    return {
      stage: name,
      count,
      dropOffPct: dropOff == null ? null : Math.round(dropOff * 100) / 100,
      conversionPctFromSent: Math.round(conv * 100) / 100,
    };
  }
  const funnel: FunnelStage[] = [
    stage('SENT', sent, null),
    stage('VIEWED', viewed, sent),
    stage('SIGNATURE_STARTED', started, viewed),
    stage('ACCEPTED', accepted, started),
  ];

  // ---- Time-to-sign ----------------------------------------------
  const signTimes: number[] = [];
  for (const p of input.proposals) {
    if (!p.sentAt || !p.acceptedAt) continue;
    const sentMs = Date.parse(p.sentAt);
    const acceptedMs = Date.parse(p.acceptedAt);
    if (!Number.isFinite(sentMs) || !Number.isFinite(acceptedMs)) continue;
    const hrs = (acceptedMs - sentMs) / 3_600_000;
    if (hrs >= 0) signTimes.push(hrs);
  }
  signTimes.sort((a, b) => a - b);
  const median = percentile(signTimes, 0.5);
  const p90 = percentile(signTimes, 0.9);

  // ---- Abandoners ------------------------------------------------
  const abandoners = input.proposals
    .filter((p) => p.firstViewedAt && !p.acceptedAt && p.status !== 'ACCEPTED')
    .map((p) => ({
      proposalId: p.id,
      valueCents: valueOf(p),
      firstViewedAt: p.firstViewedAt!,
    }))
    .sort((a, b) => b.valueCents - a.valueCents);

  // ---- Stale -----------------------------------------------------
  const stale = input.proposals
    .filter((p) => p.status === 'VIEWED')
    .map((p) => {
      const ts = p.lastActivityAt
        ? Date.parse(p.lastActivityAt)
        : p.firstViewedAt
          ? Date.parse(p.firstViewedAt)
          : null;
      return { p, ts };
    })
    .filter((x): x is { p: ProposalForFunnel; ts: number } => x.ts != null && x.ts < staleCutoff)
    .map(({ p, ts }) => ({
      proposalId: p.id,
      lastActivityAt: new Date(ts).toISOString(),
      daysSince: Math.floor((now - ts) / 86_400_000),
    }))
    .sort((a, b) => b.daysSince - a.daysSince);

  // ---- Summary ---------------------------------------------------
  let totalAccepted = 0;
  let totalDeclined = 0;
  let pipelineValueCents = 0;
  for (const p of input.proposals) {
    if (p.status === 'ACCEPTED') totalAccepted += 1;
    if (p.status === 'DECLINED') totalDeclined += 1;
    // "Pipeline" = anything still actionable (sent, viewed, in-progress).
    if (p.status === 'SENT' || p.status === 'VIEWED' || p.status === 'IN_PROGRESS') {
      pipelineValueCents += valueOf(p);
    }
  }

  return {
    kanban: Array.from(kanbanMap.values()),
    funnel,
    timeToSign: {
      medianHours: median == null ? null : Math.round(median * 100) / 100,
      p90Hours: p90 == null ? null : Math.round(p90 * 100) / 100,
      sampleSize: signTimes.length,
    },
    abandoners,
    stale,
    summary: {
      totalSent: sent,
      totalAccepted,
      totalDeclined,
      pipelineValueCents,
    },
  };
}
