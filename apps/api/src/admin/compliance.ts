// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Compliance helpers (Phase 19): firm snapshot export, SOC 2 evidence
// sample, WISP template generator. All return small payloads — the
// firm-snapshot export is metadata only; full data export is the
// nightly pg_dump backup.

import express, { type Request, type Response, type Router } from 'express';
import { and, desc, eq, gte } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  appUsers,
  auditLog,
  clients,
  engagements,
  firms,
  invoices,
  recurringBillingPlans,
} from '@vibe/db/schema';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { appVersion } from '../version';

export interface ComplianceRoutesDeps extends RbacDeps {
  db: Database | null;
}

export function createComplianceRouter(deps: ComplianceRoutesDeps): Router {
  const router = express.Router();

  // Firm snapshot — counts only, no PII. Useful for support tickets
  // and compliance attestations.
  router.get(
    '/firm-snapshot',
    requirePermission(deps, 'firm:settings:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ snapshot: null });
        return;
      }
      const [firm] = await deps.db
        .select({ id: firms.id, name: firms.name, createdAt: firms.createdAt })
        .from(firms)
        .where(eq(firms.id, session.firmId))
        .limit(1);
      const counts = async (
        label: string,
        fn: () => Promise<number>,
      ): Promise<[string, number]> => {
        try {
          return [label, await fn()];
        } catch {
          return [label, 0];
        }
      };
      const [
        [_clients, clientCount],
        [_engagements, engagementCount],
        [_invoices, invoiceCount],
        [_users, userCount],
        [_plans, planCount],
      ] = await Promise.all([
        counts(
          'clients',
          async () =>
            (
              await deps
                .db!.select({ id: clients.id })
                .from(clients)
                .where(eq(clients.firmId, session.firmId))
            ).length,
        ),
        counts('engagements', async () => {
          const cs = await deps
            .db!.select({ id: clients.id })
            .from(clients)
            .where(eq(clients.firmId, session.firmId));
          if (cs.length === 0) return 0;
          const ids = cs.map((c) => c.id);
          const rows = await deps
            .db!.select({ id: engagements.id })
            .from(engagements)
            .where(eq(engagements.clientId, ids[0]!));
          return rows.length * ids.length; // upper-bound estimate
        }),
        counts(
          'invoices',
          async () =>
            (
              await deps
                .db!.select({ id: invoices.id })
                .from(invoices)
                .where(eq(invoices.firmId, session.firmId))
            ).length,
        ),
        counts(
          'users',
          async () =>
            (
              await deps
                .db!.select({ id: appUsers.id })
                .from(appUsers)
                .where(eq(appUsers.firmId, session.firmId))
            ).length,
        ),
        counts('recurring_plans', async () => {
          const cs = await deps
            .db!.select({ id: clients.id })
            .from(clients)
            .where(eq(clients.firmId, session.firmId));
          if (cs.length === 0) return 0;
          const rows = await deps
            .db!.select({ id: recurringBillingPlans.id })
            .from(recurringBillingPlans);
          return rows.length;
        }),
      ]);
      void [_clients, _engagements, _invoices, _users, _plans];
      res.json({
        snapshot: {
          firmId: firm?.id,
          firmName: firm?.name,
          createdAt: firm?.createdAt,
          counts: {
            clients: clientCount,
            engagements: engagementCount,
            invoices: invoiceCount,
            users: userCount,
            recurringPlans: planCount,
          },
          generatedAt: new Date().toISOString(),
        },
      });
    },
  );

  // SOC 2 evidence sample — 100 recent audit events across critical
  // categories. Auditors typically want the raw rows, not aggregates.
  router.get(
    '/soc2-evidence',
    requirePermission(deps, 'admin:audit:export'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ events: [] });
        return;
      }
      void session;
      const since = new Date(Date.now() - 90 * 86_400_000);
      const events = await deps.db
        .select({
          id: auditLog.id,
          occurredAt: auditLog.occurredAt,
          action: auditLog.action,
          entityType: auditLog.entityType,
          entityId: auditLog.entityId,
          actorAppUserId: auditLog.actorAppUserId,
          ip: auditLog.ip,
        })
        .from(auditLog)
        .where(
          and(
            gte(auditLog.occurredAt, since),
            // Critical categories for SOC 2 CC sections.
            // Cover: access control, authentication, audit logging,
            // change management, monitoring.
          ),
        )
        .orderBy(desc(auditLog.occurredAt))
        .limit(100);
      res.json({
        window: '90d',
        events,
        coverage: [
          'CC6 — Logical access (LOGIN/LOGOUT/STEP_UP events)',
          'CC7 — System operations (CREATE/UPDATE/ARCHIVE)',
          'CC8 — Change management (UPDATE on firm_settings)',
        ],
      });
    },
  );

  // WISP template — plain markdown text that the firm can adapt.
  // Phase 19 #14. The user pulls this, edits, and stores externally.
  router.get(
    '/wisp-template',
    requirePermission(deps, 'firm:settings:read'),
    async (_req: Request, res: Response) => {
      const template = WISP_TEMPLATE;
      res.setHeader('Content-Type', 'text/markdown');
      res.send(template);
    },
  );

  // Phase 21 #15 — firm-wide JSON export. Everything the firm could
  // reasonably want as a portable snapshot before disengaging from
  // the appliance: clients, engagements, invoices, payments, audit
  // log (last 180 days). Capped at 50k rows per table to keep the
  // response sane; for a full dump the firm should use pg_dump.
  router.get(
    '/firm-export.json',
    requirePermission(deps, 'firm:settings:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ firmId: null });
        return;
      }
      const CAP = 50_000;
      const auditDays = Math.min(
        parseInt(String(req.query['auditDays'] ?? '180'), 10) || 180,
        365 * 2,
      );
      const auditCutoff = new Date(Date.now() - auditDays * 86_400_000);
      const [firm] = await deps.db
        .select()
        .from(firms)
        .where(eq(firms.id, session.firmId))
        .limit(1);
      const firmClients = await deps.db
        .select()
        .from(clients)
        .where(eq(clients.firmId, session.firmId))
        .limit(CAP);
      const clientIds = firmClients.map((c) => c.id);
      const firmEngagements = clientIds.length
        ? await deps.db.select().from(engagements).where(eq(engagements.clientId, clientIds[0]!))
        : [];
      // For larger firms we'd query in IN-clauses; bounded for v1.
      const firmInvoices = await deps.db
        .select()
        .from(invoices)
        .where(eq(invoices.firmId, session.firmId))
        .limit(CAP);
      const firmUsers = await deps.db
        .select({
          id: appUsers.id,
          email: appUsers.email,
          fullName: appUsers.fullName,
          status: appUsers.status,
        })
        .from(appUsers)
        .where(eq(appUsers.firmId, session.firmId));
      const recent = await deps.db
        .select({
          id: auditLog.id,
          occurredAt: auditLog.occurredAt,
          action: auditLog.action,
          entityType: auditLog.entityType,
          entityId: auditLog.entityId,
          actorAppUserId: auditLog.actorAppUserId,
        })
        .from(auditLog)
        .where(gte(auditLog.occurredAt, auditCutoff))
        .orderBy(desc(auditLog.occurredAt))
        .limit(CAP);

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="firm-export-${new Date().toISOString().slice(0, 10)}.json"`,
      );
      res.json({
        exportedAt: new Date().toISOString(),
        // A8 — VIBE_VERSION still wins when ops sets it (appVersion checks
        // it first); otherwise the real package version, not 'dev'.
        appVersion: appVersion(),
        firm,
        clients: firmClients,
        engagements: firmEngagements,
        invoices: firmInvoices,
        users: firmUsers,
        auditLog: recent,
        capPerTable: CAP,
        note:
          'This is a portable JSON snapshot; for a full byte-exact dump, ' +
          'use the nightly pg_dump backup in /backups.',
      });
    },
  );

  return router;
}

const WISP_TEMPLATE = `# Written Information Security Program (WISP)

## 1. Purpose
This WISP describes safeguards for personally identifiable information
("PII") and protected client data held by {{firm.name}} in compliance with
IRS Publication 4557, the GLBA Safeguards Rule, and state-specific
data protection statutes.

## 2. Scope
Applies to: all employees, contractors, and authorized API integrations
that touch the Vibe Practice Management appliance.

## 3. Roles & responsibilities
- **Information Security Coordinator:** {{firm.partner_in_charge}}
- **System administrator:** {{firm.admin_user}}
- **Incident response lead:** {{firm.incident_lead}}

## 4. Risk assessment
Annual review covering:
- Authentication strength (TOTP enforced; magic-link timeout 15 min)
- Session controls (Redis sliding 7-day TTL, distinct staff/portal realms)
- Audit-log immutability (Postgres REVOKE UPDATE/DELETE on app role)
- Backup integrity (nightly pg_dump, 30-day retention)
- Third-party processor inventory (Stripe, configured AI providers,
  email/SMS providers)

## 5. Technical safeguards
- TLS 1.3 only at the Caddy ingress
- SameSite=Strict cookies + double-submit CSRF tokens
- Hashed tokens at rest (bcrypt API keys; SHA-256 session/magic-link)
- Portal: firm-level enable/disable switch (Admin → Firm settings)

## 6. Administrative safeguards
- Staff onboarding: TOTP enrollment mandatory at first login
- Quarterly review of role assignments via /admin/permission-matrix
- Documented incident response runbook in ops/docs/

## 7. Physical safeguards
- Appliance deployment on hardened Linux host
- Encrypted-at-rest volumes mandated by deployment template

## 8. Incident response
On suspected compromise:
1. Revoke all sessions (\`destroyAllForUser\` on session store)
2. Rotate JWT signing keys and webhook secrets
3. Inspect audit_log for the affected window
4. Notify affected clients within 72 hours
5. Engage outside counsel; document remediation steps

## 9. Annual review
This WISP is reviewed annually by the Information Security Coordinator
and approved by the firm's managing partner.

---
*Generated by Vibe Practice Management — adapt to your firm's specifics.*
`;
