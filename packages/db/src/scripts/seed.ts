// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Seed orchestrator for the appliance. Produces a usable baseline for
// development and the Phase 2 acceptance smoke test:
//
//   - 1 firm (Granite Peak CPAs) with firm_settings
//   - 2 offices (Headquarters + Denver Branch)
//   - 7 staff users across PARTNER / MANAGER / SENIOR / STAFF roles
//   - Base taxonomy: 4 service lines, 12 work codes, 8 engagement types,
//     standard reason codes
//   - 5 sample clients (each with a partner-in-charge)
//   - 3 portal identities — one of which has client_portal_access to
//     three different clients (the multi-entity scenario)
//
// Idempotent at the firm level: re-running won't duplicate the seed firm
// (matched by firm name). Inserting on a populated DB is a no-op.

import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq, and, sql } from 'drizzle-orm';

import {
  firms,
  firmSettings,
  offices,
  appUsers,
  serviceLines,
  workCodes,
  engagementTypes,
  reasonCodes,
  clients,
  engagements as engagementsTable,
  billingBatches as billingBatchesTable,
  billingBatchEntries as billingBatchEntriesTable,
  timeEntries as timeEntriesTable,
  rateCodes as rateCodesTable,
  staffRateSnapshots as staffRateSnapshotsTable,
  staffRateSnapshotEntries as staffRateSnapshotEntriesTable,
  adjustments as adjustmentsTable,
  adjustmentAllocations as adjustmentAllocationsTable,
} from '../schema/core';
import { portalIdentity, clientPortalAccess } from '../schema/portal';
import { seedNotificationTemplates } from '../seed-helpers/notification-templates';
import { seedRetainerTierConfigs } from '../seed-helpers/retainer-tier-configs';
import { seedAppointmentTypes } from '../seed-helpers/appointment-types';
import { seedKnowledgeBase } from '../seed-helpers/knowledge-base';

