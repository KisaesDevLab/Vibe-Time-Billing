// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P28 — Funnel math tests.

import { describe, expect, it } from 'vitest';
import { computeProposalFunnel, type ProposalForFunnel } from './funnel';

const NOW = '2026-05-26T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);

function hoursAgo(h: number): string {
  return new Date(NOW_MS - h * 3_600_000).toISOString();
}
function daysAgo(d: number): string {
  return hoursAgo(d * 24);
}

function p(overrides: Partial<ProposalForFunnel> & { id: string }): ProposalForFunnel {
  return {
    id: overrides.id,
    status: overrides.status ?? 'DRAFT',
    totalOneTimeCents: overrides.totalOneTimeCents ?? 0,
    totalRecurringCents: overrides.totalRecurringCents ?? 0,
    sentAt: overrides.sentAt ?? null,
    firstViewedAt: overrides.firstViewedAt ?? null,
    acceptedAt: overrides.acceptedAt ?? null,
    lastActivityAt: overrides.lastActivityAt ?? null,
  };
}

describe('P28 — kanban', () => {
  it('counts proposals per status with totalValue', () => {
    const r = computeProposalFunnel({
      proposals: [
        p({ id: '1', status: 'SENT', totalOneTimeCents: 50_000, totalRecurringCents: 10_000 }),
        p({ id: '2', status: 'SENT', totalOneTimeCents: 100_000 }),
        p({ id: '3', status: 'ACCEPTED', totalOneTimeCents: 30_000 }),
      ],
      signatureStartedIds: new Set(),
      now: NOW,
    });
    const sent = r.kanban.find((k) => k.status === 'SENT')!;
    expect(sent.count).toBe(2);
    // 50k + 10k*12 + 100k = 270k
    expect(sent.totalValueCents).toBe(270_000);
    expect(r.kanban.find((k) => k.status === 'ACCEPTED')!.count).toBe(1);
  });

  it('every status appears even when empty', () => {
    const r = computeProposalFunnel({
      proposals: [],
      signatureStartedIds: new Set(),
      now: NOW,
    });
    expect(r.kanban.length).toBe(9);
    expect(r.kanban.every((k) => k.count === 0)).toBe(true);
  });
});

describe('P28 — funnel stages', () => {
  it('computes drop-off + conversion percentages', () => {
    const props: ProposalForFunnel[] = [];
    for (let i = 0; i < 10; i++) {
      props.push(
        p({
          id: `s${i}`,
          status: 'SENT',
          sentAt: daysAgo(2),
        }),
      );
    }
    for (let i = 0; i < 7; i++) {
      props[i]!.firstViewedAt = daysAgo(1);
    }
    const started = new Set<string>(['s0', 's1', 's2', 's3']);
    props[0]!.status = 'ACCEPTED';
    props[0]!.acceptedAt = hoursAgo(20);
    props[1]!.status = 'ACCEPTED';
    props[1]!.acceptedAt = hoursAgo(28);

    const r = computeProposalFunnel({
      proposals: props,
      signatureStartedIds: started,
      now: NOW,
    });
    const stages = Object.fromEntries(r.funnel.map((f) => [f.stage, f]));
    expect(stages['SENT']!.count).toBe(10);
    expect(stages['SENT']!.dropOffPct).toBeNull();
    expect(stages['VIEWED']!.count).toBe(7);
    expect(stages['VIEWED']!.dropOffPct).toBe(30);
    expect(stages['SIGNATURE_STARTED']!.count).toBe(4);
    // 4 of 7 = 42.857% drop = (7-4)/7 = 42.86%
    expect(stages['SIGNATURE_STARTED']!.dropOffPct).toBeCloseTo(42.86, 1);
    expect(stages['ACCEPTED']!.count).toBe(2);
    expect(stages['ACCEPTED']!.conversionPctFromSent).toBe(20);
  });

  it('handles zero sent gracefully', () => {
    const r = computeProposalFunnel({
      proposals: [],
      signatureStartedIds: new Set(),
      now: NOW,
    });
    expect(r.funnel[0]!.count).toBe(0);
    expect(r.funnel[0]!.conversionPctFromSent).toBe(0);
  });
});

