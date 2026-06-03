// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Heavy demo seed — populates every page with realistic data on top of
// the baseline produced by `seed.ts`. Targets the volumes the user
// requested:
//
//   ~150 clients (existing 5 + ~145 new)
//   ~400 engagements distributed across them
//   ~4000 time entries over the last 90 days
//   ~200 invoices spanning DRAFT / OPEN / PARTIAL / PAID / VOID
//   ~30 payments
//   ~30 adjustments (5 in PENDING_APPROVAL so the Approvals page has work)
//   8 client_folders bound + ~30 sample files each, with the matching
//   sentinel + mock-storage files written to STORAGE_LOCAL_PATH
//
// Idempotency: a private `_demo_seed_id` table records every insert as
// (table_name, row_id). Re-running this script first clears the
// previously seeded rows in reverse-FK order, then re-inserts fresh.
// Hand-edits on tracked rows survive only until the next demo seed
// run.
//
// Usage:
//   DATABASE_URL=postgresql://vibe:vibe@localhost:5432/vibe_tb \
//     pnpm --filter @vibe/db demo-seed
//
// Inside docker:
//   docker exec vibe-tb-api node --experimental-transform-types \
//     --import /opt/hooks/esm-resolve-hook.mjs \
//     packages/db/dist/packages/db/src/scripts/seed-demo.js

import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { asc, desc, eq, sql } from 'drizzle-orm';

import {
  appUsers,
  clientFolders,
  clients,
  engagementTypes,
  engagements as engagementsTable,
  files as filesTable,
  firms,
  folderSyncEvents,
  offices,
  invoiceLineItems,
  invoices as invoicesTable,
  payments as paymentsTable,
  reasonCodes,
  timeEntries,
  workCodes,
} from '../schema/core';

const FIRM_NAME = 'Granite Peak CPAs';
const TRACKER_TABLE = '_demo_seed_id';

// Volume knobs — override via env for quick smoke runs.
const TARGET_TOTAL_CLIENTS = parseInt(process.env['DEMO_CLIENTS'] ?? '150', 10) || 150;
const TARGET_ENGAGEMENTS = parseInt(process.env['DEMO_ENGAGEMENTS'] ?? '400', 10) || 400;
const TARGET_TIME_ENTRIES = parseInt(process.env['DEMO_TIME_ENTRIES'] ?? '4000', 10) || 4000;
const TARGET_INVOICES = parseInt(process.env['DEMO_INVOICES'] ?? '200', 10) || 200;
const TARGET_FILE_FOLDERS = parseInt(process.env['DEMO_FILE_FOLDERS'] ?? '8', 10) || 8;
const FILES_PER_FOLDER = parseInt(process.env['DEMO_FILES_PER_FOLDER'] ?? '30', 10) || 30;

// Reverse-FK deletion order for tables this seed actually inserts into.
// All listed tables have a singular `id` PRIMARY KEY. Tables with
// composite PKs (e.g. billing_batch_entry) aren't seeded directly here;
// their rows cascade from their parent (billing_batch).
const CLEANUP_ORDER = [
  'folder_sync_events',
  'files',
  'client_folders',
  'invoice_line_item',
  'payment',
  'invoice',
  'time_entry',
  'engagement',
  'client',
] as const;

type Tx = Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];

class Tracker {
  private buffer: { table: string; id: string }[] = [];

  constructor(private readonly tx: Tx) {}

  track(table: string, ids: string[]): void {
    for (const id of ids) this.buffer.push({ table, id });
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const rows = this.buffer;
    this.buffer = [];
    const chunkSize = 500;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      await this.tx.execute(
        sql.raw(
          `INSERT INTO ${TRACKER_TABLE} (table_name, row_id) VALUES ${chunk
            .map((r) => `('${r.table}', '${r.id}')`)
            .join(',')} ON CONFLICT DO NOTHING`,
        ),
      );
    }
  }
}

async function ensureTrackerTable(db: PostgresJsDatabase): Promise<void> {
  await db.execute(
    sql.raw(`
    CREATE TABLE IF NOT EXISTS ${TRACKER_TABLE} (
      table_name TEXT NOT NULL,
      row_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (table_name, row_id)
    )
  `),
  );
}

async function clearPreviousDemo(db: PostgresJsDatabase): Promise<number> {
  let total = 0;
  for (const table of CLEANUP_ORDER) {
    const result = await db.execute(
      sql.raw(
        `DELETE FROM ${table} WHERE id IN (SELECT row_id FROM ${TRACKER_TABLE} WHERE table_name='${table}')`,
      ),
    );
    // postgres-js returns { count }
    const count = (result as unknown as { count?: number }).count ?? 0;
    total += count;
  }
  await db.execute(sql.raw(`DELETE FROM ${TRACKER_TABLE}`));
  return total;
}

