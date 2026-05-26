// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Retainer notification helpers — Phase 6 + Phase 8 of the addendum.
//
// - notifyRetainerActivated: fires once when activation completes; one
//   email to the client billing contact + one to each assigned staff
//   member + the partner-in-charge.
//
// - notifyRetainerExhausted: fires once when an entry tips a retainer
//   from active → exhausted; same recipient set.
//
// Both helpers are best-effort: any per-recipient send failure logs
// and continues. They take a `send` dispatcher matching AppDeps'
// `sendStaffMail` signature so tests + console-mode dev just no-op
// without external IO.

import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  appUsers,
  clientContacts,
  clients,
  engagementAssignments,
  engagements,
  retainers,
} from '@vibe/db/schema';

import { logger } from '../logger';

export type RetainerMailDispatch = (args: {
  to: string;
  subject: string;
  body: string;
  html?: string;
}) => Promise<void>;

interface RetainerSummary {
  id: string;
  name: string;
  taxYear: number;
  returnType: string;
  tier: 'TIER_1' | 'TIER_2';
  hoursPurchased: number;
  hoursConsumed: number;
  expiryDate: string;
  clientId: string;
  clientName: string;
  engagementId: string;
}

async function loadSummary(db: Database, retainerId: string): Promise<RetainerSummary | null> {
  const [row] = await db
    .select({
      id: retainers.id,
      name: retainers.name,
      taxYear: retainers.taxYear,
      returnType: retainers.returnType,
      tier: retainers.tier,
      hoursPurchased: retainers.hoursPurchased,
      hoursConsumed: retainers.hoursConsumed,
      expiryDate: retainers.expiryDate,
      clientId: retainers.clientId,
      clientName: clients.name,
      engagementId: retainers.engagementId,
    })
    .from(retainers)
    .innerJoin(clients, eq(clients.id, retainers.clientId))
    .where(eq(retainers.id, retainerId))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    taxYear: row.taxYear,
    returnType: String(row.returnType),
    tier: row.tier as 'TIER_1' | 'TIER_2',
    hoursPurchased: Number(row.hoursPurchased),
    hoursConsumed: Number(row.hoursConsumed),
    expiryDate: String(row.expiryDate).slice(0, 10),
    clientId: row.clientId,
    clientName: row.clientName,
    engagementId: row.engagementId,
  };
}

async function billingContactEmail(db: Database, clientId: string): Promise<string | null> {
  const [billing] = await db
    .select({ email: clientContacts.email })
    .from(clientContacts)
    .where(and(eq(clientContacts.clientId, clientId), eq(clientContacts.isBilling, true)))
    .limit(1);
  if (billing?.email) return billing.email;
  const [primary] = await db
    .select({ email: clientContacts.email })
    .from(clientContacts)
    .where(and(eq(clientContacts.clientId, clientId), eq(clientContacts.isPrimary, true)))
    .limit(1);
  return primary?.email ?? null;
}

async function staffRecipientEmails(
  db: Database,
  engagementId: string,
  clientId: string,
): Promise<string[]> {
  const set = new Set<string>();
  // Partner-in-charge from the client.
  const [client] = await db
    .select({ partnerId: clients.partnerInChargeId })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (client?.partnerId) {
    const [u] = await db
      .select({ email: appUsers.email })
      .from(appUsers)
      .where(eq(appUsers.id, client.partnerId))
      .limit(1);
    if (u?.email) set.add(u.email);
  }
  // Engagement manager.
  const [eng] = await db
    .select({ managerId: engagements.managerId })
    .from(engagements)
    .where(eq(engagements.id, engagementId))
    .limit(1);
  if (eng?.managerId) {
    const [u] = await db
      .select({ email: appUsers.email })
      .from(appUsers)
      .where(eq(appUsers.id, eng.managerId))
      .limit(1);
    if (u?.email) set.add(u.email);
  }
  // All explicit engagement_assignment rows.
  const assigned = await db
    .select({ email: appUsers.email })
    .from(engagementAssignments)
    .innerJoin(appUsers, eq(appUsers.id, engagementAssignments.appUserId))
    .where(eq(engagementAssignments.engagementId, engagementId));
  for (const a of assigned) {
    if (a.email) set.add(a.email);
  }
  return [...set];
}

function tierLabel(tier: 'TIER_1' | 'TIER_2'): string {
  return tier === 'TIER_1' ? 'Tier 1' : 'Tier 2';
}

