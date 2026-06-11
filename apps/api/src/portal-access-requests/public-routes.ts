// SPDX-License-Identifier: Elastic-2.0
//
// PUBLIC (unauthenticated) self-service portal access request. A visitor
// to the client portal enters an email/phone + a verification id (last-4
// SSN or entity EIN). If the contact matches a firm `person`, we queue ONE
// pending request per client that person is a contact of, for staff to
// review under Approvals.
//
// Enumeration-safe (QUESTIONS #29): the same generic 200 response is
// returned whether or not the contact matched, with the same Redis
// sliding-window rate limits as the portal login endpoint. Mounted OUTSIDE
// the portal auth chain (like /api/public/intake).

import { randomUUID } from 'node:crypto';
import express, { type Request, type Response, type Router } from 'express';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Redis } from 'ioredis';

import type { Database } from '@vibe/db';
import {
  clientContacts,
  clientPortalAccess,
  clients,
  firms,
  persons,
  portalAccessRequest,
  portalIdentity,
} from '@vibe/db/schema';
import { checkAndIncrement } from '@vibe/core/auth';
import { normalizeEmail, normalizePhone } from '@vibe/core/auth';

import { emitAudit } from '../auth/audit';
import { logger } from '../logger';

export interface PortalAccessRequestPublicDeps {
  db: Database | null;
  redis: Redis;
}

const GENERIC_RESPONSE = {
  ok: true,
  message: "Thanks — if your information matches our records, we'll review your request shortly.",
};

const Schema = z.object({
  contact: z.string().min(3).max(254),
  idType: z.enum(['SSN_LAST4', 'EIN']),
  idValue: z.string().min(1).max(40),
});

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}

// Validate the verification id's shape — the last 4 digits of the SSN or
// EIN. Bad shapes are rejected outright (a format error leaks nothing about
// whether the contact matched).
function normalizeIdValue(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  return digits.length === 4 ? digits : null;
}

export function createPortalAccessRequestPublicRouter(deps: PortalAccessRequestPublicDeps): Router {
  const router = express.Router();

  router.post('/', async (req: Request, res: Response) => {
    const parsed = Schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const idValue = normalizeIdValue(parsed.data.idValue);
    if (!idValue) {
      res.status(400).json({ error: 'invalid_id' });
      return;
    }
    const ip = clientIp(req);

    // Rate limits — Q29 (same shape as portal login).
    const ipLimit = await checkAndIncrement(deps.redis, {
      key: `rl:portal:access-request:ip:${ip}`,
      windowSeconds: 15 * 60,
      max: 20,
    });
    if (!ipLimit.allowed) {
      res.status(200).json(GENERIC_RESPONSE);
      return;
    }
    const contactKey = parsed.data.contact.trim().toLowerCase();
    const contactLimit = await checkAndIncrement(deps.redis, {
      key: `rl:portal:access-request:contact:${contactKey}`,
      windowSeconds: 15 * 60,
      max: 5,
    });
    if (!contactLimit.allowed) {
      res.status(200).json(GENERIC_RESPONSE);
      return;
    }

    if (!deps.db) {
      res.status(200).json(GENERIC_RESPONSE);
      return;
    }
    const db = deps.db;

    try {
      // Single-firm appliance — resolve the one firm.
      const [firm] = await db.select({ id: firms.id }).from(firms).limit(1);
      if (!firm) {
        res.status(200).json(GENERIC_RESPONSE);
        return;
      }
      const firmId = firm.id;

      // Match the contact to firm people (email is the canonical key;
      // phone is a digits-equality fallback). Never reveal the outcome.
      const isEmail = parsed.data.contact.includes('@');
      const email = isEmail ? normalizeEmail(parsed.data.contact) : null;
      const phone = !isEmail ? normalizePhone(parsed.data.contact) : null;
      const phoneDigits = phone ? phone.replace(/\D/g, '') : null;

      let matchedPersons: { id: string }[] = [];
      if (email) {
        matchedPersons = await db
          .select({ id: persons.id })
          .from(persons)
          .where(and(eq(persons.firmId, firmId), sql`lower(${persons.email}) = ${email}`));
      } else if (phoneDigits) {
        matchedPersons = await db
          .select({ id: persons.id })
          .from(persons)
          .where(
            and(
              eq(persons.firmId, firmId),
              sql`regexp_replace(coalesce(${persons.phone}, ${persons.mobile}, ''), '\\D', '', 'g') = ${phoneDigits}`,
            ),
          );
      }

      if (matchedPersons.length > 0) {
        const personIds = matchedPersons.map((p) => p.id);
        // Clients each matched person is a contact of (firm-scoped).
        const assoc = await db
          .select({
            personId: clientContacts.personId,
            contactId: clientContacts.id,
            clientId: clientContacts.clientId,
          })
          .from(clientContacts)
          .innerJoin(clients, eq(clients.id, clientContacts.clientId))
          .where(and(eq(clients.firmId, firmId), inArray(clientContacts.personId, personIds)));

        // Clients where the person already has ACTIVE portal access — skip.
        const activePairs = new Set<string>();
        if (assoc.length > 0) {
          const activeRows = await db
            .select({
              personId: portalIdentity.personId,
              clientId: clientPortalAccess.clientId,
            })
            .from(clientPortalAccess)
            .innerJoin(portalIdentity, eq(portalIdentity.id, clientPortalAccess.portalIdentityId))
            .where(
              and(
                inArray(portalIdentity.personId, personIds),
                eq(clientPortalAccess.status, 'ACTIVE'),
              ),
            );
          for (const r of activeRows)
            if (r.personId) activePairs.add(`${r.personId}:${r.clientId}`);
        }

        const submissionId = randomUUID();
        const rows = assoc
          .filter((a) => !activePairs.has(`${a.personId}:${a.clientId}`))
          .map((a) => ({
            firmId,
            submissionId,
            personId: a.personId,
            clientId: a.clientId,
            clientContactId: a.contactId,
            submittedEmail: email,
            submittedPhone: phone,
            idType: parsed.data.idType,
            idValue,
          }));

        if (rows.length > 0) {
          // onConflictDoNothing on the (person, client) WHERE PENDING unique
          // index makes re-submission idempotent.
          await db.insert(portalAccessRequest).values(rows).onConflictDoNothing();
          await emitAudit(db, {
            action: 'CREATE',
            entityType: 'portal_access_request',
            after: { submissionId, clients: rows.length },
            ip,
            userAgent: req.header('user-agent') ?? null,
          }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
        }
      }
    } catch (err) {
      // Fail closed to the generic response — never surface internals.
      logger.error({ err }, 'portal access-request submission failed');
    }

    res.status(200).json(GENERIC_RESPONSE);
  });

  return router;
}