describe('P28 — time to sign', () => {
  it('median + p90 in hours', () => {
    const props: ProposalForFunnel[] = [];
    // Five accepted with sign times 1h, 5h, 10h, 24h, 100h.
    const hrs = [1, 5, 10, 24, 100];
    for (const h of hrs) {
      props.push(
        p({
          id: `t${h}`,
          status: 'ACCEPTED',
          sentAt: hoursAgo(h + 1),
          acceptedAt: hoursAgo(1),
        }),
      );
    }
    const r = computeProposalFunnel({
      proposals: props,
      signatureStartedIds: new Set(),
      now: NOW,
    });
    expect(r.timeToSign.sampleSize).toBe(5);
    expect(r.timeToSign.medianHours).toBe(10);
    // p90 of [1,5,10,24,100] = interpolated between index 3.6 → 24 + 0.6*(100-24) = 69.6
    expect(r.timeToSign.p90Hours).toBeCloseTo(69.6, 1);
  });

  it('returns nulls when no accepted proposals', () => {
    const r = computeProposalFunnel({
      proposals: [p({ id: '1', status: 'SENT', sentAt: daysAgo(1) })],
      signatureStartedIds: new Set(),
      now: NOW,
    });
    expect(r.timeToSign.medianHours).toBeNull();
    expect(r.timeToSign.p90Hours).toBeNull();
  });
});

describe('P28 — abandoners', () => {
  it('lists viewed-but-not-accepted, sorted desc by value', () => {
    const r = computeProposalFunnel({
      proposals: [
        p({
          id: 'small',
          status: 'VIEWED',
          totalOneTimeCents: 10_000,
          firstViewedAt: daysAgo(3),
        }),
        p({
          id: 'big',
          status: 'VIEWED',
          totalRecurringCents: 50_000,
          firstViewedAt: daysAgo(2),
        }),
        p({
          id: 'won',
          status: 'ACCEPTED',
          totalOneTimeCents: 100_000,
          firstViewedAt: daysAgo(1),
          acceptedAt: hoursAgo(2),
        }),
      ],
      signatureStartedIds: new Set(),
      now: NOW,
    });
    expect(r.abandoners.length).toBe(2);
    // big = 50k * 12 = 600k vs small = 10k
    expect(r.abandoners[0]!.proposalId).toBe('big');
    expect(r.abandoners[1]!.proposalId).toBe('small');
  });
});

describe('P28 — stale alert', () => {
  it('flags VIEWED proposals last touched >7 days ago', () => {
    const r = computeProposalFunnel({
      proposals: [
        p({
          id: 'old',
          status: 'VIEWED',
          firstViewedAt: daysAgo(14),
          lastActivityAt: daysAgo(10),
        }),
        p({
          id: 'fresh',
          status: 'VIEWED',
          firstViewedAt: daysAgo(2),
          lastActivityAt: daysAgo(2),
        }),
        p({
          id: 'sent',
          status: 'SENT', // not VIEWED — should be skipped
          firstViewedAt: null,
          lastActivityAt: daysAgo(20),
        }),
      ],
      signatureStartedIds: new Set(),
      now: NOW,
    });
    expect(r.stale.length).toBe(1);
    expect(r.stale[0]!.proposalId).toBe('old');
    expect(r.stale[0]!.daysSince).toBe(10);
  });

  it('honors custom threshold', () => {
    const r = computeProposalFunnel({
      proposals: [
        p({
          id: 'a',
          status: 'VIEWED',
          firstViewedAt: daysAgo(4),
          lastActivityAt: daysAgo(4),
        }),
      ],
      signatureStartedIds: new Set(),
      now: NOW,
      staleThresholdDays: 3,
    });
    expect(r.stale.length).toBe(1);
  });
});

describe('P28 — summary', () => {
  it('aggregates totals + pipeline value (sent/viewed/in_progress only)', () => {
    const r = computeProposalFunnel({
      proposals: [
        p({ id: '1', status: 'SENT', sentAt: daysAgo(1), totalOneTimeCents: 100_000 }),
        p({ id: '2', status: 'VIEWED', firstViewedAt: daysAgo(1), totalRecurringCents: 20_000 }),
        p({ id: '3', status: 'ACCEPTED', acceptedAt: hoursAgo(1), totalOneTimeCents: 50_000 }),
        p({ id: '4', status: 'DECLINED' }),
        p({ id: '5', status: 'DRAFT', totalOneTimeCents: 999_999 }), // not in pipeline
      ],
      signatureStartedIds: new Set(),
      now: NOW,
    });
    // pipeline: 100k (SENT) + 20k*12 (VIEWED) = 340k
    expect(r.summary.pipelineValueCents).toBe(340_000);
    expect(r.summary.totalAccepted).toBe(1);
    expect(r.summary.totalDeclined).toBe(1);
    expect(r.summary.totalSent).toBe(1); // only id 1 has sentAt set
  });
});
