// SPDX-License-Identifier: Elastic-2.0
//
// Time entry capture (Phase 9). Captures the rate snapshot at create time
// using @vibe/core/rates resolver, then writes the canonical row.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import type { Database } from '@vibe/db';
import {
  clientRateOverrides,
  clients,
  engagementRateOverrides,
  engagementStatusConfig,
  engagementThreadLinks,
  engagements,
  firmSettings,
  firms,
  hourBanks,
  hourBankTransactions,
  messages,
  rateCodes,
  requiredFieldRules,
  serviceLineRates,
  staffRateSnapshotEntries,
  staffRateSnapshots,
  threadMembers,
  timeEntries,
  timeEntryMessageLinks,
  timeEntryVersions,
  workCodes,
} from '@vibe/db/schema';
import { captureRateSnapshot, resolveRate, type RateCandidate } from '@vibe/core/rates';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';

export interface TimeEntryRoutesDeps extends RbacDeps {
  db: Database | null;
  redis?: Redis;
  /** Phase 8 — staff/client mail dispatcher used to notify when a
   *  retainer is auto-split exhausted by a new time entry. Optional;
   *  when absent, no email fires. */
  sendEmail?: (args: { to: string; subject: string; body: string }) => Promise<void>;
}

const TIMER_KEY_PREFIX = 'time-entry:timer:';
function timerKey(appUserId: string): string {
  return `${TIMER_KEY_PREFIX}${appUserId}`;
}

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}

/**
 * Stage 2 — validate + insert time_entry_message_link rows. Each
 * message must belong to the engagement's thread AND the user must be
 * a member of that thread. Returns the number of links written.
 * Returns -1 if validation fails (caller should respond 403).
 */
// Exported for integration tests; consumers should call the route, not
// this helper directly.
export async function linkTimeEntryMessages(
  db: Database,
  args: {
    engagementId: string;
    timeEntryId: string;
    messageIds: ReadonlyArray<string>;
    appUserId: string;
  },
): Promise<number> {
  if (args.messageIds.length === 0) return 0;
  const [link] = await db
    .select({ threadId: engagementThreadLinks.threadId })
    .from(engagementThreadLinks)
    .where(eq(engagementThreadLinks.engagementId, args.engagementId))
    .limit(1);
  if (!link) return -1;
  const [member] = await db
    .select({ id: threadMembers.id })
    .from(threadMembers)
    .where(
      and(eq(threadMembers.threadId, link.threadId), eq(threadMembers.appUserId, args.appUserId)),
    )
    .limit(1);
  if (!member) return -1;
  // All cited messages must be in this thread.
  const found = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(inArray(messages.id, args.messageIds as string[]), eq(messages.threadId, link.threadId)),
    );
  if (found.length !== args.messageIds.length) return -1;

  const rows = args.messageIds.map((mid, i) => ({
    timeEntryId: args.timeEntryId,
    messageId: mid,
    sequence: i,
  }));
  const inserted = await db
    .insert(timeEntryMessageLinks)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: timeEntryMessageLinks.id });
  return inserted.length;
}

const TimerStartSchema = z.object({
  engagementId: z.string().uuid(),
  workCodeId: z.string().uuid().optional(),
  description: z.string().max(2000).optional(),
});

const CreateSchema = z.object({
  engagementId: z.string().uuid(),
  workCodeId: z.string().uuid().optional(),
  entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hours: z.number().positive().max(24),
  billableFlag: z.boolean().optional(),
  description: z.string().max(2000).optional(),
  // 0050 — user-controlled OOS veto on top of computed in_scope_flag.
  outOfScopeOverride: z.boolean().optional(),
  // Stage 2 — caller cites the message(s) that drove this work. Each
  // id must belong to the engagement's thread AND the user must be a
  // member of that thread. Validated server-side.
  linkedMessageIds: z.array(z.string().uuid()).max(50).optional(),
  // Optionally advance the engagement's progress status as part of
  // logging. Validated against the firm's status catalog; gated by the
  // same time_entry:create permission as the entry itself.
  workflowState: z.string().min(1).max(120).optional(),
});

const UpdateSchema = z.object({
  hours: z.number().positive().max(24).optional(),
  workCodeId: z.string().uuid().nullable().optional(),
  description: z.string().max(2000).optional(),
  billableFlag: z.boolean().optional(),
  outOfScopeOverride: z.boolean().optional(),
  linkedMessageIds: z.array(z.string().uuid()).max(50).optional(),
});

const BulkFromTemplateSchema = z.object({
  template: z.object({
    engagementId: z.string().uuid(),
    workCodeId: z.string().uuid().optional(),
    hours: z.number().positive().max(24),
    description: z.string().max(2000).optional(),
    billableFlag: z.boolean().optional(),
    outOfScopeOverride: z.boolean().optional(),
  }),
  dates: z
    .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
    .min(1)
    .max(60),
});

async function loadRateCandidates(
  db: Database,
  args: {
    firmId: string;
    appUserId: string;
    engagementId: string;
    clientId: string;
    serviceLineId: string | null;
  },
): Promise<RateCandidate[]> {
  const out: RateCandidate[] = [];

  // 0054 — staff snapshots: one effective-dated row per staff, with one
  // entry per rate code. We tag the StandardRate entries so the resolver
  // can fall back when the engagement's rate code has no entry.
  const snap = await db
    .select({
      snapshotId: staffRateSnapshots.id,
      effectiveDate: staffRateSnapshots.effectiveDate,
      costRateCents: staffRateSnapshots.costRateCents,
      rateCodeId: staffRateSnapshotEntries.rateCodeId,
      billRateCents: staffRateSnapshotEntries.billRateCents,
      codeStr: rateCodes.code,
    })
    .from(staffRateSnapshots)
    .innerJoin(
      staffRateSnapshotEntries,
      eq(staffRateSnapshotEntries.snapshotId, staffRateSnapshots.id),
    )
    .innerJoin(rateCodes, eq(rateCodes.id, staffRateSnapshotEntries.rateCodeId))
    .where(
      and(eq(staffRateSnapshots.appUserId, args.appUserId), eq(rateCodes.firmId, args.firmId)),
    );
  for (const r of snap) {
    out.push({
      level: 'staff_rate',
      appUserId: args.appUserId,
      rateCodeId: r.rateCodeId,
      isStandardCode: r.codeStr === 'StandardRate',
      billRateCents: r.billRateCents,
      costRateCents: r.costRateCents ?? null,
      effectiveStart: r.effectiveDate,
      effectiveEnd: null,
    });
  }

  const cl = await db
    .select()
    .from(clientRateOverrides)
    .where(
      and(
        eq(clientRateOverrides.clientId, args.clientId),
        eq(clientRateOverrides.appUserId, args.appUserId),
      ),
    );
  for (const r of cl) {
    out.push({
      level: 'client',
      clientId: args.clientId,
      appUserId: args.appUserId,
      billRateCents: r.billRateCents,
      effectiveStart: r.effectiveStart,
      effectiveEnd: r.effectiveEnd ?? null,
    });
  }

  const eng = await db
    .select()
    .from(engagementRateOverrides)
    .where(
      and(
        eq(engagementRateOverrides.engagementId, args.engagementId),
        eq(engagementRateOverrides.appUserId, args.appUserId),
      ),
    );
  for (const r of eng) {
    out.push({
      level: 'engagement',
      engagementId: args.engagementId,
      appUserId: args.appUserId,
      billRateCents: r.billRateCents,
      effectiveStart: r.effectiveStart,
    });
  }

  if (args.serviceLineId) {
    const sl = await db
      .select()
      .from(serviceLineRates)
      .where(eq(serviceLineRates.serviceLineId, args.serviceLineId));
    for (const r of sl) {
      out.push({
        level: 'service_line',
        serviceLineId: args.serviceLineId,
        appUserId: args.appUserId,
        billRateCents: r.billRateCents,
        effectiveStart: r.effectiveStart,
        effectiveEnd: r.effectiveEnd ?? null,
      });
    }
  }

  return out;
}

type TimeEntryCandidate = {
  engagementId: string;
  engagementTypeId: string | null;
  workCodeId: string | null;
  serviceLineId: string | null;
  description: string | null;
  reasonCodeId: string | null;
};

function ruleMatches(conds: Record<string, unknown>, te: TimeEntryCandidate): boolean {
  for (const [k, v] of Object.entries(conds)) {
    const want = String(v);
    switch (k) {
      case 'engagementTypeId':
        if (te.engagementTypeId !== want) return false;
        break;
      case 'engagementId':
        if (te.engagementId !== want) return false;
        break;
      case 'workCodeId':
        if (te.workCodeId !== want) return false;
        break;
      case 'serviceLineId':
        if (te.serviceLineId !== want) return false;
        break;
      default:
        // Unknown keys make the rule never match — fail closed.
        return false;
    }
  }
  return true;
}

function missingFields(fields: string[], te: TimeEntryCandidate): string[] {
  const missing: string[] = [];
  for (const f of fields) {
    const v = (te as unknown as Record<string, unknown>)[f];
    if (v == null || (typeof v === 'string' && v.trim().length === 0)) missing.push(f);
  }
  return missing;
}