export async function notifyRetainerActivated(
  db: Database,
  retainerId: string,
  send: RetainerMailDispatch,
): Promise<void> {
  try {
    const summary = await loadSummary(db, retainerId);
    if (!summary) return;
    const clientEmail = await billingContactEmail(db, summary.clientId);
    const staffEmails = await staffRecipientEmails(db, summary.engagementId, summary.clientId);

    // Client-facing copy.
    if (clientEmail) {
      const subject = `Your TY${summary.taxYear} ${summary.returnType} retainer is active`;
      const body = [
        `Hello ${summary.clientName},`,
        '',
        `Thank you — your ${tierLabel(summary.tier)} retainer for your TY${summary.taxYear} ${summary.returnType} engagement is now active.`,
        '',
        `Hours purchased: ${summary.hoursPurchased.toFixed(2)}`,
        `Expires: ${summary.expiryDate} (unused hours forfeit on the expiry date).`,
        '',
        'You can review your retainer balance any time from the client portal.',
      ].join('\n');
      try {
        await send({ to: clientEmail, subject, body });
      } catch (err) {
        logger.warn({ err, retainerId, to: clientEmail }, 'retainer-activated client email failed');
      }
    }

    // Staff-facing copy.
    if (staffEmails.length > 0) {
      const subject = `Retainer activated — ${summary.clientName} · TY${summary.taxYear} ${summary.returnType}`;
      const body = [
        `${summary.clientName} just activated a ${tierLabel(summary.tier)} retainer.`,
        '',
        `Hours: ${summary.hoursPurchased.toFixed(2)} · Expires ${summary.expiryDate}`,
        '',
        'No action required — this is an FYI so you know retainer hours are now consumable on this engagement.',
      ].join('\n');
      for (const to of staffEmails) {
        try {
          await send({ to, subject, body });
        } catch (err) {
          logger.warn({ err, retainerId, to }, 'retainer-activated staff email failed');
        }
      }
    }

    logger.info(
      {
        retainerId,
        clientSent: Boolean(clientEmail),
        staffSent: staffEmails.length,
      },
      'retainer.activated notifications dispatched',
    );
  } catch (err) {
    logger.error({ err, retainerId }, 'notifyRetainerActivated failed');
  }
}

export async function notifyRetainerExhausted(
  db: Database,
  retainerId: string,
  send: RetainerMailDispatch,
): Promise<void> {
  try {
    const summary = await loadSummary(db, retainerId);
    if (!summary) return;
    const clientEmail = await billingContactEmail(db, summary.clientId);
    const staffEmails = await staffRecipientEmails(db, summary.engagementId, summary.clientId);

    if (clientEmail) {
      const subject = `Your TY${summary.taxYear} ${summary.returnType} retainer is fully consumed`;
      const body = [
        `Hello ${summary.clientName},`,
        '',
        `Your ${tierLabel(summary.tier)} retainer for your TY${summary.taxYear} ${summary.returnType} engagement has now been fully consumed.`,
        '',
        `Hours purchased: ${summary.hoursPurchased.toFixed(2)}`,
        '',
        'Any additional work on this engagement will be billed at standard rates. We will reach out before logging significant additional time so you have visibility.',
      ].join('\n');
      try {
        await send({ to: clientEmail, subject, body });
      } catch (err) {
        logger.warn({ err, retainerId, to: clientEmail }, 'retainer-exhausted client email failed');
      }
    }

    if (staffEmails.length > 0) {
      const subject = `Retainer exhausted — ${summary.clientName} · TY${summary.taxYear} ${summary.returnType}`;
      const body = [
        `The ${tierLabel(summary.tier)} retainer for ${summary.clientName} (TY${summary.taxYear} ${summary.returnType}) just hit zero remaining hours.`,
        '',
        `Hours purchased: ${summary.hoursPurchased.toFixed(2)}`,
        '',
        'Subsequent time on this engagement now routes to billable WIP. Confirm the client expects this before continuing significant additional work.',
      ].join('\n');
      for (const to of staffEmails) {
        try {
          await send({ to, subject, body });
        } catch (err) {
          logger.warn({ err, retainerId, to }, 'retainer-exhausted staff email failed');
        }
      }
    }

    logger.info(
      {
        retainerId,
        clientSent: Boolean(clientEmail),
        staffSent: staffEmails.length,
      },
      'retainer.exhausted notifications dispatched',
    );
  } catch (err) {
    logger.error({ err, retainerId }, 'notifyRetainerExhausted failed');
  }
}
