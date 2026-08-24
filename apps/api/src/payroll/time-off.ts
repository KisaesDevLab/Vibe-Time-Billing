// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Time-off requests (0226). Staff request PTO/Sick/Comp/Unpaid days;
// approvers (time_off:approve) approve or deny. Approval creates one
// ordinary time entry per day through createTimeEntryCore on the 0208
// firm-admin engagement with the kind's seeded work code — so approved
// time off appears on the Time page, deducts from the bank via the
// derived-usage model, and respects the payroll lock. Direct logging of
// the same work codes (same-day sick) works without a request.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  accrualPolicies,
  accrualPolicyAssignments,
  appUsers,
  clients,
  engagements,
  roles,
  staffNotifications,
  timeEntries,
  timeOffRequestDays,
  timeOffRequests,
  userRoles,
  workCodes,
} from '@vibe/db/schema';
import { checkOverdraw, round2, usageAllowed, type TimeOffBank } from '@vibe/core/payroll';

import { emitAudit } from '../auth/audit';
import { requirePermission, userHasPermission } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';
import { createTimeEntryCore, type TimeEntryRoutesDeps } from '../time-entries/routes';
import { loadUserBankBalance } from './balances';

export type TimeOffRoutesDeps = TimeEntryRoutesDeps;

const KIND_WORK_CODE_KEY: Record<string, string> = {
  PTO: 'pto',
  SICK: 'sick_leave',
  COMP: 'comp_time_used',
  UNPAID: 'unpaid_leave',
};