async function evaluateRequiredFieldRules(
  db: Database,
  firmId: string,
  te: TimeEntryCandidate,
): Promise<{ ok: true } | { ok: false; ruleId: string; ruleName: string; missing: string[] }> {
  const rules = await db
    .select()
    .from(requiredFieldRules)
    .where(and(eq(requiredFieldRules.firmId, firmId), eq(requiredFieldRules.status, 'ACTIVE')));
  for (const r of rules) {
    const conds = (r.conditionsJson ?? {}) as Record<string, unknown>;
    if (!ruleMatches(conds, te)) continue;
    const fields = Array.isArray(r.requiredFields) ? (r.requiredFields as string[]) : [];
    const miss = missingFields(fields, te);
    if (miss.length > 0) return { ok: false, ruleId: r.id, ruleName: r.name, missing: miss };
  }
  return { ok: true };
}

export function createTimeEntryRouter(deps: TimeEntryRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.post(
    '/',
    requirePermission(deps, 'time_entry:create'),
    async (req: Request, res: Response) => {
      const parsed = CreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }

      // Resolve engagement → client → service line
      const [eng] = await deps.db
        .select()
        .from(engagements)
        .where(eq(engagements.id, parsed.data.engagementId))
        .limit(1);
      if (!eng) {
        res.status(404).json({ error: 'engagement_not_found' });
        return;
      }
      // Lifecycle enforcement: PAUSED engagements cannot accept new time.
      if (eng.status === 'PAUSED' || eng.status === 'CLOSED' || eng.status === 'ARCHIVED') {
        res.status(409).json({ error: 'engagement_not_writable', status: eng.status });
        return;
      }
      // 0050 — retainer lock: when a retainer billing batch is locking
      // the engagement, no new time may be logged against it.
      if (eng.retainerLockedAt) {
        res.status(409).json({ error: 'retainer_locked', lockedAt: eng.retainerLockedAt });
        return;
      }
      // Phase 9 #16 — late-entry lockout. firm_settings.lateEntryLockoutDays
      // defines the back-dating window; entries older than (today - lockout)
      // are refused with 409 unless the user has the bypass permission.
      const [fsLock] = await deps.db
        .select({ lockoutDays: firmSettings.lateEntryLockoutDays })
        .from(firmSettings)
        .where(eq(firmSettings.firmId, session.firmId))
        .limit(1);
      const lockoutDays = fsLock?.lockoutDays ?? 14;
      if (lockoutDays > 0) {
        const todayStr = new Date().toISOString().slice(0, 10);
        const cutoff = new Date(Date.now() - lockoutDays * 86_400_000).toISOString().slice(0, 10);
        if (parsed.data.entryDate < cutoff && parsed.data.entryDate <= todayStr) {
          res.status(409).json({
            error: 'late_entry_locked',
            entryDate: parsed.data.entryDate,
            lockoutDays,
            cutoff,
          });
          return;
        }
      }
      const [client] = await deps.db
        .select()
        .from(clients)
        .where(eq(clients.id, eng.clientId))
        .limit(1);
      if (!client || client.firmId !== session.firmId) {
        res.status(404).json({ error: 'client_not_found' });
        return;
      }

      // Optional progress-status change. Validate up-front (fail fast,
      // nothing created on a bad status); applied after the entry inserts.
      let statusChange: { from: string; to: string } | null = null;
      if (parsed.data.workflowState && parsed.data.workflowState !== eng.workflowState) {
        const [statusRow] = await deps.db
          .select({ ws: engagementStatusConfig.workflowState })
          .from(engagementStatusConfig)
          .where(
            and(
              eq(engagementStatusConfig.firmId, session.firmId),
              eq(engagementStatusConfig.workflowState, parsed.data.workflowState),
            ),
          )
          .limit(1);
        if (!statusRow) {
          res.status(400).json({ error: 'invalid_workflow_state' });
          return;
        }
        statusChange = { from: eng.workflowState, to: parsed.data.workflowState };
      }

      let serviceLineId: string | null = null;
      if (parsed.data.workCodeId) {
        const [wc] = await deps.db
          .select({ serviceLineId: workCodes.serviceLineId })
          .from(workCodes)
          .where(eq(workCodes.id, parsed.data.workCodeId))
          .limit(1);
        serviceLineId = wc?.serviceLineId ?? null;
      }

      const ruleCheck = await evaluateRequiredFieldRules(deps.db, session.firmId, {
        engagementId: eng.id,
        engagementTypeId: eng.engagementTypeId ?? null,
        workCodeId: parsed.data.workCodeId ?? null,
        serviceLineId,
        description: parsed.data.description ?? null,
        reasonCodeId: null,
      });
      if (!ruleCheck.ok) {
        res.status(400).json({
          error: 'required_fields_missing',
          ruleId: ruleCheck.ruleId,
          ruleName: ruleCheck.ruleName,
          missing: ruleCheck.missing,
        });
        return;
      }

      const candidates = await loadRateCandidates(deps.db, {
        firmId: session.firmId,
        appUserId: session.appUserId,
        engagementId: eng.id,
        clientId: client.id,
        serviceLineId,
      });

      const [firm] = await deps.db
        .select({ id: firms.id })
        .from(firms)
        .where(eq(firms.id, session.firmId))
        .limit(1);
      if (!firm) {
        res.status(500).json({ error: 'firm_not_found' });
        return;
      }
      // Firm default bill rate isn't on the schema (deliberately — every
      // staff has at least a StandardRate snapshot entry). We fall back
      // to a sentinel 0 if nothing resolves; the API refuses the entry.
      const resolved = resolveRate({
        serviceDate: parsed.data.entryDate,
        appUserId: session.appUserId,
        engagementId: eng.id,
        clientId: client.id,
        serviceLineId,
        rateCodeId: eng.defaultRateCodeId ?? null,
        candidates,
        firmDefaultBillRateCents: 0,
      });
      if (resolved.level === 'firm' && resolved.billRateCents === 0) {
        res.status(400).json({ error: 'no_rate_resolves', userId: session.appUserId });
        return;
      }
      const snapshot = captureRateSnapshot({
        rate: resolved,
        hours: parsed.data.hours,
        multiplierBps: eng.rateMultiplierBps ?? 10000,
      });

      // NTE cap (Phase 10 #19): if the engagement has nte_cap_cents set,
      // reject when this entry would push the running standard-amount
      // total past the cap. LIFETIME scope is enforced across all entries;
      // PERIOD scope uses the calendar month containing entryDate.
      if (eng.nteCapCents != null && Number(eng.nteCapCents) > 0) {
        const monthStart = parsed.data.entryDate.slice(0, 7) + '-01';
        const nextMonth = new Date(monthStart + 'T00:00:00Z');
        nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
        const monthEnd = nextMonth.toISOString().slice(0, 10);
        const conds = [
          eq(timeEntries.engagementId, eng.id),
          inArray(timeEntries.status, ['SUBMITTED', 'LOCKED', 'BILLED']),
        ];
        if (eng.nteCapScope === 'PERIOD') {
          conds.push(gte(timeEntries.entryDate, monthStart));
          conds.push(lte(timeEntries.entryDate, monthEnd));
        }
        const [accum] = await deps.db
          .select({
            total: sql<number>`COALESCE(SUM(${timeEntries.standardAmountCents}), 0)`.as('total'),
          })
          .from(timeEntries)
          .where(and(...conds));
        const projected = Number(accum?.total ?? 0) + snapshot.amountCents;
        if (projected > Number(eng.nteCapCents)) {
          res.status(409).json({
            error: 'nte_cap_exceeded',
            capCents: Number(eng.nteCapCents),
            projectedCents: projected,
          });
          return;
        }
      }

      // Q20 — in_scope flag set at write time from engagement's array
      const inScope =
        eng.mixedModeEnabled && parsed.data.workCodeId
          ? eng.inScopeWorkCodeIds.includes(parsed.data.workCodeId)
          : true;

      const [row] = await deps.db
        .insert(timeEntries)
        .values({
          engagementId: eng.id,
          appUserId: session.appUserId,
          workCodeId: parsed.data.workCodeId ?? null,
          entryDate: parsed.data.entryDate,
          hours: parsed.data.hours.toString(),
          billableFlag: parsed.data.billableFlag ?? true,
          inScopeFlag: inScope,
          outOfScopeOverride: parsed.data.outOfScopeOverride ?? false,
          description: parsed.data.description ?? '',
          standardRateSnapshotCents: snapshot.rateCents,
          standardAmountCents: snapshot.amountCents,
          // 0063 — lock the cost rate at write time alongside the bill
          // rate. snapshot.costRateCents is null when no
          // staff_rate_snapshot exists for the user; downstream sums
          // COALESCE to 0 in that case.
          costRateSnapshotCents: snapshot.costRateCents,
        })
        .returning({ id: timeEntries.id });

      // Apply the optional progress-status change (validated above). Uses
      // the same entity_type as the dedicated PATCH so it flows into the
      // engagement Status history. Best-effort audit (logged, not swallowed).
      if (statusChange) {
        await deps.db
          .update(engagements)
          .set({ workflowState: statusChange.to, updatedAt: new Date() })
          .where(eq(engagements.id, eng.id));
        await emitAudit(deps.db, {
          action: 'UPDATE',
          entityType: 'engagement_workflow_state',
          entityId: eng.id,
          actorAppUserId: session.appUserId,
          before: { workflowState: statusChange.from },
          after: { workflowState: statusChange.to },
          ip: req.ip ?? null,
          userAgent: req.header('user-agent') ?? null,
        }).catch((err: unknown) =>
          logger.error(
            { err, engagementId: eng.id },
            'audit emit failed (workflow_state via time entry)',
          ),
        );
      }

      // Phase 10 #13 — auto-debit hour bank if this engagement has one.
      // Best-effort: don't fail the time entry if the bank can't be
      // debited (out-of-balance or query error logs but doesn't roll
      // back the entry; OOS hours legitimately can't reduce a depleted
      // bank, the partner reviews these at pre-bill).
      let hourBankDebit: {
        bankId: string;
        debitedHours: number;
        balanceAfterHours: number;
      } | null = null;
      const debitableHours = inScope ? parsed.data.hours : 0;
      if (row?.id && debitableHours > 0) {
        try {
          const [bank] = await deps.db
            .select({
              id: hourBanks.id,
              openingHours: hourBanks.openingHours,
              openingAmountCents: hourBanks.openingAmountCents,
              forfeitedAt: hourBanks.forfeitedAt,
            })
            .from(hourBanks)
            .where(eq(hourBanks.engagementId, eng.id))
            .limit(1);
          if (bank && !bank.forfeitedAt) {
            const [agg] = await deps.db
              .select({
                debited:
                  sql<string>`COALESCE(SUM(CASE WHEN ${hourBankTransactions.type} IN ('DEBIT','EXPIRE','FORFEIT') THEN ${hourBankTransactions.hours} ELSE 0 END), 0)`.as(
                    'debited',
                  ),
                purchased:
                  sql<string>`COALESCE(SUM(CASE WHEN ${hourBankTransactions.type} = 'PURCHASE' THEN ${hourBankTransactions.hours} ELSE 0 END), 0)`.as(
                    'purchased',
                  ),
              })
              .from(hourBankTransactions)
              .where(eq(hourBankTransactions.hourBankId, bank.id));
            const balanceBefore =
              Number(bank.openingHours) + Number(agg?.purchased ?? 0) - Number(agg?.debited ?? 0);
            // Debit only the portion that fits; the rest is unbanked
            // overage (handled at billing time via the mixed-mode lane).
            const toDebit = Math.min(debitableHours, Math.max(balanceBefore, 0));
            if (toDebit > 0) {
              const balanceAfter = balanceBefore - toDebit;
              const proRataAmount = Math.round(
                (toDebit / parsed.data.hours) * snapshot.amountCents,
              );
              const [tx] = await deps.db
                .insert(hourBankTransactions)
                .values({
                  hourBankId: bank.id,
                  type: 'DEBIT',
                  hours: toDebit.toFixed(2),
                  amountCents: proRataAmount,
                  sourceRefType: 'time_entry',
                  sourceRefId: row.id,
                  runningBalanceHours: balanceAfter.toFixed(2),
                  occurredAt: new Date(),
                })
                .returning({ id: hourBankTransactions.id });
              hourBankDebit = {
                bankId: bank.id,
                debitedHours: toDebit,
                balanceAfterHours: balanceAfter,
              };
              await emitAudit(deps.db, {
                action: 'CREATE',
                entityType: 'hour_bank_transaction',
                entityId: tx?.id,
                actorAppUserId: session.appUserId,
                after: {
                  type: 'DEBIT',
                  source: 'time_entry_auto',
                  bankId: bank.id,
                  hours: toDebit,
                  amountCents: proRataAmount,
                  timeEntryId: row.id,
                },
                ip: clientIp(req),
                userAgent: req.header('user-agent') ?? null,
              }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
            }
          }
        } catch (err) {
          logger.warn({ err, engagementId: eng.id }, 'hour-bank auto-debit failed');
        }
      }

      // R5 — Phase 8 — retainer auto-split. After the time_entry insert
      // we run the consumption logic in its own short transaction
      // (SELECT FOR UPDATE on the retainer row serializes concurrent
      // inserts against the same retainer). When a retainer hit
      // occurs, update the time_entry row with the split breakdown.
      // Best-effort: failures route the entry to 100% billable WIP
      // and log; the entry itself stays in the DB.
      if (row?.id) {
        try {
          const { applyTimeEntryToRetainer } = await import('../retainers/consumption');
          const split = await deps.db.transaction(async (tx) => {
            return applyTimeEntryToRetainer(tx, {
              engagementId: eng.id,
              entryDate: parsed.data.entryDate,
              hours: parsed.data.hours,
              workCodeId: parsed.data.workCodeId ?? null,
              actorAppUserId: session.appUserId,
              timeEntryId: row.id,
            });
          });
          if (split.retainerId) {
            await deps.db
              .update(timeEntries)
              .set({
                retainerId: split.retainerId,
                retainerHours: String(split.retainerHours),
                billableHours: String(split.billableHours),
              })
              .where(eq(timeEntries.id, row.id));
            if (split.exhausted && deps.sendEmail) {
              try {
                const { notifyRetainerExhausted } = await import('../retainers/notifications');
                await notifyRetainerExhausted(deps.db, split.retainerId, deps.sendEmail);
              } catch (err) {
                logger.warn(
                  { err, retainerId: split.retainerId },
                  'retainer.exhausted notification failed',
                );
              }
            }
          } else {
            // Entry routed entirely to WIP — stamp billableHours for
            // reporting parity.
            await deps.db
              .update(timeEntries)
              .set({ billableHours: String(parsed.data.hours) })
              .where(eq(timeEntries.id, row.id));
          }
        } catch (err) {
          logger.error({ err, timeEntryId: row.id }, 'retainer auto-split failed');
        }
      }

      // Stage 2 — wire any cited messages to this time entry. Validation
      // failures bubble out as 403 so the caller knows the entry was
      // created but links were rejected; the entry row stays in the DB
      // (the partner can manually link via update later).
      let linkedMessages = 0;
      if (row?.id && parsed.data.linkedMessageIds && parsed.data.linkedMessageIds.length > 0) {
        const n = await linkTimeEntryMessages(deps.db, {
          engagementId: eng.id,
          timeEntryId: row.id,
          messageIds: parsed.data.linkedMessageIds,
          appUserId: session.appUserId,
        });
        if (n === -1) {
          res.status(403).json({
            error: 'message_link_forbidden',
            timeEntryId: row.id,
            reason: 'not_a_thread_member_or_messages_out_of_thread',
          });
          return;
        }
        linkedMessages = n;
      }

      res.status(201).json({
        id: row?.id,
        rateSnapshot: snapshot.rateCents,
        amount: snapshot.amountCents,
        resolutionLevel: resolved.level,
        hourBankDebit,
        linkedMessages,
        // Effective progress status after this save (lets the form update
        // its local copy without a full reload).
        workflowState: statusChange?.to ?? eng.workflowState,
      });
    },
  );

  // ============================================================
  // P2.2 — D.5/D.6 linked-messages drill-in for pre-bill review
  // GET /:id/linked-messages
  // Returns the messages linked to this time entry, decrypted via the
  // engagement's thread T-DEK. Authorized via the same permissions as
  // viewing the entry; cross-thread / no-thread / non-member callers
  // get a clean 403/404.
  // ============================================================
  router.get(
    '/:id/linked-messages',
    requirePermission(deps, 'time_entry:read:all'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const entryId = req.params['id']!;
      const { batchDecryptForThread } = await import('../engagement-messaging/thread-crypto');
      // Resolve the time entry → engagement → thread + verify firm scope
      const [entry] = await deps.db
        .select({
          id: timeEntries.id,
          engagementId: timeEntries.engagementId,
          clientFirmId: clients.firmId,
        })
        .from(timeEntries)
        .innerJoin(engagements, eq(engagements.id, timeEntries.engagementId))
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(eq(timeEntries.id, entryId))
        .limit(1);
      if (!entry || entry.clientFirmId !== session.firmId) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [link] = await deps.db
        .select({ threadId: engagementThreadLinks.threadId })
        .from(engagementThreadLinks)
        .where(eq(engagementThreadLinks.engagementId, entry.engagementId))
        .limit(1);
      if (!link) {
        res.json({ items: [] });
        return;
      }
      // Permission: must be a member of the thread to read its messages
      const [member] = await deps.db
        .select({ id: threadMembers.id })
        .from(threadMembers)
        .where(
          and(
            eq(threadMembers.threadId, link.threadId),
            eq(threadMembers.appUserId, session.appUserId),
          ),
        )
        .limit(1);
      if (!member) {
        res.status(403).json({ error: 'not_a_thread_member' });
        return;
      }
      const linked = await deps.db
        .select({
          messageId: timeEntryMessageLinks.messageId,
          sequence: timeEntryMessageLinks.sequence,
          createdAt: messages.createdAt,
          senderAppUserId: messages.senderAppUserId,
          senderPortalIdentityId: messages.senderPortalIdentityId,
          bodyCiphertext: messages.bodyCiphertext,
        })
        .from(timeEntryMessageLinks)
        .innerJoin(messages, eq(messages.id, timeEntryMessageLinks.messageId))
        .where(eq(timeEntryMessageLinks.timeEntryId, entryId))
        .orderBy(asc(timeEntryMessageLinks.sequence));
      if (linked.length === 0) {
        res.json({ items: [] });
        return;
      }
      try {
        const plaintexts = await batchDecryptForThread(
          { db: deps.db, firmId: session.firmId, threadId: link.threadId },
          linked.map((r) => r.bodyCiphertext),
        );
        const items = linked.map((r, i) => ({
          messageId: r.messageId,
          sequence: r.sequence,
          createdAt: r.createdAt,
          senderAppUserId: r.senderAppUserId,
          senderPortalIdentityId: r.senderPortalIdentityId,
          body: plaintexts[i],
        }));
        res.json({ items });
      } catch (err) {
        logger.error({ err, entryId }, 'linked-messages decrypt failed');
        res.status(500).json({ error: 'decrypt_failed' });
      }
    },
  );

  router.get(
    '/export.csv',
    requirePermission(deps, 'time_entry:read:all'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.send('id,appUserId,entryDate,hours,amountCents\n');
        return;
      }
      const start = (req.query['start'] ?? '').toString();
      const end = (req.query['end'] ?? '').toString();
      const firmClients = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.firmId, session.firmId));
      const clientIds = firmClients.map((c) => c.id);
      if (clientIds.length === 0) {
        res.send('id,appUserId,entryDate,hours,amountCents\n');
        return;
      }
      const engs = await deps.db
        .select({ id: engagements.id })
        .from(engagements)
        .where(inArray(engagements.clientId, clientIds));
      const engIds = engs.map((e) => e.id);
      const conds = [inArray(timeEntries.engagementId, engIds)];
      if (/^\d{4}-\d{2}-\d{2}$/.test(start)) conds.push(gte(timeEntries.entryDate, start));
      if (/^\d{4}-\d{2}-\d{2}$/.test(end)) conds.push(lte(timeEntries.entryDate, end));
      const items = engIds.length
        ? await deps.db
            .select()
            .from(timeEntries)
            .where(and(...conds))
            .limit(20000)
        : [];
      const header = [
        'id',
        'appUserId',
        'engagementId',
        'entryDate',
        'hours',
        'rateCents',
        'amountCents',
        'billable',
        'inScope',
        'status',
      ];
      const lines = [header.join(',')];
      for (const t of items) {
        lines.push(
          [
            t.id,
            t.appUserId,
            t.engagementId,
            t.entryDate,
            t.hours,
            t.standardRateSnapshotCents,
            t.standardAmountCents,
            String(t.billableFlag),
            String(t.inScopeFlag),
            t.status,
          ].join(','),
        );
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="time-entries-${new Date().toISOString().slice(0, 10)}.csv"`,
      );
      res.send(lines.join('\n') + '\n');
    },
  );

  router.get(
    '/export.csv/by-timekeeper/:appUserId',
    requirePermission(deps, 'time_entry:read:all'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.send('id,entryDate,hours,amountCents\n');
        return;
      }
      const start = (req.query['start'] ?? '').toString();
      const end = (req.query['end'] ?? '').toString();
      const conds = [eq(timeEntries.appUserId, req.params['appUserId']!)];
      if (/^\d{4}-\d{2}-\d{2}$/.test(start)) conds.push(gte(timeEntries.entryDate, start));
      if (/^\d{4}-\d{2}-\d{2}$/.test(end)) conds.push(lte(timeEntries.entryDate, end));
      const items = await deps.db
        .select({
          id: timeEntries.id,
          entryDate: timeEntries.entryDate,
          hours: timeEntries.hours,
          rateCents: timeEntries.standardRateSnapshotCents,
          amountCents: timeEntries.standardAmountCents,
          billable: timeEntries.billableFlag,
          status: timeEntries.status,
          engagementId: timeEntries.engagementId,
          clientId: clients.id,
          clientName: clients.name,
        })
        .from(timeEntries)
        .innerJoin(engagements, eq(engagements.id, timeEntries.engagementId))
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(and(eq(clients.firmId, session.firmId), ...conds))
        .limit(20000);
      const header = [
        'id',
        'entryDate',
        'clientName',
        'engagementId',
        'hours',
        'rateCents',
        'amountCents',
        'billable',
        'status',
      ];
      const lines = [header.join(',')];
      for (const t of items) {
        lines.push(
          [
            t.id,
            t.entryDate,
            (t.clientName ?? '').replace(/,/g, ' '),
            t.engagementId,
            t.hours,
            t.rateCents,
            t.amountCents,
            String(t.billable),
            t.status,
          ].join(','),
        );
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="time-entries-${req.params['appUserId']!.slice(0, 8)}-${new Date()
          .toISOString()
          .slice(0, 10)}.csv"`,
      );
      res.send(lines.join('\n') + '\n');
    },
  );

  router.get(
    '/by-engagement/:engagementId',
    requirePermission(deps, 'time_entry:read:all'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      // Scope: engagement must belong to firm.
      const [scope] = await deps.db
        .select({ id: engagements.id })
        .from(engagements)
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(
          and(eq(engagements.id, req.params['engagementId']!), eq(clients.firmId, session.firmId)),
        )
        .limit(1);
      if (!scope) {
        res.status(404).json({ error: 'engagement_not_found' });
        return;
      }
      const start = (req.query['start'] ?? '').toString();
      const end = (req.query['end'] ?? '').toString();
      const conds = [eq(timeEntries.engagementId, req.params['engagementId']!)];
      if (/^\d{4}-\d{2}-\d{2}$/.test(start)) conds.push(gte(timeEntries.entryDate, start));
      if (/^\d{4}-\d{2}-\d{2}$/.test(end)) conds.push(lte(timeEntries.entryDate, end));
      const items = await deps.db
        .select()
        .from(timeEntries)
        .where(and(...conds))
        .limit(1000);
      res.json({ items });
    },
  );

  router.get(
    '/suggestions/mine',
    requirePermission(deps, 'time_entry:create'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
      // Rank by frequency of (engagementId, workCodeId) pair over the
      // last 30 days. Returns the top 10 with their last-used date so the
      // UI can pre-fill the form.
      const rows = await deps.db
        .select({
          engagementId: timeEntries.engagementId,
          workCodeId: timeEntries.workCodeId,
          count: sql<number>`COUNT(*)`,
          lastDate: sql<string>`MAX(${timeEntries.entryDate})`,
        })
        .from(timeEntries)
        .where(and(eq(timeEntries.appUserId, session.appUserId), gte(timeEntries.entryDate, since)))
        .groupBy(timeEntries.engagementId, timeEntries.workCodeId)
        .orderBy(sql`COUNT(*) DESC`)
        .limit(10);
      res.json({ items: rows });
    },
  );

  router.get(
    '/by-client/:clientId',
    requirePermission(deps, 'time_entry:read:all'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const [client] = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(and(eq(clients.id, req.params['clientId']!), eq(clients.firmId, session.firmId)))
        .limit(1);
      if (!client) {
        res.status(404).json({ error: 'client_not_found' });
        return;
      }
      const engIds = await deps.db
        .select({ id: engagements.id })
        .from(engagements)
        .where(eq(engagements.clientId, req.params['clientId']!));
      const ids = engIds.map((e) => e.id);
      if (ids.length === 0) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select()
        .from(timeEntries)
        .where(inArray(timeEntries.engagementId, ids))
        .limit(1000);
      res.json({ items });
    },
  );

  router.post(
    '/:id/submit',
    requirePermission(deps, 'time_entry:update:own'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [prior] = await deps.db
        .select()
        .from(timeEntries)
        .where(eq(timeEntries.id, req.params['id']!))
        .limit(1);
      if (!prior) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (prior.appUserId !== session.appUserId) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      if (prior.status !== 'DRAFT') {
        res.status(409).json({ error: 'not_draft', status: prior.status });
        return;
      }
      await deps.db
        .update(timeEntries)
        .set({ status: 'SUBMITTED' })
        .where(eq(timeEntries.id, prior.id));
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/lock',
    requirePermission(deps, 'time_entry:update:any'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      await deps.db
        .update(timeEntries)
        .set({ status: 'LOCKED', lockedAt: new Date() })
        .where(eq(timeEntries.id, req.params['id']!));
      res.json({ ok: true });
    },
  );

  router.get(
    '/mine',
    requirePermission(deps, 'time_entry:read:own'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const start = (req.query['start'] ?? '').toString();
      const end = (req.query['end'] ?? '').toString();
      // 0050 — exclude soft-deleted entries from "my entries".
      const conds = [
        eq(timeEntries.appUserId, session.appUserId),
        sql`${timeEntries.status} <> 'ARCHIVED'`,
      ];
      if (/^\d{4}-\d{2}-\d{2}$/.test(start)) conds.push(gte(timeEntries.entryDate, start));
      if (/^\d{4}-\d{2}-\d{2}$/.test(end)) conds.push(lte(timeEntries.entryDate, end));
      const items = await deps.db
        .select()
        .from(timeEntries)
        .where(and(...conds))
        .limit(500);
      res.json({ items });
    },
  );

  // 0050 — Rich list endpoint backing the /time "My entries" view.
  // Always scoped to the current user (mirrors /mine permission) — a
  // future cross-user variant can layer on top using read:all. Returns
  // { rows, total, page, pageSize } with filters: date range, client,
  // engagement, billable, OOS. Sort + pagination supported.
  router.get(
    '/list',
    requirePermission(deps, 'time_entry:read:own'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ rows: [], total: 0, page: 1, pageSize: 50 });
        return;
      }
      const q = req.query;
      const conds = [
        eq(clients.firmId, session.firmId),
        eq(timeEntries.appUserId, session.appUserId),
        sql`${timeEntries.status} <> 'ARCHIVED'`,
      ];
      const start = typeof q['startDate'] === 'string' ? q['startDate'] : '';
      const end = typeof q['endDate'] === 'string' ? q['endDate'] : '';
      if (/^\d{4}-\d{2}-\d{2}$/.test(start)) conds.push(gte(timeEntries.entryDate, start));
      if (/^\d{4}-\d{2}-\d{2}$/.test(end)) conds.push(lte(timeEntries.entryDate, end));
      if (typeof q['clientId'] === 'string' && q['clientId'])
        conds.push(eq(engagements.clientId, q['clientId']));
      if (typeof q['engagementId'] === 'string' && q['engagementId'])
        conds.push(eq(timeEntries.engagementId, q['engagementId']));
      if (typeof q['billable'] === 'string') {
        if (q['billable'] === 'true') conds.push(eq(timeEntries.billableFlag, true));
        if (q['billable'] === 'false') conds.push(eq(timeEntries.billableFlag, false));
      }
      if (typeof q['outOfScope'] === 'string') {
        if (q['outOfScope'] === 'true') conds.push(eq(timeEntries.outOfScopeOverride, true));
        if (q['outOfScope'] === 'false') conds.push(eq(timeEntries.outOfScopeOverride, false));
      }
      const page = Math.max(1, parseInt(String(q['page'] ?? '1'), 10) || 1);
      const pageSize = Math.min(
        500,
        Math.max(1, parseInt(String(q['pageSize'] ?? '50'), 10) || 50),
      );
      const sortCol = String(q['sort'] ?? 'entryDate');
      const sortDir = String(q['dir'] ?? 'desc') === 'asc' ? 'asc' : 'desc';
      const sortMap: Record<string, ReturnType<typeof sql>> = {
        entryDate: sql`${timeEntries.entryDate}`,
        hours: sql`${timeEntries.hours}`,
        amount: sql`${timeEntries.standardAmountCents}`,
        client: sql`${clients.name}`,
        engagement: sql`${engagements.name}`,
        billable: sql`${timeEntries.billableFlag}`,
        description: sql`${timeEntries.description}`,
      };
      const orderExpr = sortMap[sortCol] ?? sortMap['entryDate']!;

      const totalRows = await deps.db
        .select({ total: sql<number>`COUNT(*)`.as('total') })
        .from(timeEntries)
        .innerJoin(engagements, eq(engagements.id, timeEntries.engagementId))
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(and(...conds));
      const total = totalRows[0]?.total ?? 0;

      // Field names align with the existing TimeEntry interface
      // (standardAmountCents, billableFlag, inScopeFlag) so the same
      // row shape works for inline edit + Quick Log views.
      const rows = await deps.db
        .select({
          id: timeEntries.id,
          entryDate: timeEntries.entryDate,
          hours: timeEntries.hours,
          standardAmountCents: timeEntries.standardAmountCents,
          standardRateSnapshotCents: timeEntries.standardRateSnapshotCents,
          billableFlag: timeEntries.billableFlag,
          inScopeFlag: timeEntries.inScopeFlag,
          outOfScopeOverride: timeEntries.outOfScopeOverride,
          status: timeEntries.status,
          description: timeEntries.description,
          billingBatchId: timeEntries.billingBatchId,
          lockedAt: timeEntries.lockedAt,
          appUserId: timeEntries.appUserId,
          workCodeId: timeEntries.workCodeId,
          engagementId: engagements.id,
          engagementName: engagements.name,
          clientId: clients.id,
          clientName: clients.name,
        })
        .from(timeEntries)
        .innerJoin(engagements, eq(engagements.id, timeEntries.engagementId))
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(and(...conds))
        .orderBy(sortDir === 'asc' ? orderExpr : desc(orderExpr))
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      res.json({ rows, total: Number(total), page, pageSize });
    },
  );

  router.patch(
    '/:id',
    requirePermission(deps, 'time_entry:update:own'),
    async (req: Request, res: Response) => {
      const parsed = UpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      // Version-stamp the prior shape (immutability of past values).
      const [prior] = await deps.db
        .select()
        .from(timeEntries)
        .where(eq(timeEntries.id, req.params['id']!))
        .limit(1);
      if (!prior) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (prior.appUserId !== session.appUserId) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      // Once attached to a billing batch OR soft-deleted, the entry is
      // read-only.
      if (prior.lockedAt || prior.billingBatchId) {
        res.status(409).json({ error: 'locked', billingBatchId: prior.billingBatchId });
        return;
      }
      if (prior.status === 'ARCHIVED') {
        res.status(409).json({ error: 'archived' });
        return;
      }

      const [maxVersion] = await deps.db
        .select({ v: timeEntryVersions.version })
        .from(timeEntryVersions)
        .where(eq(timeEntryVersions.timeEntryId, prior.id))
        .orderBy(timeEntryVersions.version)
        .limit(1);
      const nextVersion = (maxVersion?.v ?? 0) + 1;
      await deps.db.insert(timeEntryVersions).values({
        timeEntryId: prior.id,
        version: nextVersion,
        fields: prior,
        editedById: session.appUserId,
      });

      // Rate snapshot does NOT change on edit; only mutable fields update.
      const patch: Record<string, unknown> = {};
      if (parsed.data.hours != null) {
        patch['hours'] = parsed.data.hours.toString();
        patch['standardAmountCents'] = Math.round(
          prior.standardRateSnapshotCents * parsed.data.hours,
        );
      }
      if (parsed.data.workCodeId !== undefined) patch['workCodeId'] = parsed.data.workCodeId;
      if (parsed.data.description !== undefined) patch['description'] = parsed.data.description;
      if (parsed.data.billableFlag !== undefined) patch['billableFlag'] = parsed.data.billableFlag;
      if (parsed.data.outOfScopeOverride !== undefined) {
        patch['outOfScopeOverride'] = parsed.data.outOfScopeOverride;
      }

      await deps.db.update(timeEntries).set(patch).where(eq(timeEntries.id, prior.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'time_entry',
        entityId: prior.id,
        actorAppUserId: session.appUserId,
        before: prior,
        after: patch,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

      // R5-followup — re-apply the retainer consumption if any field
      // that affects routing changed (hours, work_code_id) OR the entry
      // was previously retainer-linked. Same retainer either way per D2.
      const fieldsAffectingRetainer =
        parsed.data.hours != null || parsed.data.workCodeId !== undefined;
      if (fieldsAffectingRetainer || prior.retainerId) {
        try {
          const { reapplyTimeEntryToRetainer } = await import('../retainers/consumption');
          const newHours = parsed.data.hours ?? Number(prior.hours);
          const newWorkCodeId =
            parsed.data.workCodeId !== undefined ? parsed.data.workCodeId : prior.workCodeId;
          const split = await deps.db.transaction(async (tx) =>
            reapplyTimeEntryToRetainer(tx, {
              timeEntryId: prior.id,
              engagementId: prior.engagementId,
              priorRetainerId: prior.retainerId ?? null,
              priorRetainerHours: prior.retainerHours ? Number(prior.retainerHours) : 0,
              entryDate:
                typeof prior.entryDate === 'string'
                  ? prior.entryDate
                  : new Date(prior.entryDate as unknown as string).toISOString().slice(0, 10),
              hours: newHours,
              workCodeId: newWorkCodeId ?? null,
              actorAppUserId: session.appUserId,
            }),
          );
          await deps.db
            .update(timeEntries)
            .set({
              retainerId: split.retainerId,
              retainerHours: split.retainerId ? String(split.retainerHours) : null,
              billableHours: String(split.billableHours),
            })
            .where(eq(timeEntries.id, prior.id));
          if (split.retainerId && split.exhausted && deps.sendEmail) {
            try {
              const { notifyRetainerExhausted } = await import('../retainers/notifications');
              await notifyRetainerExhausted(deps.db, split.retainerId, deps.sendEmail);
            } catch (err) {
              logger.warn(
                { err, retainerId: split.retainerId },
                'retainer.exhausted notification failed (edit path)',
              );
            }
          }
        } catch (err) {
          logger.error({ err, timeEntryId: prior.id }, 'retainer re-apply on edit failed');
        }
      }

      // Stage 2 — replace linked messages if caller supplied a new set.
      let linkedMessages = 0;
      if (parsed.data.linkedMessageIds) {
        await deps.db
          .delete(timeEntryMessageLinks)
          .where(eq(timeEntryMessageLinks.timeEntryId, prior.id));
        if (parsed.data.linkedMessageIds.length > 0) {
          const n = await linkTimeEntryMessages(deps.db, {
            engagementId: prior.engagementId,
            timeEntryId: prior.id,
            messageIds: parsed.data.linkedMessageIds,
            appUserId: session.appUserId,
          });
          if (n === -1) {
            res.status(403).json({
              error: 'message_link_forbidden',
              reason: 'not_a_thread_member_or_messages_out_of_thread',
            });
            return;
          }
          linkedMessages = n;
        }
      }

      res.json({ ok: true, version: nextVersion, linkedMessages });
    },
  );

  // 0050 — soft-delete a time entry (per CLAUDE.md #3). Status flips to
  // ARCHIVED so the row + its time_entry_version history are preserved
  // for audit; the entry disappears from /mine and /list. Refused if
  // the entry was already added to a billing batch.
  router.delete(
    '/:id',
    requirePermission(deps, 'time_entry:update:own'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [prior] = await deps.db
        .select()
        .from(timeEntries)
        .where(eq(timeEntries.id, req.params['id']!))
        .limit(1);
      if (!prior) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (prior.appUserId !== session.appUserId) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      if (prior.lockedAt || prior.billingBatchId) {
        res.status(409).json({ error: 'locked', billingBatchId: prior.billingBatchId });
        return;
      }
      if (prior.status === 'ARCHIVED') {
        res.json({ ok: true, alreadyArchived: true });
        return;
      }
      // R5-followup — back hours out of the retainer before archiving
      // the entry so balance + status stay accurate. Best-effort; an
      // archive itself never blocks on retainer state.
      if (prior.retainerId && prior.retainerHours && Number(prior.retainerHours) > 0) {
        try {
          const { reverseTimeEntryConsumption } = await import('../retainers/consumption');
          await deps.db.transaction(async (tx) =>
            reverseTimeEntryConsumption(tx, {
              retainerId: prior.retainerId!,
              retainerHours: Number(prior.retainerHours),
              timeEntryId: prior.id,
              actorAppUserId: session.appUserId,
            }),
          );
        } catch (err) {
          logger.error({ err, timeEntryId: prior.id }, 'retainer reversal on archive failed');
        }
      }
      await deps.db
        .update(timeEntries)
        .set({ status: 'ARCHIVED', updatedAt: new Date() })
        .where(eq(timeEntries.id, prior.id));
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'time_entry',
        entityId: prior.id,
        actorAppUserId: session.appUserId,
        before: prior,
        after: { status: 'ARCHIVED' },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.post(
    '/bulk-from-template',
    requirePermission(deps, 'time_entry:create'),
    async (req: Request, res: Response) => {
      const parsed = BulkFromTemplateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true, created: 0 });
        return;
      }
      const t = parsed.data.template;
      const [eng] = await deps.db
        .select()
        .from(engagements)
        .where(eq(engagements.id, t.engagementId))
        .limit(1);
      if (!eng) {
        res.status(404).json({ error: 'engagement_not_found' });
        return;
      }
      const [client] = await deps.db
        .select()
        .from(clients)
        .where(eq(clients.id, eng.clientId))
        .limit(1);
      if (!client || client.firmId !== session.firmId) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      let serviceLineId: string | null = null;
      if (t.workCodeId) {
        const [wc] = await deps.db
          .select({ serviceLineId: workCodes.serviceLineId })
          .from(workCodes)
          .where(eq(workCodes.id, t.workCodeId))
          .limit(1);
        serviceLineId = wc?.serviceLineId ?? null;
      }
      const candidates = await loadRateCandidates(deps.db, {
        firmId: session.firmId,
        appUserId: session.appUserId,
        engagementId: eng.id,
        clientId: client.id,
        serviceLineId,
      });
      const inScope =
        eng.mixedModeEnabled && t.workCodeId ? eng.inScopeWorkCodeIds.includes(t.workCodeId) : true;
      const rows: (typeof timeEntries.$inferInsert)[] = [];
      for (const date of parsed.data.dates) {
        const resolved = resolveRate({
          serviceDate: date,
          appUserId: session.appUserId,
          engagementId: eng.id,
          clientId: client.id,
          serviceLineId,
          rateCodeId: eng.defaultRateCodeId ?? null,
          candidates,
          firmDefaultBillRateCents: 0,
        });
        if (resolved.level === 'firm' && resolved.billRateCents === 0) {
          res.status(400).json({ error: 'no_rate_resolves', forDate: date });
          return;
        }
        const snapshot = captureRateSnapshot({ rate: resolved, hours: t.hours });
        rows.push({
          engagementId: eng.id,
          appUserId: session.appUserId,
          workCodeId: t.workCodeId ?? null,
          entryDate: date,
          hours: t.hours.toString(),
          billableFlag: t.billableFlag ?? true,
          inScopeFlag: inScope,
          outOfScopeOverride: t.outOfScopeOverride ?? false,
          description: t.description ?? '',
          standardRateSnapshotCents: snapshot.rateCents,
          standardAmountCents: snapshot.amountCents,
          costRateSnapshotCents: snapshot.costRateCents,
        });
      }
      const inserted = await deps.db
        .insert(timeEntries)
        .values(rows)
        .returning({ id: timeEntries.id });
      res.status(201).json({ ok: true, created: inserted.length, ids: inserted.map((r) => r.id) });
    },
  );

  // Phase 9 #22 — per-entry approval. Manager/partner signs off on a
  // specific entry. NULL approver_id is the unapproved state; this
  // endpoint flips both approver_id and approved_at. Callers with
  // time_entry:update:any (manager+) can approve any entry; staff
  // cannot self-approve.
  router.post(
    '/:id/approve',
    requirePermission(deps, 'time_entry:update:any'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [entry] = await deps.db
        .select({ id: timeEntries.id, appUserId: timeEntries.appUserId })
        .from(timeEntries)
        .innerJoin(engagements, eq(engagements.id, timeEntries.engagementId))
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(and(eq(timeEntries.id, req.params['id']!), eq(clients.firmId, session.firmId)))
        .limit(1);
      if (!entry) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (entry.appUserId === session.appUserId) {
        res.status(409).json({ error: 'cannot_self_approve' });
        return;
      }
      const now = new Date();
      await deps.db
        .update(timeEntries)
        .set({ approverId: session.appUserId, approvedAt: now })
        .where(eq(timeEntries.id, entry.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'time_entry',
        entityId: entry.id,
        actorAppUserId: session.appUserId,
        after: { kind: 'approve', approverId: session.appUserId, approvedAt: now.toISOString() },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true, approverId: session.appUserId, approvedAt: now.toISOString() });
    },
  );

  router.post(
    '/:id/transfer',
    requirePermission(deps, 'time_entry:update:any'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const toEngagementId =
        typeof req.body?.engagementId === 'string' ? req.body.engagementId : null;
      if (!toEngagementId) {
        res.status(400).json({ error: 'engagement_id_required' });
        return;
      }
      const [prior] = await deps.db
        .select()
        .from(timeEntries)
        .where(eq(timeEntries.id, req.params['id']!))
        .limit(1);
      if (!prior) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (prior.lockedAt || prior.status === 'BILLED') {
        res.status(409).json({ error: 'locked' });
        return;
      }
      // Validate the target engagement belongs to the same firm.
      const [target] = await deps.db
        .select({ id: engagements.id, clientId: engagements.clientId })
        .from(engagements)
        .where(eq(engagements.id, toEngagementId))
        .limit(1);
      if (!target) {
        res.status(404).json({ error: 'target_engagement_not_found' });
        return;
      }
      const [targetClient] = await deps.db
        .select({ firmId: clients.firmId })
        .from(clients)
        .where(eq(clients.id, target.clientId))
        .limit(1);
      if (!targetClient || targetClient.firmId !== session.firmId) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const [maxVersion] = await deps.db
        .select({ v: timeEntryVersions.version })
        .from(timeEntryVersions)
        .where(eq(timeEntryVersions.timeEntryId, prior.id))
        .orderBy(timeEntryVersions.version)
        .limit(1);
      const nextVersion = (maxVersion?.v ?? 0) + 1;
      await deps.db.insert(timeEntryVersions).values({
        timeEntryId: prior.id,
        version: nextVersion,
        fields: prior,
        editedById: session.appUserId,
      });
      await deps.db
        .update(timeEntries)
        .set({ engagementId: toEngagementId })
        .where(eq(timeEntries.id, prior.id));
      res.json({ ok: true });
    },
  );

  // -----------------------------------------------------------------
  // Split one time entry into multiple. Each split row gets a new entry
  // with the proportional hours; the original is archived. Bookmark the
  // split intent in the version trail. Useful when a single timed block
  // covered multiple work codes or engagements.
  // -----------------------------------------------------------------
  router.post(
    '/:id/split',
    requirePermission(deps, 'time_entry:update:any'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true, created: [] });
        return;
      }
      const body = req.body as { splits?: unknown };
      if (!Array.isArray(body.splits) || body.splits.length < 2) {
        res.status(400).json({ error: 'at_least_two_splits_required' });
        return;
      }
      const splits = body.splits.filter(
        (s): s is { hours: number; description?: string; workCodeId?: string } =>
          typeof s === 'object' &&
          s !== null &&
          typeof (s as { hours?: unknown }).hours === 'number' &&
          (s as { hours: number }).hours > 0,
      );
      if (splits.length < 2) {
        res.status(400).json({ error: 'invalid_splits' });
        return;
      }
      const [prior] = await deps.db
        .select()
        .from(timeEntries)
        .where(eq(timeEntries.id, req.params['id']!))
        .limit(1);
      if (!prior) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (prior.lockedAt || prior.status === 'BILLED' || prior.status === 'LOCKED') {
        res.status(409).json({ error: 'locked' });
        return;
      }
      const totalHours = splits.reduce((a, s) => a + s.hours, 0);
      if (Math.abs(totalHours - Number(prior.hours)) > 0.001) {
        res.status(400).json({
          error: 'splits_must_sum_to_original',
          original: Number(prior.hours),
          splitTotal: totalHours,
        });
        return;
      }
      const rate = prior.standardRateSnapshotCents;
      // 0063 — split entries inherit the parent's locked cost rate.
      // Treating splits as logical re-slicing of the same hour, not as
      // fresh time entries that would re-resolve cost from current
      // snapshots.
      const costRate = prior.costRateSnapshotCents;
      const created: string[] = [];
      await deps.db.transaction(async (tx) => {
        for (const s of splits) {
          const [row] = await tx
            .insert(timeEntries)
            .values({
              engagementId: prior.engagementId,
              appUserId: prior.appUserId,
              workCodeId: s.workCodeId ?? prior.workCodeId,
              entryDate: prior.entryDate,
              hours: s.hours.toString(),
              billableFlag: prior.billableFlag,
              inScopeFlag: prior.inScopeFlag,
              description: s.description ?? prior.description,
              standardRateSnapshotCents: rate,
              standardAmountCents: Math.round(rate * s.hours),
              costRateSnapshotCents: costRate,
            })
            .returning({ id: timeEntries.id });
          if (row) created.push(row.id);
        }
        await tx
          .update(timeEntries)
          .set({ status: 'ARCHIVED' })
          .where(eq(timeEntries.id, prior.id));
        await tx.insert(timeEntryVersions).values({
          timeEntryId: prior.id,
          version: 1,
          fields: { ...prior, splitInto: created },
          editedById: session.appUserId,
        });
      });
      res.status(201).json({ ok: true, created });
    },
  );

  // -----------------------------------------------------------------
  // Bulk cost-transfer (Phase 11 #12). Move many time entries to a
  // different engagement in one call. Each entry gets a new version row
  // and audit_log entry. Locked or billed entries are skipped.
  // -----------------------------------------------------------------
  router.post(
    '/bulk-transfer',
    requirePermission(deps, 'time_entry:update:any'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true, transferred: 0, skipped: 0 });
        return;
      }
      const body = req.body as { entryIds?: unknown; toEngagementId?: unknown };
      if (
        !Array.isArray(body.entryIds) ||
        body.entryIds.length === 0 ||
        typeof body.toEngagementId !== 'string'
      ) {
        res.status(400).json({ error: 'entryIds_and_toEngagementId_required' });
        return;
      }
      const entryIds = body.entryIds.filter((x): x is string => typeof x === 'string');
      const [target] = await deps.db
        .select({ id: engagements.id, clientId: engagements.clientId })
        .from(engagements)
        .where(eq(engagements.id, body.toEngagementId))
        .limit(1);
      if (!target) {
        res.status(404).json({ error: 'target_engagement_not_found' });
        return;
      }
      const [targetClient] = await deps.db
        .select({ firmId: clients.firmId })
        .from(clients)
        .where(eq(clients.id, target.clientId))
        .limit(1);
      if (!targetClient || targetClient.firmId !== session.firmId) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const priors = await deps.db
        .select()
        .from(timeEntries)
        .where(inArray(timeEntries.id, entryIds));
      let transferred = 0;
      let skipped = 0;
      for (const prior of priors) {
        if (prior.lockedAt || prior.status === 'BILLED' || prior.status === 'LOCKED') {
          skipped++;
          continue;
        }
        const [maxVersion] = await deps.db
          .select({ v: timeEntryVersions.version })
          .from(timeEntryVersions)
          .where(eq(timeEntryVersions.timeEntryId, prior.id))
          .orderBy(desc(timeEntryVersions.version))
          .limit(1);
        const nextVersion = (maxVersion?.v ?? 0) + 1;
        await deps.db.insert(timeEntryVersions).values({
          timeEntryId: prior.id,
          version: nextVersion,
          fields: prior,
          editedById: session.appUserId,
        });
        await deps.db
          .update(timeEntries)
          .set({ engagementId: body.toEngagementId })
          .where(eq(timeEntries.id, prior.id));
        transferred++;
      }
      res.json({ ok: true, transferred, skipped });
    },
  );

  router.delete(
    '/:id',
    requirePermission(deps, 'time_entry:update:own'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [prior] = await deps.db
        .select()
        .from(timeEntries)
        .where(eq(timeEntries.id, req.params['id']!))
        .limit(1);
      if (!prior) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (prior.appUserId !== session.appUserId) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      if (prior.lockedAt || prior.status === 'BILLED' || prior.status === 'LOCKED') {
        res.status(409).json({ error: 'locked' });
        return;
      }
      const [maxVersion] = await deps.db
        .select({ v: timeEntryVersions.version })
        .from(timeEntryVersions)
        .where(eq(timeEntryVersions.timeEntryId, prior.id))
        .orderBy(timeEntryVersions.version)
        .limit(1);
      const nextVersion = (maxVersion?.v ?? 0) + 1;
      await deps.db.insert(timeEntryVersions).values({
        timeEntryId: prior.id,
        version: nextVersion,
        fields: prior,
        editedById: session.appUserId,
      });
      await deps.db
        .update(timeEntries)
        .set({ status: 'ARCHIVED' })
        .where(eq(timeEntries.id, prior.id));
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/write-off',
    requirePermission(deps, 'time_entry:update:any'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      await deps.db
        .update(timeEntries)
        .set({ status: 'WRITTEN_OFF' })
        .where(eq(timeEntries.id, req.params['id']!));
      res.json({ ok: true });
    },
  );

  router.get(
    '/by-status/:status',
    requirePermission(deps, 'time_entry:read:all'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const status = req.params['status']!;
      const allowed = ['DRAFT', 'SUBMITTED', 'LOCKED', 'BILLED', 'WRITTEN_OFF', 'ARCHIVED'];
      if (!allowed.includes(status)) {
        res.status(400).json({ error: 'invalid_status' });
        return;
      }
      // Scope to firm via engagement->client join.
      const firmClients = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.firmId, session.firmId));
      const firmClientIds = firmClients.map((c) => c.id);
      if (firmClientIds.length === 0) {
        res.json({ items: [] });
        return;
      }
      const firmEngs = await deps.db
        .select({ id: engagements.id })
        .from(engagements)
        .where(inArray(engagements.clientId, firmClientIds));
      const engIds = firmEngs.map((e) => e.id);
      if (engIds.length === 0) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select()
        .from(timeEntries)
        .where(
          and(
            inArray(timeEntries.engagementId, engIds),
            eq(
              timeEntries.status,
              status as 'DRAFT' | 'SUBMITTED' | 'LOCKED' | 'BILLED' | 'WRITTEN_OFF' | 'ARCHIVED',
            ),
          ),
        )
        .limit(1000);
      res.json({ items });
    },
  );

  router.get(
    '/count-by-status',
    requirePermission(deps, 'time_entry:read:all'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ counts: {} });
        return;
      }
      const firmClientIds = (
        await deps.db
          .select({ id: clients.id })
          .from(clients)
          .where(eq(clients.firmId, session.firmId))
      ).map((c) => c.id);
      if (firmClientIds.length === 0) {
        res.json({ counts: {} });
        return;
      }
      const firmEngs = await deps.db
        .select({ id: engagements.id })
        .from(engagements)
        .where(inArray(engagements.clientId, firmClientIds));
      const engIds = firmEngs.map((e) => e.id);
      if (engIds.length === 0) {
        res.json({ counts: {} });
        return;
      }
      const rows = await deps.db
        .select({ status: timeEntries.status, c: sql<number>`COUNT(*)`.as('c') })
        .from(timeEntries)
        .where(inArray(timeEntries.engagementId, engIds))
        .groupBy(timeEntries.status);
      const counts: Record<string, number> = {};
      for (const r of rows) counts[r.status] = Number(r.c);
      res.json({ counts });
    },
  );

  router.post(
    '/bulk-status',
    requirePermission(deps, 'time_entry:update:any'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.json({ ok: true, updated: 0 });
        return;
      }
      const ids = Array.isArray(req.body?.ids)
        ? req.body.ids.filter((x: unknown): x is string => typeof x === 'string')
        : [];
      const status = typeof req.body?.status === 'string' ? req.body.status : null;
      const allowed = ['DRAFT', 'SUBMITTED', 'LOCKED', 'BILLED', 'WRITTEN_OFF', 'ARCHIVED'];
      if (ids.length === 0 || !status || !allowed.includes(status)) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const patch: Record<string, unknown> = {
        status: status as 'DRAFT' | 'SUBMITTED' | 'LOCKED' | 'BILLED' | 'WRITTEN_OFF' | 'ARCHIVED',
      };
      if (status === 'LOCKED') patch['lockedAt'] = new Date();
      const updated = await deps.db
        .update(timeEntries)
        .set(patch)
        .where(inArray(timeEntries.id, ids))
        .returning({ id: timeEntries.id });
      res.json({ ok: true, updated: updated.length });
    },
  );

  router.post(
    '/timer/start',
    requirePermission(deps, 'time_entry:create'),
    async (req: Request, res: Response) => {
      const parsed = TimerStartSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.redis) {
        res.status(503).json({ error: 'no_redis' });
        return;
      }
      const existing = await deps.redis.get(timerKey(session.appUserId));
      if (existing) {
        res.status(409).json({ error: 'timer_already_running', state: JSON.parse(existing) });
        return;
      }
      const state = {
        engagementId: parsed.data.engagementId,
        workCodeId: parsed.data.workCodeId ?? null,
        description: parsed.data.description ?? '',
        startedAt: new Date().toISOString(),
      };
      // 24h TTL guards against orphaned timers.
      await deps.redis.set(timerKey(session.appUserId), JSON.stringify(state), 'EX', 24 * 3600);
      res.status(201).json({ ok: true, state });
    },
  );

  router.get(
    '/timer/status',
    requirePermission(deps, 'time_entry:read:own'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.redis) {
        res.json({ running: false });
        return;
      }
      const v = await deps.redis.get(timerKey(session.appUserId));
      if (!v) {
        res.json({ running: false });
        return;
      }
      const state = JSON.parse(v) as {
        startedAt: string;
        engagementId: string;
        lastHeartbeatAt?: string;
      };
      const elapsedMs = Date.now() - Date.parse(state.startedAt);
      // Idle detection (Phase 9 #5): if no heartbeat in the last 15 min,
      // flag the timer as idle so the UI can prompt the user.
      const idleThresholdMs = 15 * 60_000;
      const lastHeartbeat = state.lastHeartbeatAt
        ? Date.parse(state.lastHeartbeatAt)
        : Date.parse(state.startedAt);
      const idleMs = Date.now() - lastHeartbeat;
      res.json({
        running: true,
        state,
        elapsedMs,
        idle: idleMs > idleThresholdMs,
        idleMs,
        idleThresholdMs,
      });
    },
  );

  // Heartbeat — frontend posts this every minute while the timer is
  // visible so the server knows the user is still active.
  router.post(
    '/timer/heartbeat',
    requirePermission(deps, 'time_entry:read:own'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.redis) {
        res.json({ ok: true });
        return;
      }
      const v = await deps.redis.get(timerKey(session.appUserId));
      if (!v) {
        res.status(404).json({ error: 'no_timer' });
        return;
      }
      const state = JSON.parse(v) as Record<string, unknown>;
      state['lastHeartbeatAt'] = new Date().toISOString();
      await deps.redis.set(timerKey(session.appUserId), JSON.stringify(state), 'EX', 6 * 3600);
      res.json({ ok: true });
    },
  );

  router.post(
    '/timer/stop',
    requirePermission(deps, 'time_entry:create'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.redis) {
        res.status(503).json({ error: 'no_redis' });
        return;
      }
      const v = await deps.redis.get(timerKey(session.appUserId));
      if (!v) {
        res.status(404).json({ error: 'no_timer_running' });
        return;
      }
      const state = JSON.parse(v) as {
        engagementId: string;
        workCodeId: string | null;
        description: string;
        startedAt: string;
      };
      const elapsedMs = Date.now() - Date.parse(state.startedAt);
      const elapsedHours = elapsedMs / 3_600_000;
      // Round to 0.25h per Q19 default.
      const rounded = Math.max(0.25, Math.round(elapsedHours / 0.25) * 0.25);
      await deps.redis.del(timerKey(session.appUserId));
      res.json({
        ok: true,
        engagementId: state.engagementId,
        workCodeId: state.workCodeId,
        description: state.description,
        elapsedHours: rounded,
        startedAt: state.startedAt,
      });
    },
  );

  router.get(
    '/totals/firm/by-user',
    requirePermission(deps, 'time_entry:read:all'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const start = (req.query['start'] ?? '').toString();
      const end = (req.query['end'] ?? '').toString();
      const conds = [];
      if (/^\d{4}-\d{2}-\d{2}$/.test(start)) conds.push(gte(timeEntries.entryDate, start));
      if (/^\d{4}-\d{2}-\d{2}$/.test(end)) conds.push(lte(timeEntries.entryDate, end));
      // Scope to firm via app_user join.
      const userIds = (
        await deps.db.select({ id: firms.id }).from(firms).where(eq(firms.id, session.firmId))
      ).length
        ? (
            await deps.db
              .select({ id: sql<string>`app_user.id`.as('id') })
              .from(sql`app_user`)
              .where(sql`app_user.firm_id = ${session.firmId}`)
          ).map((r) => r.id as string)
        : [];
      if (userIds.length === 0) {
        res.json({ items: [] });
        return;
      }
      const allConds = [...conds, inArray(timeEntries.appUserId, userIds)];
      const rows = await deps.db
        .select({
          appUserId: timeEntries.appUserId,
          hours: sql<string>`SUM(${timeEntries.hours})`.as('hours'),
          amountCents: sql<number>`COALESCE(SUM(${timeEntries.standardAmountCents}), 0)`.as(
            'amountCents',
          ),
        })
        .from(timeEntries)
        .where(and(...allConds))
        .groupBy(timeEntries.appUserId);
      res.json({
        items: rows.map((r) => ({
          appUserId: r.appUserId,
          hours: Number(r.hours),
          amountCents: Number(r.amountCents),
        })),
      });
    },
  );

  router.get(
    '/totals/by-day',
    requirePermission(deps, 'time_entry:read:own'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const start = (req.query['start'] ?? '').toString();
      const end = (req.query['end'] ?? '').toString();
      const conds = [eq(timeEntries.appUserId, session.appUserId)];
      if (/^\d{4}-\d{2}-\d{2}$/.test(start)) conds.push(gte(timeEntries.entryDate, start));
      if (/^\d{4}-\d{2}-\d{2}$/.test(end)) conds.push(lte(timeEntries.entryDate, end));
      const rows = await deps.db
        .select({
          entryDate: timeEntries.entryDate,
          hours: sql<string>`SUM(${timeEntries.hours})`.as('hours'),
          amountCents: sql<number>`COALESCE(SUM(${timeEntries.standardAmountCents}), 0)`.as(
            'amountCents',
          ),
        })
        .from(timeEntries)
        .where(and(...conds))
        .groupBy(timeEntries.entryDate)
        .orderBy(timeEntries.entryDate);
      res.json({
        items: rows.map((r) => ({
          entryDate: r.entryDate,
          hours: Number(r.hours),
          amountCents: Number(r.amountCents),
        })),
      });
    },
  );

  router.get(
    '/totals/by-week',
    requirePermission(deps, 'time_entry:read:own'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const start = (req.query['start'] ?? '').toString();
      const end = (req.query['end'] ?? '').toString();
      const conds = [eq(timeEntries.appUserId, session.appUserId)];
      if (/^\d{4}-\d{2}-\d{2}$/.test(start)) conds.push(gte(timeEntries.entryDate, start));
      if (/^\d{4}-\d{2}-\d{2}$/.test(end)) conds.push(lte(timeEntries.entryDate, end));
      const weekStart = sql<string>`to_char(date_trunc('week', ${timeEntries.entryDate})::date, 'YYYY-MM-DD')`;
      const rows = await deps.db
        .select({
          weekStart: weekStart.as('weekStart'),
          hours: sql<string>`SUM(${timeEntries.hours})`.as('hours'),
          amountCents: sql<number>`COALESCE(SUM(${timeEntries.standardAmountCents}), 0)`.as(
            'amountCents',
          ),
        })
        .from(timeEntries)
        .where(and(...conds))
        .groupBy(weekStart)
        .orderBy(weekStart);
      res.json({
        items: rows.map((r) => ({
          weekStart: r.weekStart,
          hours: Number(r.hours),
          amountCents: Number(r.amountCents),
        })),
      });
    },
  );

  router.get(
    '/totals/by-month',
    requirePermission(deps, 'time_entry:read:own'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const monthsBack = Math.min(
        Math.max(parseInt(String(req.query['monthsBack'] ?? '12'), 10) || 12, 1),
        36,
      );
      const since = new Date();
      since.setUTCMonth(since.getUTCMonth() - monthsBack);
      since.setUTCDate(1);
      const sinceStr = since.toISOString().slice(0, 10);
      const monthCol = sql<string>`to_char(date_trunc('month', ${timeEntries.entryDate})::date, 'YYYY-MM')`;
      const rows = await deps.db
        .select({
          month: monthCol.as('month'),
          hours: sql<string>`SUM(${timeEntries.hours})`.as('hours'),
          amountCents: sql<number>`COALESCE(SUM(${timeEntries.standardAmountCents}), 0)`.as(
            'amountCents',
          ),
          count: sql<number>`COUNT(*)`.as('count'),
        })
        .from(timeEntries)
        .where(
          and(eq(timeEntries.appUserId, session.appUserId), gte(timeEntries.entryDate, sinceStr)),
        )
        .groupBy(monthCol)
        .orderBy(monthCol);
      res.json({
        items: rows.map((r) => ({
          month: r.month,
          hours: Number(r.hours),
          amountCents: Number(r.amountCents),
          count: Number(r.count),
        })),
      });
    },
  );

  return router;
}