const FIRM_NAME = 'Granite Peak CPAs';

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is required');

  const client = postgres(url, { max: 1 });
  const db = drizzle(client);

  try {
    const existing = await db.select().from(firms).where(eq(firms.name, FIRM_NAME)).limit(1);
    if (existing.length > 0) {
      log(`firm '${FIRM_NAME}' already seeded — exiting cleanly`);
      return;
    }

    await db.transaction(async (tx) => {
      const firmId = await seedFirm(tx);
      const officeIds = await seedOffices(tx, firmId);
      const userIds = await seedUsers(tx, firmId, officeIds);
      // 0054 — seed firm's StandardRate code, then one staff_rate_snapshot
      // per user with a StandardRate entry. Without this every new time
      // entry would fail rate resolution.
      const standardRateCodeId = await seedRateCodes(tx, firmId);
      await seedStaffRateSnapshots(tx, userIds, standardRateCodeId);
      const serviceLineIds = await seedServiceLines(tx, firmId);
      await seedWorkCodes(tx, firmId, serviceLineIds);
      await seedEngagementTypes(tx, firmId, serviceLineIds);
      const reasonIds = await seedReasonCodes(tx, firmId);
      const clientIds = await seedClients(tx, firmId, userIds, officeIds);
      await seedPortalIdentities(tx, firmId, clientIds, userIds);
      // v2 Sprint A — default notification templates (15 kinds × 2 channels).
      const tplCount = await seedNotificationTemplates(tx, firmId);
      log(`seeded ${tplCount} notification template default(s)`);
      // R0.3 — default retainer tier configs (six return types × two tiers).
      // Plus firm_retainer_settings row (feature_enabled defaults false).
      const tierCount = await seedRetainerTierConfigs(tx, firmId);
      log(`seeded ${tierCount} retainer tier config default(s)`);
      // BK-1 — default appointment types (5) for the booking system.
      const apptTypeCount = await seedAppointmentTypes(tx, firmId);
      log(`seeded ${apptTypeCount} appointment type default(s)`);
      const kb = await seedKnowledgeBase(tx, firmId);
      log(`seeded knowledge base: ${kb.categories} categories, ${kb.articles} articles`);
      // Demo loop: one engagement on the first client, four timekeepers
      // post the canonical Vance scenario, a billing batch ties them
      // together, a hierarchical-cascade write-down is applied. Reports
      // populate immediately on first sign-in.
      await seedDemoBilling(tx, firmId, clientIds, userIds, reasonIds);
    });

    log(`seeded firm '${FIRM_NAME}'`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

type Tx = Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];

async function seedFirm(tx: Tx): Promise<string> {
  const [row] = await tx
    .insert(firms)
    .values({ name: FIRM_NAME, fiscalYearStartMonth: 1, defaultTermsDays: 30 })
    .returning({ id: firms.id });
  if (!row) throw new Error('failed to insert firm');
  await tx.insert(firmSettings).values({ firmId: row.id });
  return row.id;
}

async function seedOffices(tx: Tx, firmId: string): Promise<string[]> {
  const rows = await tx
    .insert(offices)
    .values([
      { firmId, name: 'Headquarters', timezone: 'America/Chicago', isDefault: true },
      { firmId, name: 'Denver Branch', timezone: 'America/Denver', isDefault: false },
    ])
    .returning({ id: offices.id });
  return rows.map((r) => r.id);
}

const STAFF_SEED = [
  { email: 'sarah.chen@granitepeakcpa.example', fullName: 'Sarah Chen' },
  { email: 'mike.davis@granitepeakcpa.example', fullName: 'Mike Davis' },
  { email: 'rachel.kim@granitepeakcpa.example', fullName: 'Rachel Kim' },
  { email: 'jenny.park@granitepeakcpa.example', fullName: 'Jenny Park' },
  { email: 'david.park@granitepeakcpa.example', fullName: 'David Park' },
  { email: 'linda.hayes@granitepeakcpa.example', fullName: 'Linda Hayes' },
  { email: 'tom.staff@granitepeakcpa.example', fullName: 'Tom Vance' },
];

async function seedUsers(tx: Tx, firmId: string, officeIds: string[]): Promise<string[]> {
  const defaultOffice = officeIds[0];
  const rows = await tx
    .insert(appUsers)
    .values(
      STAFF_SEED.map((u) => ({
        firmId,
        email: u.email,
        fullName: u.fullName,
        defaultOfficeId: defaultOffice,
      })),
    )
    .returning({ id: appUsers.id });
  return rows.map((r) => r.id);
}

// Ordered to match STAFF_SEED above. Rates in cents/hour.
const SEED_RATES_PER_HOUR_CENTS = [
  { bill: 50000, cost: 20000 }, // Sarah Chen (partner)
  { bill: 30000, cost: 12000 }, // Mike Davis (manager)
  { bill: 25000, cost: 10000 }, // Rachel Kim (senior)
  { bill: 20000, cost: 8000 }, // Jenny Park (staff)
  { bill: 45000, cost: 18000 }, // David Park (manager)
  { bill: 40000, cost: 16000 }, // Linda Hayes (senior)
  { bill: 18000, cost: 7000 }, // Tom Vance (staff)
];

async function seedRateCodes(tx: Tx, firmId: string): Promise<string> {
  const [row] = await tx
    .insert(rateCodesTable)
    .values({
      firmId,
      code: 'StandardRate',
      description: 'Default billing rate',
      sortOrder: 0,
      isSystem: true,
    })
    .returning({ id: rateCodesTable.id });
  if (!row) throw new Error('failed to insert StandardRate');
  return row.id;
}

async function seedStaffRateSnapshots(
  tx: Tx,
  userIds: string[],
  standardRateCodeId: string,
): Promise<void> {
  if (userIds.length === 0) return;
  const snapshots = await tx
    .insert(staffRateSnapshotsTable)
    .values(
      userIds.map((id, i) => ({
        appUserId: id,
        effectiveDate: '2025-01-01',
        costRateCents: SEED_RATES_PER_HOUR_CENTS[i]?.cost ?? 10000,
      })),
    )
    .returning({ id: staffRateSnapshotsTable.id, appUserId: staffRateSnapshotsTable.appUserId });
  await tx.insert(staffRateSnapshotEntriesTable).values(
    snapshots.map((s) => {
      const i = userIds.indexOf(s.appUserId);
      return {
        snapshotId: s.id,
        rateCodeId: standardRateCodeId,
        billRateCents: SEED_RATES_PER_HOUR_CENTS[i]?.bill ?? 25000,
      };
    }),
  );
}

const SERVICE_LINES = [
  { name: 'Tax', category: 'tax' as const, color: '#3b82f6' },
  { name: 'Audit', category: 'audit' as const, color: '#ef4444' },
  { name: 'Advisory', category: 'advisory' as const, color: '#22c55e' },
  { name: 'Bookkeeping', category: 'bookkeeping' as const, color: '#f59e0b' },
];

async function seedServiceLines(tx: Tx, firmId: string): Promise<Record<string, string>> {
  const rows = await tx
    .insert(serviceLines)
    .values(SERVICE_LINES.map((s) => ({ firmId, ...s })))
    .returning({ id: serviceLines.id, name: serviceLines.name });
  return Object.fromEntries(rows.map((r) => [r.name, r.id]));
}

async function seedWorkCodes(tx: Tx, firmId: string, sl: Record<string, string>): Promise<void> {
  const codes = [
    { key: 'tax_prep', name: 'Tax Preparation', line: 'Tax' },
    { key: 'tax_review', name: 'Tax Review', line: 'Tax' },
    { key: 'tax_planning', name: 'Tax Planning', line: 'Tax' },
    { key: 'audit_fieldwork', name: 'Audit Fieldwork', line: 'Audit' },
    { key: 'audit_review', name: 'Audit Review', line: 'Audit' },
    { key: 'audit_planning', name: 'Audit Planning', line: 'Audit' },
    { key: 'advisory_meeting', name: 'Advisory Meeting', line: 'Advisory' },
    { key: 'advisory_research', name: 'Advisory Research', line: 'Advisory' },
    { key: 'bookkeeping_entry', name: 'Bookkeeping Entry', line: 'Bookkeeping' },
    { key: 'bookkeeping_reconcile', name: 'Bookkeeping Reconcile', line: 'Bookkeeping' },
    { key: 'admin', name: 'Internal / Administrative', line: 'Tax', billable: false },
    { key: 'cpe', name: 'Continuing Education', line: 'Tax', billable: false },
  ];

  await tx.insert(workCodes).values(
    codes.map((c) => ({
      firmId,
      serviceLineId: sl[c.line],
      key: c.key,
      name: c.name,
      billableDefault: c.billable ?? true,
    })),
  );
}

async function seedEngagementTypes(
  tx: Tx,
  firmId: string,
  sl: Record<string, string>,
): Promise<void> {
  const types = [
    { key: 'individual_1040', name: 'Individual 1040', line: 'Tax', fee: 'FIXED_FEE' as const },
    { key: '1120s', name: '1120-S Tax Return', line: 'Tax', fee: 'FIXED_FEE' as const },
    { key: '1065', name: '1065 Partnership Return', line: 'Tax', fee: 'FIXED_FEE' as const },
    {
      key: 'audit_gaas',
      name: 'Audit Engagement (GAAS)',
      line: 'Audit',
      fee: 'HOURLY_NTE' as const,
    },
    {
      key: 'review_ssars',
      name: 'Review Engagement (SSARS)',
      line: 'Audit',
      fee: 'FIXED_FEE' as const,
    },
    {
      key: 'compilation_ssars',
      name: 'Compilation Engagement (SSARS)',
      line: 'Audit',
      fee: 'FIXED_FEE' as const,
    },
    {
      key: 'monthly_bookkeeping',
      name: 'Monthly Bookkeeping',
      line: 'Bookkeeping',
      fee: 'RECURRING_SUBSCRIPTION' as const,
    },
    {
      key: 'payroll_services',
      name: 'Payroll Services',
      line: 'Bookkeeping',
      fee: 'RECURRING_SUBSCRIPTION' as const,
    },
  ];

  await tx.insert(engagementTypes).values(
    types.map((t) => ({
      firmId,
      serviceLineId: sl[t.line],
      key: t.key,
      name: t.name,
      defaultFeeStructure: t.fee,
    })),
  );
}

async function seedReasonCodes(tx: Tx, firmId: string): Promise<Record<string, string>> {
  const rows = await tx
    .insert(reasonCodes)
    .values([
      { firmId, category: 'WRITE_DOWN', label: 'Scope creep' },
      { firmId, category: 'WRITE_DOWN', label: 'Client relationship' },
      { firmId, category: 'WRITE_DOWN', label: 'Inefficiency' },
      { firmId, category: 'WRITE_DOWN', label: 'Estimating error' },
      { firmId, category: 'WRITE_UP', label: 'Premium service' },
      { firmId, category: 'WRITE_UP', label: 'Rush delivery' },
      { firmId, category: 'TRANSFER', label: 'Cost transfer between engagements' },
    ])
    .returning({ id: reasonCodes.id, label: reasonCodes.label });
  return Object.fromEntries(rows.map((r) => [r.label, r.id]));
}

const CLIENT_SEED = [
  { name: 'Holland Manufacturing LLC', terms: 30 },
  { name: 'Vance Holdings Inc', terms: 30 },
  { name: 'Holland Family Trust', terms: 30 },
  { name: 'Vance Realty Partners', terms: 30 },
  { name: 'Polson Bakery', terms: 15 },
];

async function seedClients(
  tx: Tx,
  firmId: string,
  userIds: string[],
  officeIds: string[],
): Promise<string[]> {
  const partnerId = userIds[0];
  if (!partnerId) throw new Error('no partner user seeded');
  const defaultOfficeId = officeIds[0];
  if (!defaultOfficeId) throw new Error('no office seeded');
  const rows = await tx
    .insert(clients)
    .values(
      CLIENT_SEED.map((c, idx) => ({
        firmId,
        name: c.name,
        partnerInChargeId: userIds[idx % userIds.length] ?? partnerId,
        officeId: officeIds[idx % officeIds.length] ?? defaultOfficeId,
        billingContactEmail: `billing@${c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.example`,
        termsDays: c.terms,
      })),
    )
    .returning({ id: clients.id, name: clients.name });
  return rows.map((r) => r.id);
}

async function seedPortalIdentities(
  tx: Tx,
  firmId: string,
  clientIds: string[],
  userIds: string[],
): Promise<void> {
  const inviter = userIds[0]!;
  const [holland, vance, _holland2, vanceRealty, polson] = clientIds;
  if (!holland || !vance || !vanceRealty || !polson) {
    throw new Error('expected at least 4 seeded clients');
  }

  // Identity 1: Tom Vance — three client accesses (the multi-entity demo).
  const [tom] = await tx
    .insert(portalIdentity)
    .values({
      firmId,
      fullName: 'Tom Vance',
      primaryEmail: 'tom.vance@vanceholdings.example',
      primaryPhone: '+13125550148',
      preferredMethod: 'EMAIL',
    })
    .returning({ id: portalIdentity.id });
  if (!tom) throw new Error('failed to insert portal_identity Tom');

  await tx.insert(clientPortalAccess).values([
    {
      portalIdentityId: tom.id,
      clientId: vance,
      role: 'FULL',
      invitedBy: inviter,
      invitedAt: new Date(),
      acceptedAt: new Date(),
      status: 'ACTIVE',
    },
    {
      portalIdentityId: tom.id,
      clientId: vanceRealty,
      role: 'PAY_ONLY',
      invitedBy: inviter,
      invitedAt: new Date(),
      acceptedAt: new Date(),
      status: 'ACTIVE',
    },
    {
      portalIdentityId: tom.id,
      clientId: holland,
      role: 'VIEW_ONLY',
      invitedBy: inviter,
      invitedAt: new Date(),
      acceptedAt: new Date(),
      status: 'ACTIVE',
    },
  ]);

  // Identity 2: Lisa Holland — single access to Holland Manufacturing.
  const [lisa] = await tx
    .insert(portalIdentity)
    .values({
      firmId,
      fullName: 'Lisa Holland',
      primaryEmail: 'lisa.holland@hollandmfg.example',
      preferredMethod: 'EMAIL',
    })
    .returning({ id: portalIdentity.id });
  if (!lisa) throw new Error('failed to insert portal_identity Lisa');
  await tx.insert(clientPortalAccess).values({
    portalIdentityId: lisa.id,
    clientId: holland,
    role: 'FULL',
    invitedBy: inviter,
    invitedAt: new Date(),
    acceptedAt: new Date(),
    status: 'ACTIVE',
  });

  // Identity 3: Polson Bakery owner — SMS-preferred portal access.
  const [polsonOwner] = await tx
    .insert(portalIdentity)
    .values({
      firmId,
      fullName: 'Renee Polson',
      primaryPhone: '+13125550149',
      preferredMethod: 'SMS',
    })
    .returning({ id: portalIdentity.id });
  if (!polsonOwner) throw new Error('failed to insert portal_identity Renee');
  await tx.insert(clientPortalAccess).values({
    portalIdentityId: polsonOwner.id,
    clientId: polson,
    role: 'FULL',
    invitedBy: inviter,
    invitedAt: new Date(),
    acceptedAt: new Date(),
    status: 'ACTIVE',
  });

  // Silence the linter for the discarded destructuring var.
  void sql;
  void and;
}

// The canonical Vance scenario per BUILD_PLAN Phase 12: four timekeepers,
// one engagement on Holland Manufacturing, $3,950 standard WIP, $1,200
// hierarchical-cascade write-down. After-seed, the realization report
// shows Sarah 0%, Mike 83.3%, Rachel + Jenny 100%.
async function seedDemoBilling(
  tx: Tx,
  firmId: string,
  clientIds: string[],
  userIds: string[],
  reasonIds: Record<string, string>,
): Promise<void> {
  const clientId = clientIds[0];
  const sarahId = userIds[0];
  const mikeId = userIds[1];
  const rachelId = userIds[2];
  const jennyId = userIds[3];
  if (!clientId || !sarahId || !mikeId || !rachelId || !jennyId) return;

  // Engagement
  const [eng] = await tx
    .insert(engagementsTable)
    .values({
      clientId,
      name: '1120-S 2026 Tax Return',
      feeStructure: 'FIXED_FEE',
      feeAmountCents: 395000,
      partnerId: sarahId,
      managerId: mikeId,
      status: 'ACTIVE',
      startDate: '2026-01-01',
    })
    .returning({ id: engagementsTable.id });
  if (!eng) return;

  // Billing batch covering January 2026
  const [batch] = await tx
    .insert(billingBatchesTable)
    .values({
      engagementId: eng.id,
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
      status: 'APPROVED',
      createdById: sarahId,
      approvedById: sarahId,
    })
    .returning({ id: billingBatchesTable.id });
  if (!batch) return;

  // The four canonical entries.
  const entrySeed = [
    { userId: sarahId, hours: '2.00', rate: 50000, amount: 100000 },
    { userId: mikeId, hours: '4.00', rate: 30000, amount: 120000 },
    { userId: rachelId, hours: '3.00', rate: 25000, amount: 75000 },
    { userId: jennyId, hours: '5.00', rate: 20000, amount: 100000 },
  ];
  const entryRows = await tx
    .insert(timeEntriesTable)
    .values(
      entrySeed.map((e) => ({
        engagementId: eng.id,
        appUserId: e.userId,
        entryDate: '2026-01-15',
        hours: e.hours,
        standardRateSnapshotCents: e.rate,
        standardAmountCents: e.amount,
        billingBatchId: batch.id,
      })),
    )
    .returning({ id: timeEntriesTable.id });

  // Tie entries to the batch action ledger
  await tx.insert(billingBatchEntriesTable).values(
    entryRows.map((r) => ({
      billingBatchId: batch.id,
      timeEntryId: r.id,
      action: 'INCLUDE' as const,
    })),
  );

  // Hierarchical cascade write-down of $1,200 (the Vance scenario).
  // Sarah (PARTNER) absorbs $1,000, Mike (MANAGER) absorbs $200, juniors
  // held harmless.
  const reasonId = reasonIds['Scope creep'];
  if (!reasonId) return;
  const [adj] = await tx
    .insert(adjustmentsTable)
    .values({
      billingBatchId: batch.id,
      method: 'TIME',
      allocationMethod: 'HIERARCHICAL_CASCADE',
      totalAmountCents: -120000,
      reasonCodeId: reasonId,
      notes: 'Demo: junior staff held harmless; cascade absorbs upward',
      status: 'APPLIED',
      createdById: sarahId,
      approverId: sarahId,
      approvedAt: new Date(),
    })
    .returning({ id: adjustmentsTable.id });
  if (!adj) return;

  const allocSeed: { userId: string; entryIdx: number; orig: number; adj: number }[] = [
    { userId: sarahId, entryIdx: 0, orig: 100000, adj: -100000 },
    { userId: mikeId, entryIdx: 1, orig: 120000, adj: -20000 },
    { userId: rachelId, entryIdx: 2, orig: 75000, adj: 0 },
    { userId: jennyId, entryIdx: 3, orig: 100000, adj: 0 },
  ];
  await tx.insert(adjustmentAllocationsTable).values(
    allocSeed.map((a) => ({
      adjustmentId: adj.id,
      timeEntryId: entryRows[a.entryIdx]!.id,
      appUserId: a.userId,
      originalValueCents: a.orig,
      adjustedValueCents: a.orig + a.adj,
      adjustmentAmountCents: a.adj,
    })),
  );

  // Reference the firmId so eslint stays quiet.
  void firmId;
}

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`seed: ${msg}`);
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