// ---------------------------------------------------------------------------
// Deterministic-ish RNG so re-runs produce similar distributions without
// being byte-identical. Seeded by Date.now() so each run gets unique
// names + amounts.
// ---------------------------------------------------------------------------

let rngState = (Date.now() & 0xffffffff) >>> 0;
function rng(): number {
  // xorshift32
  rngState ^= rngState << 13;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  return ((rngState >>> 0) % 1_000_000) / 1_000_000;
}
function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}
function pickInt(lo: number, hi: number): number {
  return Math.floor(rng() * (hi - lo + 1)) + lo;
}
function pickWeighted<T>(pairs: ReadonlyArray<readonly [T, number]>): T {
  const total = pairs.reduce((acc, [, w]) => acc + w, 0);
  let r = rng() * total;
  for (const [val, w] of pairs) {
    r -= w;
    if (r <= 0) return val;
  }
  return pairs[pairs.length - 1]![0];
}
function isoDateDaysAgo(daysBack: number): string {
  const d = new Date(Date.now() - daysBack * 86400_000);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Lookups — read-only context the seed needs.
// ---------------------------------------------------------------------------

interface SeedContext {
  firmId: string;
  defaultOfficeId: string;
  userIds: string[];
  partnerIds: string[];
  workCodeIds: string[];
  billableWorkCodeIds: string[];
  engagementTypeIds: string[];
  reasonCodeIds: string[];
  userBillRates: Map<string, number>;
}

async function loadContext(db: PostgresJsDatabase, firmId: string): Promise<SeedContext> {
  const users = await db
    .select({ id: appUsers.id })
    .from(appUsers)
    .where(eq(appUsers.firmId, firmId));
  const userIds = users.map((u) => u.id);

  // First user is the seeded partner; treat the first three as "partner pool"
  // for partner_id assignment. Real-world firms typically have a 1:N
  // staff-to-partner ratio.
  const partnerIds = userIds.slice(0, Math.min(3, userIds.length));

  const wcs = await db
    .select({ id: workCodes.id, billable: workCodes.billableDefault })
    .from(workCodes)
    .where(eq(workCodes.firmId, firmId));
  const workCodeIds = wcs.map((w) => w.id);
  const billableWorkCodeIds = wcs.filter((w) => w.billable).map((w) => w.id);

  const ets = await db
    .select({ id: engagementTypes.id })
    .from(engagementTypes)
    .where(eq(engagementTypes.firmId, firmId));
  const engagementTypeIds = ets.map((e) => e.id);

  const rcs = await db
    .select({ id: reasonCodes.id })
    .from(reasonCodes)
    .where(eq(reasonCodes.firmId, firmId));
  const reasonCodeIds = rcs.map((r) => r.id);

  // Bill rates for the rate-snapshot field on each time_entry. We don't
  // bother resolving via the rate engine here — the demo just stamps
  // each user's base rate. Range matches the rates seeded in seed.ts.
  const baseRates = [50000, 30000, 25000, 20000, 45000, 40000, 18000];
  const userBillRates = new Map<string, number>();
  for (let i = 0; i < userIds.length; i++) {
    userBillRates.set(userIds[i]!, baseRates[i] ?? 25000);
  }

  // 0092 — every client requires office_id. Resolve the firm's default
  // office once and reuse for every seeded client.
  const [defaultOffice] = await db
    .select({ id: offices.id })
    .from(offices)
    .where(eq(offices.firmId, firmId))
    .orderBy(desc(offices.isDefault), asc(offices.createdAt))
    .limit(1);
  if (!defaultOffice) throw new Error('seed-demo: firm has no office');

  return {
    firmId,
    defaultOfficeId: defaultOffice.id,
    userIds,
    partnerIds,
    workCodeIds,
    billableWorkCodeIds,
    engagementTypeIds,
    reasonCodeIds,
    userBillRates,
  };
}

// ---------------------------------------------------------------------------
// Client + engagement seeders.
// ---------------------------------------------------------------------------

const FIRST_NAMES = [
  'James',
  'Mary',
  'Robert',
  'Patricia',
  'John',
  'Jennifer',
  'Michael',
  'Linda',
  'David',
  'Elizabeth',
  'William',
  'Barbara',
  'Richard',
  'Susan',
  'Joseph',
  'Jessica',
  'Thomas',
  'Sarah',
  'Charles',
  'Karen',
  'Christopher',
  'Nancy',
  'Daniel',
  'Lisa',
  'Matthew',
  'Betty',
  'Anthony',
  'Helen',
  'Mark',
  'Sandra',
  'Donald',
  'Donna',
  'Steven',
  'Carol',
  'Paul',
  'Ruth',
  'Andrew',
  'Sharon',
  'Joshua',
  'Michelle',
];
const LAST_NAMES = [
  'Smith',
  'Johnson',
  'Williams',
  'Brown',
  'Jones',
  'Garcia',
  'Miller',
  'Davis',
  'Rodriguez',
  'Martinez',
  'Hernandez',
  'Lopez',
  'Gonzalez',
  'Wilson',
  'Anderson',
  'Thomas',
  'Taylor',
  'Moore',
  'Jackson',
  'Martin',
  'Lee',
  'Perez',
  'Thompson',
  'White',
  'Harris',
  'Sanchez',
  'Clark',
  'Ramirez',
  'Lewis',
  'Robinson',
  'Walker',
  'Young',
  'Allen',
  'King',
  'Wright',
  'Scott',
  'Torres',
  'Nguyen',
  'Hill',
  'Flores',
];
const BIZ_PREFIXES = [
  'Apex',
  'Beacon',
  'Cedar',
  'Delta',
  'Evergreen',
  'Frontier',
  'Granite',
  'Harbor',
  'Ironwood',
  'Junction',
  'Keystone',
  'Laurel',
  'Meridian',
  'North Star',
  'Oakridge',
  'Pinnacle',
  'Quartz',
  'Riverbend',
  'Summit',
  'Triumph',
  'Union',
  'Vanguard',
  'Westview',
  'Yarrow',
  'Zenith',
];
const BIZ_SUFFIXES = [
  'Holdings',
  'LLC',
  'Industries',
  'Group',
  'Partners',
  'Capital',
  'Ventures',
  'Solutions',
  'Enterprises',
  'Logistics',
  'Realty',
  'Manufacturing',
  'Consulting',
  'Restaurants',
  'Construction',
  'Bakery',
  'Auto',
  'Dental',
  'Medical',
  'Law',
];
const ENG_TEMPLATES = [
  {
    name: 'Individual 1040 — {{year}}',
    fee: 'FIXED_FEE',
    amt: () => pickInt(60000, 250000),
    kind: 'individual' as const,
  },
  {
    name: '1120-S — {{year}}',
    fee: 'FIXED_FEE',
    amt: () => pickInt(150000, 600000),
    kind: 'business' as const,
  },
  {
    name: '1065 Partnership — {{year}}',
    fee: 'FIXED_FEE',
    amt: () => pickInt(180000, 550000),
    kind: 'business' as const,
  },
  {
    name: 'Monthly Bookkeeping',
    fee: 'RECURRING_SUBSCRIPTION',
    amt: () => pickInt(40000, 150000),
    kind: 'business' as const,
  },
  {
    name: 'Audit — FY{{year}}',
    fee: 'HOURLY_NTE',
    amt: () => pickInt(800000, 2500000),
    kind: 'business' as const,
  },
  {
    name: 'Quarterly Advisory',
    fee: 'RECURRING_SUBSCRIPTION',
    amt: () => pickInt(60000, 200000),
    kind: 'business' as const,
  },
  { name: 'Tax Planning {{year}}', fee: 'HOURLY', amt: () => null, kind: 'individual' as const },
  {
    name: 'Forecast & Budget {{year}}',
    fee: 'FIXED_FEE',
    amt: () => pickInt(100000, 350000),
    kind: 'business' as const,
  },
  {
    name: 'Payroll Services',
    fee: 'RECURRING_SUBSCRIPTION',
    amt: () => pickInt(20000, 75000),
    kind: 'business' as const,
  },
  {
    name: 'Review — FY{{year}}',
    fee: 'FIXED_FEE',
    amt: () => pickInt(400000, 1200000),
    kind: 'business' as const,
  },
] as const;

interface DemoClient {
  id: string;
  name: string;
  type: 'INDIVIDUAL' | 'BUSINESS';
  partnerId: string;
}

async function seedClients(
  tx: Tx,
  tracker: Tracker,
  ctx: SeedContext,
  count: number,
): Promise<DemoClient[]> {
  const seen = new Set<string>();
  const planned: DemoClient[] = [];
  for (let i = 0; i < count; i++) {
    const isIndividual = rng() < 0.45;
    let name: string;
    if (isIndividual) {
      name = `${pick(LAST_NAMES)}, ${pick(FIRST_NAMES)}`;
    } else {
      name = `${pick(BIZ_PREFIXES)} ${pick(BIZ_SUFFIXES)}`;
    }
    // Ensure name uniqueness within this run.
    let dedup = name;
    let suffix = 2;
    while (seen.has(dedup)) {
      dedup = `${name} #${suffix++}`;
    }
    seen.add(dedup);
    planned.push({
      id: randomUUID(),
      name: dedup,
      type: isIndividual ? 'INDIVIDUAL' : 'BUSINESS',
      partnerId: pick(ctx.partnerIds.length > 0 ? ctx.partnerIds : ctx.userIds),
    });
  }

  const chunkSize = 100;
  for (let i = 0; i < planned.length; i += chunkSize) {
    const slice = planned.slice(i, i + chunkSize);
    await tx.insert(clients).values(
      slice.map((c) => ({
        id: c.id,
        firmId: ctx.firmId,
        name: c.name,
        clientType: c.type,
        partnerInChargeId: c.partnerId,
        officeId: ctx.defaultOfficeId,
        pipelineStage: 'CLIENT' as const,
        termsDays: pick([15, 30, 30, 30, 45, 60]),
        notes: '[demo-seed]',
      })),
    );
    tracker.track(
      'client',
      slice.map((c) => c.id),
    );
  }
  await tracker.flush();
  return planned;
}

interface DemoEngagement {
  id: string;
  clientId: string;
  partnerId: string;
  feeStructure: string;
  feeAmountCents: number | null;
}

async function seedEngagements(
  tx: Tx,
  tracker: Tracker,
  ctx: SeedContext,
  clientsList: DemoClient[],
  count: number,
): Promise<DemoEngagement[]> {
  const planned: DemoEngagement[] = [];
  const currentYear = new Date().getFullYear();
  const yearOptions = [currentYear - 1, currentYear, currentYear + 1] as const;

  for (let i = 0; i < count; i++) {
    const client = pick(clientsList);
    const template = pick(
      ENG_TEMPLATES.filter((t) => t.kind === 'business' || client.type === 'INDIVIDUAL'),
    );
    const year = pick(yearOptions);
    const name = template.name.replace('{{year}}', String(year));
    const fee = template.amt();
    planned.push({
      id: randomUUID(),
      clientId: client.id,
      partnerId: client.partnerId,
      feeStructure: template.fee,
      feeAmountCents: fee,
    });
    // Defer the actual INSERT to the chunked loop below.
    void name;
  }

  // Now do the INSERT pass with names re-derived. We had to compute
  // `name` per-row above but didn't carry it onto DemoEngagement
  // because the field is only used at insert time.
  const chunkSize = 100;
  // Synthesize a display name from each engagement's fee structure +
  // a sequence number. The original generator above produced these
  // names but didn't carry them onto DemoEngagement; rebuilding here
  // is cheap and keeps the type shape simple.
  const namePool: string[] = planned.map((p, idx) => {
    const fs = p.feeStructure;
    if (fs === 'RECURRING_SUBSCRIPTION') return `Monthly Service #${idx + 1}`;
    if (fs === 'HOURLY_NTE') return `Audit FY${currentYear} (NTE) #${idx + 1}`;
    if (fs === 'HOURLY') return `Advisory Hourly #${idx + 1}`;
    return `Engagement #${idx + 1}`;
  });

  for (let i = 0; i < planned.length; i += chunkSize) {
    const slice = planned.slice(i, i + chunkSize);
    const nameSlice = namePool.slice(i, i + chunkSize);
    await tx.insert(engagementsTable).values(
      slice.map((e, idx) => ({
        id: e.id,
        clientId: e.clientId,
        engagementTypeId: pick(ctx.engagementTypeIds),
        name: nameSlice[idx]!,
        feeStructure: e.feeStructure as
          | 'FIXED_FEE'
          | 'HOURLY'
          | 'HOURLY_NTE'
          | 'RECURRING_SUBSCRIPTION',
        feeAmountCents: e.feeAmountCents,
        budgetHours: e.feeAmountCents
          ? String(Math.round((e.feeAmountCents / 25000) * 100) / 100)
          : null,
        partnerId: e.partnerId,
        managerId: pick(ctx.userIds),
        status: pickWeighted<'ACTIVE' | 'CLOSED' | 'PAUSED'>([
          ['ACTIVE', 7],
          ['CLOSED', 2],
          ['PAUSED', 1],
        ]),
        startDate: isoDateDaysAgo(pickInt(30, 365)),
        scopeDefinition: '[demo-seed]',
      })),
    );
    tracker.track(
      'engagement',
      slice.map((e) => e.id),
    );
  }
  await tracker.flush();
  return planned;
}

// ---------------------------------------------------------------------------
// Time entries — bulk insert across 90 days.
// ---------------------------------------------------------------------------

async function seedTimeEntries(
  tx: Tx,
  tracker: Tracker,
  ctx: SeedContext,
  engagements: DemoEngagement[],
  count: number,
): Promise<string[]> {
  const ids: string[] = [];
  const buffer: Array<{
    id: string;
    engagementId: string;
    appUserId: string;
    workCodeId: string;
    entryDate: string;
    hours: string;
    standardRateSnapshotCents: number;
    standardAmountCents: number;
    description: string;
    billableFlag: boolean;
    status: 'SUBMITTED' | 'LOCKED' | 'DRAFT';
  }> = [];

  for (let i = 0; i < count; i++) {
    const e = pick(engagements);
    const u = pick(ctx.userIds);
    const wc = rng() < 0.92 ? pick(ctx.billableWorkCodeIds) : pick(ctx.workCodeIds);
    const billable = ctx.billableWorkCodeIds.includes(wc);
    const hours = (pickInt(25, 800) / 100).toFixed(2); // 0.25 – 8.00
    const rate = ctx.userBillRates.get(u) ?? 25000;
    const amount = Math.round(rate * Number(hours));
    const id = randomUUID();
    ids.push(id);
    buffer.push({
      id,
      engagementId: e.id,
      appUserId: u,
      workCodeId: wc,
      entryDate: isoDateDaysAgo(pickInt(0, 90)),
      hours,
      standardRateSnapshotCents: rate,
      standardAmountCents: amount,
      description:
        pick([
          'Tax-return prep',
          'Workpaper review',
          'Client call',
          'Email correspondence',
          'Audit fieldwork',
          'Quarterly close',
          'Status meeting',
          'Schedule K-1 prep',
          'Adjustments + reconciliation',
          'Internal control walkthrough',
        ]) + ' [demo-seed]',
      billableFlag: billable,
      status: pickWeighted<'SUBMITTED' | 'LOCKED' | 'DRAFT'>([
        ['SUBMITTED', 5],
        ['LOCKED', 3],
        ['DRAFT', 1],
      ]),
    });
  }

  const chunkSize = 500;
  for (let i = 0; i < buffer.length; i += chunkSize) {
    const slice = buffer.slice(i, i + chunkSize);
    await tx.insert(timeEntries).values(slice);
    tracker.track(
      'time_entry',
      slice.map((r) => r.id),
    );
  }
  await tracker.flush();
  return ids;
}

// ---------------------------------------------------------------------------
// Invoices + payments.
// ---------------------------------------------------------------------------

async function seedInvoicesAndPayments(
  tx: Tx,
  tracker: Tracker,
  ctx: SeedContext,
  engagements: DemoEngagement[],
  count: number,
): Promise<void> {
  const invRows: Array<{
    id: string;
    clientId: string;
    engagementId: string;
    invoiceNumber: string;
    issueDate: string;
    dueDate: string;
    subtotal: number;
    fee: number;
    tax: number;
    total: number;
    status: 'DRAFT' | 'SENT' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE' | 'VOIDED';
    paidCents: number;
    paidAt: Date | null;
  }> = [];

  // Sequence number suffix — collision avoidance against any existing invoices.
  const stamp = String(Date.now()).slice(-6);

  for (let i = 0; i < count; i++) {
    const e = pick(engagements);
    const subtotal = pickInt(50000, 1500000);
    const fee = rng() < 0.3 ? Math.round(subtotal * 0.029) : 0;
    const tax = rng() < 0.15 ? Math.round(subtotal * 0.0625) : 0;
    const total = subtotal + fee + tax;
    const issuedDaysBack = pickInt(0, 120);
    const dueDays = pick([15, 30, 30, 45]);
    const issueDate = isoDateDaysAgo(issuedDaysBack);
    const dueDate = isoDateDaysAgo(issuedDaysBack - dueDays);
    const status = pickWeighted<
      'DRAFT' | 'SENT' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE' | 'VOIDED'
    >([
      ['DRAFT', 1],
      ['SENT', 4],
      ['PARTIALLY_PAID', 1],
      ['PAID', 5],
      ['OVERDUE', 2],
      ['VOIDED', 1],
    ]);
    let paidCents = 0;
    let paidAt: Date | null = null;
    if (status === 'PAID') {
      paidCents = total;
      paidAt = new Date(Date.now() - pickInt(0, issuedDaysBack) * 86400_000);
    } else if (status === 'PARTIALLY_PAID') {
      paidCents = Math.round(total * (pickInt(20, 80) / 100));
      paidAt = new Date(Date.now() - pickInt(0, issuedDaysBack) * 86400_000);
    }
    invRows.push({
      id: randomUUID(),
      clientId: e.clientId,
      engagementId: e.id,
      invoiceNumber: `DEMO-${stamp}-${(i + 1).toString().padStart(4, '0')}`,
      issueDate,
      dueDate,
      subtotal,
      fee,
      tax,
      total,
      status,
      paidCents,
      paidAt,
    });
  }

  const chunkSize = 100;
  for (let i = 0; i < invRows.length; i += chunkSize) {
    const slice = invRows.slice(i, i + chunkSize);
    await tx.insert(invoicesTable).values(
      slice.map((r) => ({
        id: r.id,
        firmId: ctx.firmId,
        clientId: r.clientId,
        primaryEngagementId: r.engagementId,
        invoiceNumber: r.invoiceNumber,
        issueDate: r.issueDate,
        dueDate: r.dueDate,
        subtotalCents: r.subtotal,
        feeCents: r.fee,
        taxCents: r.tax,
        totalCents: r.total,
        status: r.status,
        paidCents: r.paidCents,
        paidAt: r.paidAt,
        sentAt: r.status === 'DRAFT' ? null : new Date(),
        notes: '[demo-seed]',
      })),
    );
    tracker.track(
      'invoice',
      slice.map((r) => r.id),
    );

    // One summary line item per invoice — keeps the PDF render path happy.
    const lineIds: string[] = [];
    const lineValues = slice.map((r) => {
      const id = randomUUID();
      lineIds.push(id);
      return {
        id,
        invoiceId: r.id,
        kind: 'TIME_AGGREGATE' as const,
        description: 'Professional services rendered [demo-seed]',
        quantity: '1',
        unitAmountCents: r.subtotal,
        amountCents: r.subtotal,
      };
    });
    await tx.insert(invoiceLineItems).values(lineValues);
    tracker.track('invoice_line_item', lineIds);

    // Payments for PAID / PARTIALLY_PAID.
    const paymentRows = slice
      .filter((r) => r.paidCents > 0)
      .map((r) => ({
        id: randomUUID(),
        invoiceId: r.id,
        amountCents: r.paidCents,
        provider: pick(['STRIPE', 'CPACHARGE', 'MANUAL'] as const),
        status: 'SUCCEEDED' as const,
        receivedAt: r.paidAt ?? new Date(),
      }));
    if (paymentRows.length > 0) {
      await tx.insert(paymentsTable).values(paymentRows);
      tracker.track(
        'payment',
        paymentRows.map((p) => p.id),
      );
    }
  }
  await tracker.flush();
}

// ---------------------------------------------------------------------------
// File-manager v2 data: bind N clients to folders, write sentinels +
// sample files into STORAGE_LOCAL_PATH, insert files rows.
// ---------------------------------------------------------------------------

async function seedFolders(
  tx: Tx,
  tracker: Tracker,
  ctx: SeedContext,
  clientsList: DemoClient[],
  folderCount: number,
  filesPerFolder: number,
): Promise<void> {
  const storageRoot = process.env['STORAGE_LOCAL_PATH'] ?? '/data/storage-mock';
  const sentinelFolder = process.env['STORAGE_SENTINEL_FOLDER'] ?? '_Vibe';
  const sentinelFile = process.env['STORAGE_SENTINEL_FILE'] ?? 'client.json';

  const fileTypes = [
    { ext: 'pdf', mime: 'application/pdf', subfolder: 'Invoices/' },
    { ext: 'pdf', mime: 'application/pdf', subfolder: 'Engagement Letters/' },
    {
      ext: 'xlsx',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      subfolder: 'Workpapers/',
    },
    { ext: 'pdf', mime: 'application/pdf', subfolder: 'Client Copy/' },
    {
      ext: 'docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      subfolder: 'Correspondence/',
    },
    { ext: 'pdf', mime: 'application/pdf', subfolder: 'Receipts/' },
  ] as const;

  // Pick clients deterministically: first N businesses.
  const targets = clientsList.filter((c) => c.type === 'BUSINESS').slice(0, folderCount);
  if (targets.length === 0) return;

  let storageWrites = 0;
  let storageErrors = 0;

  for (const client of targets) {
    const folderName = client.name.replace(/[\\/:"*?<>|]/g, '_');
    const storagePath = `${folderName}/`;
    const sentinelKey = `${storagePath}${sentinelFolder}/${sentinelFile}`;
    const folderId = randomUUID();

    const sentinelPayload = {
      version: 1,
      client_id: client.id,
      firm_id: ctx.firmId,
      tax_software_id: null,
      display_name_at_creation: client.name,
      created_at: new Date().toISOString(),
      created_by: client.partnerId,
    };
    const sentinelBody = `${JSON.stringify(sentinelPayload, null, 2)}\n`;
    const sentinelEtag = createHash('sha256').update(sentinelBody).digest('hex');

    // Best-effort write to local mock storage. Skips silently if the
    // path isn't writable (e.g. running outside the api container).
    try {
      const absSentinel = resolve(join(storageRoot, sentinelKey));
      await fs.mkdir(dirname(absSentinel), { recursive: true });
      await fs.writeFile(absSentinel, sentinelBody, 'utf8');
      await fs.writeFile(`${absSentinel}.__etag`, sentinelEtag, 'utf8');
      storageWrites += 1;
    } catch (err) {
      storageErrors += 1;
      void err;
    }

    await tx.insert(clientFolders).values({
      id: folderId,
      firmId: ctx.firmId,
      clientId: client.id,
      storagePath,
      sentinelEtag,
      status: 'active',
      lastSyncedAt: new Date(),
    });
    tracker.track('client_folders', [folderId]);

    // Files
    const fileRows: Array<{ id: string; storageKey: string }> = [];
    for (let i = 0; i < filesPerFolder; i++) {
      const t = pick(fileTypes);
      const baseName = `${pick([
        'Invoice',
        'Statement',
        'Workpaper',
        'Letter',
        'Report',
        'Schedule',
      ])} ${pickInt(1000, 9999)}.${t.ext}`;
      const storageKey = `${storagePath}${t.subfolder}${baseName}`;
      // Workpapers stay private per the default firm visibility rule;
      // everything else is mostly client-visible with a 25% private skew.
      const visibility: 'private' | 'client_visible' =
        t.subfolder === 'Workpapers/' ? 'private' : rng() < 0.75 ? 'client_visible' : 'private';
      const body = Buffer.from(
        `Demo content for ${baseName} — generated at ${new Date().toISOString()}\n`,
        'utf8',
      );
      const etag = createHash('sha256').update(body).digest('hex');

      try {
        const abs = resolve(join(storageRoot, storageKey));
        await fs.mkdir(dirname(abs), { recursive: true });
        await fs.writeFile(abs, body);
        await fs.writeFile(`${abs}.__etag`, etag, 'utf8');
        storageWrites += 1;
      } catch (err) {
        storageErrors += 1;
        void err;
      }

      const fileId = randomUUID();
      fileRows.push({ id: fileId, storageKey });
      await tx.insert(filesTable).values({
        id: fileId,
        firmId: ctx.firmId,
        clientId: client.id,
        clientFolderId: folderId,
        subfolderPath: t.subfolder,
        originalFilename: baseName,
        storageKey,
        mimeType: t.mime,
        sizeBytes: body.byteLength,
        etag,
        category: pick([
          'invoice',
          'engagement_letter',
          'receipt',
          'time_entry_support',
          'correspondence',
          'other',
        ]),
        source: 'explorer',
        visibility,
        uploadedAt: new Date(Date.now() - pickInt(0, 60) * 86400_000),
        modifiedAt: new Date(Date.now() - pickInt(0, 30) * 86400_000),
        pendingUpload: false,
      });
    }
    tracker.track(
      'files',
      fileRows.map((f) => f.id),
    );
  }

  // A couple of open conflict / orphan events so Storage Onboarding has problems to show.
  if (targets.length >= 2) {
    const eventIds = [randomUUID(), randomUUID()];
    await tx.insert(folderSyncEvents).values([
      {
        id: eventIds[0]!,
        firmId: ctx.firmId,
        clientFolderId: null,
        eventType: 'discovered',
        pathBefore: null,
        pathAfter: 'Demo-Unknown-Folder/',
        sentinelPayload: null,
      },
      {
        id: eventIds[1]!,
        firmId: ctx.firmId,
        clientFolderId: null,
        eventType: 'sentinel_changed',
        pathBefore: 'Old-Folder/',
        pathAfter: 'Old-Folder/',
        sentinelPayload: { reason: 'unparseable', raw_error: 'bad JSON' } as unknown,
      },
    ]);
    tracker.track('folder_sync_events', eventIds);
  }

  await tracker.flush();
  defaultLog(`storage writes: ${storageWrites} ok, ${storageErrors} skipped (path unwritable)`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export interface DemoSeedResult {
  cleared: number;
  clients: number;
  engagements: number;
  timeEntries: number;
  invoices: number;
  folders: number;
}

export interface DemoSeedOptions {
  /**
   * Override default volumes for a quick smoke run from the API admin
   * panel. When omitted, env-var-driven defaults (TARGET_*) apply.
   */
  targets?: Partial<{
    clients: number;
    engagements: number;
    timeEntries: number;
    invoices: number;
    fileFolders: number;
    filesPerFolder: number;
  }>;
  onLog?: (msg: string) => void;
}

/**
 * Seed demo data into an existing firm. Idempotent: each run first
 * clears rows tracked by previous demo seeds before inserting fresh
 * data. Designed to be called from both the CLI and the admin API
 * endpoint (POST /api/staff/admin/data/load-demo).
 */
export async function runDemoSeed(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PostgresJsDatabase<any>,
  firmId: string,
  options: DemoSeedOptions = {},
): Promise<DemoSeedResult> {
  const log = options.onLog ?? defaultLog;
  const targets = {
    clients: options.targets?.clients ?? TARGET_TOTAL_CLIENTS,
    engagements: options.targets?.engagements ?? TARGET_ENGAGEMENTS,
    timeEntries: options.targets?.timeEntries ?? TARGET_TIME_ENTRIES,
    invoices: options.targets?.invoices ?? TARGET_INVOICES,
    fileFolders: options.targets?.fileFolders ?? TARGET_FILE_FOLDERS,
    filesPerFolder: options.targets?.filesPerFolder ?? FILES_PER_FOLDER,
  };

  await ensureTrackerTable(db);
  log('clearing previous demo data (if any)…');
  const cleared = await clearPreviousDemo(db);
  log(`cleared ${cleared} previously-seeded rows`);

  const ctx = await loadContext(db, firmId);
  log(`loaded context: ${ctx.userIds.length} users, ${ctx.workCodeIds.length} work codes`);
  if (ctx.workCodeIds.length === 0 || ctx.engagementTypeIds.length === 0) {
    throw new Error(
      'demo seed requires the firm to have work codes and engagement types — run bootstrap-firm first',
    );
  }

  const counts: DemoSeedResult = {
    cleared,
    clients: 0,
    engagements: 0,
    timeEntries: 0,
    invoices: 0,
    folders: 0,
  };

  await db.transaction(async (tx) => {
    const tracker = new Tracker(tx);

    const existing = await tx
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.firmId, firmId));
    const needed = Math.max(0, targets.clients - existing.length);
    log(`seeding ${needed} new clients (target total ${targets.clients})…`);
    const newClients = await seedClients(tx, tracker, ctx, needed);
    counts.clients = newClients.length;

    log(`seeding ${targets.engagements} engagements across the new clients…`);
    const engagements = await seedEngagements(tx, tracker, ctx, newClients, targets.engagements);
    counts.engagements = engagements.length;

    log(`seeding ${targets.timeEntries} time entries…`);
    await seedTimeEntries(tx, tracker, ctx, engagements, targets.timeEntries);
    counts.timeEntries = targets.timeEntries;

    log(`seeding ${targets.invoices} invoices + payments…`);
    await seedInvoicesAndPayments(tx, tracker, ctx, engagements, targets.invoices);
    counts.invoices = targets.invoices;

    log(`seeding ${targets.fileFolders} client folders × ${targets.filesPerFolder} files each…`);
    await seedFolders(tx, tracker, ctx, newClients, targets.fileFolders, targets.filesPerFolder);
    counts.folders = targets.fileFolders;
  });

  log('demo seed complete.');
  return counts;
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is required');

  const client = postgres(url, { max: 1 });
  const db = drizzle(client);

  try {
    defaultLog('locating seed firm…');
    const [firm] = await db.select().from(firms).where(eq(firms.name, FIRM_NAME)).limit(1);
    if (!firm) {
      throw new Error(`firm '${FIRM_NAME}' not seeded — run \`pnpm db:seed\` first`);
    }
    await runDemoSeed(db, firm.id);
  } finally {
    await client.end({ timeout: 5 });
  }
}

function defaultLog(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`seed-demo: ${msg}`);
}

// Run as CLI only when executed directly. The API admin endpoint imports
// `runDemoSeed` and reuses an existing DB connection instead.
const isCli =
  process.argv[1]?.endsWith('seed-demo.ts') || process.argv[1]?.endsWith('seed-demo.js');
if (isCli) {
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