/** Banks a request kind spends; UNPAID has no balance. */
const KIND_BANK: Record<string, TimeOffBank | null> = {
  PTO: 'PTO',
  SICK: 'SICK',
  COMP: 'COMP',
  UNPAID: null,
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const CreateRequestSchema = z
  .object({
    kind: z.enum(['PTO', 'SICK', 'COMP', 'UNPAID']),
    startDate: z.string().regex(DATE_RE),
    endDate: z.string().regex(DATE_RE),
    note: z.string().max(400).optional(),
    days: z
      .array(
        z.object({
          day: z.string().regex(DATE_RE),
          hours: z.number().positive().max(24),
        }),
      )
      .max(62)
      .optional(),
  })
  .refine((d) => d.endDate >= d.startDate, { message: 'range' });

function clientIp(req: Request): string {
  return (req.headers?.['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}

/** Default day rows: each weekday in range at standardHoursPerWeek / 5. */
export function defaultDayRows(
  startDate: string,
  endDate: string,
  standardHoursPerWeek: number,
): Array<{ day: string; hours: number }> {
  const out: Array<{ day: string; hours: number }> = [];
  const perDay = round2(standardHoursPerWeek / 5) || 8;
  let t = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  for (; t <= end; t += 86_400_000) {
    const d = new Date(t);
    const dow = d.getUTCDay();
    if (dow >= 1 && dow <= 5) out.push({ day: d.toISOString().slice(0, 10), hours: perDay });
  }
  return out;
}

async function notifyUsers(
  db: Database,
  args: {
    firmId: string;
    recipients: string[];
    type: string;
    entityId: string;
    title: string;
    body: string;
    actionUrl: string;
  },
): Promise<void> {
  if (args.recipients.length === 0) return;
  try {
    await db.insert(staffNotifications).values(
      args.recipients.map((rid) => ({
        firmId: args.firmId,
        recipientAppUserId: rid,
        type: args.type,
        entityType: 'time_off_request',
        entityId: args.entityId,
        title: args.title,
        body: args.body,
        actionUrl: args.actionUrl,
      })),
    );
  } catch (err) {
    logger.warn({ err }, 'time-off notification insert failed');
  }
}

/** Users holding a role whose template includes time_off:approve. */
async function loadApproverIds(db: Database, firmId: string): Promise<string[]> {
  const rows = await db
    .select({ appUserId: userRoles.appUserId })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(
      and(
        eq(roles.firmId, firmId),
        inArray(sql`lower(${roles.name})`, ['partner', 'manager', 'admin']),
      ),
    );
  return [...new Set(rows.map((r) => r.appUserId))];
}

export function createTimeOffRouter(deps: TimeOffRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.post(
    '/requests',
    requirePermission(deps, 'time_off:request:own'),
    async (req: Request, res: Response) => {
      const parsed = CreateRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const [me] = await deps.db
        .select({ standardHoursPerWeek: appUsers.standardHoursPerWeek })
        .from(appUsers)
        .where(eq(appUsers.id, session.appUserId))
        .limit(1);
      let days = parsed.data.days;
      if (!days || days.length === 0) {
        days = defaultDayRows(
          parsed.data.startDate,
          parsed.data.endDate,
          Number(me?.standardHoursPerWeek ?? 40),
        );
      }
      days = days.filter((d) => d.day >= parsed.data.startDate && d.day <= parsed.data.endDate);
      if (days.length === 0) {
        res.status(400).json({ error: 'no_days' });
        return;
      }
      const totalHours = round2(days.reduce((s, d) => s + d.hours, 0));

      const requestId = await deps.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(timeOffRequests)
          .values({
            firmId: session.firmId,
            appUserId: session.appUserId,
            kind: parsed.data.kind,
            startDate: parsed.data.startDate,
            endDate: parsed.data.endDate,
            totalHours: totalHours.toString(),
            note: parsed.data.note ?? '',
          })
          .returning({ id: timeOffRequests.id });
        await tx.insert(timeOffRequestDays).values(
          days.map((d) => ({
            requestId: row!.id,
            day: d.day,
            hours: d.hours.toString(),
          })),
        );
        return row!.id;
      });

      // Projected-balance warning for banked kinds (never blocks).
      let warning: string | undefined;
      const bank = KIND_BANK[parsed.data.kind];
      if (bank) {
        const bal = await loadUserBankBalance(deps.db, session.firmId, session.appUserId, bank);
        warning = checkOverdraw(bank, round2(bal.balanceHours - totalHours)).warning;
      }

      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'time_off_request',
        entityId: requestId,
        actorAppUserId: session.appUserId,
        after: { ...parsed.data, totalHours },
        ip: clientIp(req),
        userAgent: req.headers['user-agent'] ?? null,
      });

      const approvers = (await loadApproverIds(deps.db, session.firmId)).filter(
        (id) => id !== session.appUserId,
      );
      const [requester] = await deps.db
        .select({ fullName: appUsers.fullName })
        .from(appUsers)
        .where(eq(appUsers.id, session.appUserId))
        .limit(1);
      await notifyUsers(deps.db, {
        firmId: session.firmId,
        recipients: approvers,
        type: 'time_off_request',
        entityId: requestId,
        title: `Time-off request: ${requester?.fullName ?? 'Staff'}`,
        body: `${parsed.data.kind} · ${parsed.data.startDate} → ${parsed.data.endDate} · ${totalHours}h`,
        actionUrl: '/time-off',
      });

      res.status(201).json({ id: requestId, totalHours, warning });
    },
  );

  router.get(
    '/requests',
    requirePermission(deps, 'time_off:request:own'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const scope = typeof req.query['scope'] === 'string' ? req.query['scope'] : 'mine';
      const conds = [eq(timeOffRequests.firmId, session.firmId)];
      if (scope === 'mine') {
        conds.push(eq(timeOffRequests.appUserId, session.appUserId));
      } else {
        // pending / all — approver views.
        if (!(await userHasPermission(deps, session.appUserId, 'time_off:approve'))) {
          res.status(403).json({ error: 'forbidden' });
          return;
        }
        if (scope === 'pending') conds.push(eq(timeOffRequests.status, 'PENDING'));
      }
      const items = await deps.db
        .select({
          id: timeOffRequests.id,
          appUserId: timeOffRequests.appUserId,
          fullName: appUsers.fullName,
          kind: timeOffRequests.kind,
          startDate: timeOffRequests.startDate,
          endDate: timeOffRequests.endDate,
          totalHours: timeOffRequests.totalHours,
          status: timeOffRequests.status,
          note: timeOffRequests.note,
          decisionNote: timeOffRequests.decisionNote,
          decidedAt: timeOffRequests.decidedAt,
          createdAt: timeOffRequests.createdAt,
        })
        .from(timeOffRequests)
        .innerJoin(appUsers, eq(appUsers.id, timeOffRequests.appUserId))
        .where(and(...conds))
        .orderBy(desc(timeOffRequests.createdAt))
        .limit(100);
      const days = items.length
        ? await deps.db
            .select()
            .from(timeOffRequestDays)
            .where(
              inArray(
                timeOffRequestDays.requestId,
                items.map((i) => i.id),
              ),
            )
            .orderBy(timeOffRequestDays.day)
        : [];
      res.json({
        items: items.map((i) => ({ ...i, days: days.filter((d) => d.requestId === i.id) })),
      });
    },
  );

  router.post(
    '/requests/:id/cancel',
    requirePermission(deps, 'time_off:request:own'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [prior] = await deps.db
        .select()
        .from(timeOffRequests)
        .where(
          and(
            eq(timeOffRequests.id, req.params['id']!),
            eq(timeOffRequests.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!prior || prior.appUserId !== session.appUserId) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (prior.status !== 'PENDING') {
        res.status(409).json({ error: 'not_pending', status: prior.status });
        return;
      }
      await deps.db
        .update(timeOffRequests)
        .set({ status: 'CANCELLED', updatedAt: new Date() })
        .where(eq(timeOffRequests.id, prior.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'time_off_request',
        entityId: prior.id,
        actorAppUserId: session.appUserId,
        before: { status: prior.status },
        after: { status: 'CANCELLED' },
        ip: clientIp(req),
        userAgent: req.headers['user-agent'] ?? null,
      });
      res.json({ ok: true });
    },
  );

  router.post(
    '/requests/:id/approve',
    requirePermission(deps, 'time_off:approve'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [request] = await deps.db
        .select()
        .from(timeOffRequests)
        .where(
          and(
            eq(timeOffRequests.id, req.params['id']!),
            eq(timeOffRequests.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!request) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (request.appUserId === session.appUserId) {
        res.status(409).json({ error: 'cannot_self_approve' });
        return;
      }
      if (request.status !== 'PENDING') {
        res.status(409).json({ error: 'not_pending', status: request.status });
        return;
      }

      // Usage waiting period (bank policy) — hard stop at approval.
      const bank = KIND_BANK[request.kind];
      if (bank) {
        const [assignment] = await deps.db
          .select({
            usageWaitingDays: accrualPolicies.usageWaitingDays,
          })
          .from(accrualPolicyAssignments)
          .innerJoin(accrualPolicies, eq(accrualPolicies.id, accrualPolicyAssignments.policyId))
          .where(
            and(
              eq(accrualPolicyAssignments.appUserId, request.appUserId),
              eq(accrualPolicyAssignments.bank, bank),
              sql`${accrualPolicyAssignments.endDate} IS NULL`,
            ),
          )
          .limit(1);
        if (assignment) {
          const [target] = await deps.db
            .select({ hiredDate: appUsers.hiredDate })
            .from(appUsers)
            .where(eq(appUsers.id, request.appUserId))
            .limit(1);
          if (
            !usageAllowed(
              { usageWaitingDays: assignment.usageWaitingDays },
              target?.hiredDate ?? null,
              request.startDate,
            )
          ) {
            res.status(409).json({ error: 'usage_waiting_period' });
            return;
          }
        }
      }

      // The firm-admin engagement + the kind's seeded work code.
      const [adminEng] = await deps.db
        .select({ id: engagements.id })
        .from(engagements)
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(and(eq(clients.firmId, session.firmId), eq(engagements.firmAdmin, true)))
        .limit(1);
      if (!adminEng) {
        res.status(409).json({ error: 'firm_admin_engagement_missing' });
        return;
      }
      const [wc] = await deps.db
        .select({ id: workCodes.id })
        .from(workCodes)
        .where(
          and(
            eq(workCodes.firmId, session.firmId),
            eq(workCodes.key, KIND_WORK_CODE_KEY[request.kind]!),
          ),
        )
        .limit(1);
      if (!wc) {
        res.status(409).json({ error: 'payroll_work_code_missing', kind: request.kind });
        return;
      }

      const days = await deps.db
        .select()
        .from(timeOffRequestDays)
        .where(eq(timeOffRequestDays.requestId, request.id))
        .orderBy(timeOffRequestDays.day);

      // Create the entries AS the requester through the standard write
      // path (rate snapshot, payroll lock, firm-admin non-billable guard
      // all apply). A failure on any day aborts before the status flips
      // and archives this attempt's entries so the request stays
      // re-approvable without duplicates.
      const requesterSession = { ...session, appUserId: request.appUserId };
      const created: Array<{ dayId: string; timeEntryId: string }> = [];
      for (const d of days) {
        const result = await createTimeEntryCore(deps, {
          session: requesterSession,
          payload: {
            engagementId: adminEng.id,
            workCodeId: wc.id,
            entryDate: d.day,
            hours: Number(d.hours),
            billableFlag: false,
            description: `${request.kind} (approved request)`,
          },
          ip: clientIp(req),
          userAgent: req.headers['user-agent'] ?? null,
        });
        const entryId = typeof result.body['id'] === 'string' ? result.body['id'] : null;
        if (result.status !== 201 || !entryId) {
          if (created.length > 0) {
            await deps.db
              .update(timeEntries)
              .set({ status: 'ARCHIVED', updatedAt: new Date() })
              .where(
                inArray(
                  timeEntries.id,
                  created.map((c) => c.timeEntryId),
                ),
              )
              .catch((err: unknown) =>
                logger.error({ err, requestId: request.id }, 'approval rollback archive failed'),
              );
          }
          res.status(409).json({
            error: 'entry_create_failed',
            day: d.day,
            detail: result.body['error'] ?? null,
          });
          return;
        }
        created.push({ dayId: d.id, timeEntryId: entryId });
      }

      await deps.db.transaction(async (tx) => {
        for (const c of created) {
          await tx
            .update(timeOffRequestDays)
            .set({ timeEntryId: c.timeEntryId })
            .where(eq(timeOffRequestDays.id, c.dayId));
        }
        await tx
          .update(timeOffRequests)
          .set({
            status: 'APPROVED',
            approverAppUserId: session.appUserId,
            decidedAt: new Date(),
            decisionNote: typeof req.body?.note === 'string' ? req.body.note.slice(0, 400) : '',
            updatedAt: new Date(),
          })
          .where(eq(timeOffRequests.id, request.id));
      });

      let warning: string | undefined;
      if (bank) {
        const bal = await loadUserBankBalance(deps.db, session.firmId, request.appUserId, bank);
        warning = checkOverdraw(bank, bal.balanceHours).warning;
      }

      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'time_off_request',
        entityId: request.id,
        actorAppUserId: session.appUserId,
        before: { status: 'PENDING' },
        after: { status: 'APPROVED', entries: created.length },
        ip: clientIp(req),
        userAgent: req.headers['user-agent'] ?? null,
      });
      await notifyUsers(deps.db, {
        firmId: session.firmId,
        recipients: [request.appUserId],
        type: 'time_off_decision',
        entityId: request.id,
        title: 'Time-off request approved',
        body: `${request.kind} · ${request.startDate} → ${request.endDate}`,
        actionUrl: '/time-off',
      });
      res.json({ ok: true, entriesCreated: created.length, warning });
    },
  );

  router.post(
    '/requests/:id/deny',
    requirePermission(deps, 'time_off:approve'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [request] = await deps.db
        .select()
        .from(timeOffRequests)
        .where(
          and(
            eq(timeOffRequests.id, req.params['id']!),
            eq(timeOffRequests.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!request) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (request.status !== 'PENDING') {
        res.status(409).json({ error: 'not_pending', status: request.status });
        return;
      }
      await deps.db
        .update(timeOffRequests)
        .set({
          status: 'DENIED',
          approverAppUserId: session.appUserId,
          decidedAt: new Date(),
          decisionNote: typeof req.body?.note === 'string' ? req.body.note.slice(0, 400) : '',
          updatedAt: new Date(),
        })
        .where(eq(timeOffRequests.id, request.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'time_off_request',
        entityId: request.id,
        actorAppUserId: session.appUserId,
        before: { status: 'PENDING' },
        after: { status: 'DENIED' },
        ip: clientIp(req),
        userAgent: req.headers['user-agent'] ?? null,
      });
      await notifyUsers(deps.db, {
        firmId: session.firmId,
        recipients: [request.appUserId],
        type: 'time_off_decision',
        entityId: request.id,
        title: 'Time-off request denied',
        body: `${request.kind} · ${request.startDate} → ${request.endDate}`,
        actionUrl: '/time-off',
      });
      res.json({ ok: true });
    },
  );

  return router;
}
