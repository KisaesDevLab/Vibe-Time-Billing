// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Shared "grant or invite portal access" logic. Extracted from the
// portal-invites POST route so the self-service access-request approval
// flow (apps/api/src/portal-access-requests) reuses the exact same path:
//
//   - if a portal_identity already exists for the firm + email/phone,
//     attach an ACTIVE client_portal_access row (or backfill the contact
//     link) and notify them;
//   - otherwise create a portal_invitation + magic link to onboarding.
//
// Both call sites supply the client (already firm-scoped) and the actor.

import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  clientContacts,
  clientPortalAccess,
  persons,
  portalIdentity,
  portalInvitation,
} from '@vibe/db/schema';
import { normalizePhone } from '@vibe/core/auth';

import { emitAudit } from '../auth/audit';
import { recordOutbound } from '../clients/communications';
import { logger } from '../logger';
import { firmScope, renderTemplate } from '../notifications/templating';

type PortalRole = 'FULL' | 'VIEW_ONLY' | 'PAY_ONLY';

export interface GrantDeps {
  db: Database;
  sendEmail?: (args: { to: string; subject: string; body: string }) => Promise<void>;
  sendSms?: (args: { to: string; body: string }) => Promise<void>;
  portalBaseUrl: string;
}

export interface GrantArgs {
  firmId: string;
  client: { id: string; name: string };
  fullName: string;
  email?: string | null;
  /** Raw phone; normalized internally. */
  phone?: string | null;
  role: PortalRole;
  deliveryChannel: 'EMAIL' | 'SMS';
  /** 0221 — bulk invite "email and SMS": send on BOTH channels where a
   *  destination exists. deliveryChannel stays the stored/primary channel
   *  (the portal_channel enum has no BOTH value; resend + accept-flow
   *  verified-at logic key off the primary). */
  sendBoth?: boolean;
  clientContactId?: string;
  personId?: string;
  /** Staff user performing the grant (invite sender or request approver). */
  actorAppUserId: string;
  ip?: string | null;
  userAgent?: string | null;
}

export type GrantResult =
  | { ok: false; error: 'invalid_phone' }
  | {
      ok: true;
      deduped: boolean;
      identityId?: string;
      invitationId?: string;
      expiresAt?: Date;
    };

/**
 * Resolve which directory contact (if any) an access grant should link
 * to: the explicit contact when valid for this client, else a same-client
 * contact for the given person, else one whose email matches. Returns null
 * for a true 3rd party.
 */
export async function resolveContactLink(
  db: Database,
  clientId: string,
  explicitId: string | undefined,
  email: string | undefined | null,
  personId: string | undefined,
): Promise<string | null> {
  if (explicitId) {
    const [c] = await db
      .select({ id: clientContacts.id })
      .from(clientContacts)
      .where(and(eq(clientContacts.id, explicitId), eq(clientContacts.clientId, clientId)))
      .limit(1);
    if (c) return c.id;
  }
  if (personId) {
    const [c] = await db
      .select({ id: clientContacts.id })
      .from(clientContacts)
      .where(and(eq(clientContacts.personId, personId), eq(clientContacts.clientId, clientId)))
      .limit(1);
    if (c) return c.id;
  }
  if (email) {
    const [c] = await db
      .select({ id: clientContacts.id })
      .from(clientContacts)
      .innerJoin(persons, eq(persons.id, clientContacts.personId))
      .where(
        and(
          eq(clientContacts.clientId, clientId),
          sql`lower(${persons.email}) = ${email.toLowerCase()}`,
        ),
      )
      .limit(1);
    if (c) return c.id;
  }
  return null;
}

export async function grantOrInvitePortalAccess(
  deps: GrantDeps,
  args: GrantArgs,
): Promise<GrantResult> {
  const db = deps.db;
  const email = args.email ?? undefined;
  const normPhone = args.phone ? normalizePhone(args.phone) : null;
  if (args.phone && !normPhone) {
    return { ok: false, error: 'invalid_phone' };
  }

  // Dedup: same firm + same contact -> attach access to existing identity.
  let existingIdentity: { id: string } | null = null;
  if (email) {
    const [row] = await db
      .select({ id: portalIdentity.id })
      .from(portalIdentity)
      .where(and(eq(portalIdentity.firmId, args.firmId), eq(portalIdentity.primaryEmail, email)))
      .limit(1);
    if (row) existingIdentity = row;
  }
  if (!existingIdentity && normPhone) {
    const [row] = await db
      .select({ id: portalIdentity.id })
      .from(portalIdentity)
      .where(
        and(eq(portalIdentity.firmId, args.firmId), eq(portalIdentity.primaryPhone, normPhone)),
      )
      .limit(1);
    if (row) existingIdentity = row;
  }

  const contactLink = await resolveContactLink(
    db,
    args.client.id,
    args.clientContactId,
    email,
    args.personId,
  );

  if (existingIdentity) {
    const [already] = await db
      .select({ id: clientPortalAccess.id })
      .from(clientPortalAccess)
      .where(
        and(
          eq(clientPortalAccess.portalIdentityId, existingIdentity.id),
          eq(clientPortalAccess.clientId, args.client.id),
        ),
      )
      .limit(1);
    if (!already) {
      await db.insert(clientPortalAccess).values({
        portalIdentityId: existingIdentity.id,
        clientId: args.client.id,
        role: args.role,
        status: 'ACTIVE',
        invitedBy: args.actorAppUserId,
        invitedAt: new Date(),
        acceptedAt: new Date(),
        clientContactId: contactLink,
      });
    } else if (contactLink) {
      await db
        .update(clientPortalAccess)
        .set({ clientContactId: contactLink })
        .where(
          and(eq(clientPortalAccess.id, already.id), isNull(clientPortalAccess.clientContactId)),
        );
    }
    // 0115 — converge this login onto the firm person when asked and not
    // already linked (keeps one identity across contact + portal).
    if (args.personId) {
      await db
        .update(portalIdentity)
        .set({ personId: args.personId })
        .where(and(eq(portalIdentity.id, existingIdentity.id), isNull(portalIdentity.personId)));
    }
    await notifyExisting(deps, args);
    await emitAudit(db, {
      action: 'CREATE',
      entityType: 'client_portal_access',
      entityId: existingIdentity.id,
      actorAppUserId: args.actorAppUserId,
      after: { clientId: args.client.id, role: args.role, dedupedTo: existingIdentity.id },
      ip: args.ip ?? null,
      userAgent: args.userAgent ?? null,
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
    return { ok: true, deduped: true, identityId: existingIdentity.id };
  }

  // New invitation: token + magic link to onboarding.
  const rawToken = randomBytes(24).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  const [invitation] = await db
    .insert(portalInvitation)
    .values({
      firmId: args.firmId,
      clientId: args.client.id,
      invitedEmail: email ?? null,
      invitedPhone: normPhone,
      proposedFullName: args.fullName,
      proposedRole: args.role,
      deliveryChannel: args.deliveryChannel,
      tokenHash,
      invitedBy: args.actorAppUserId,
      expiresAt,
    })
    .returning({ id: portalInvitation.id });

  const link = `${deps.portalBaseUrl}/auth/accept?token=${encodeURIComponent(rawToken)}`;

  const firm = await firmScope(db, args.firmId);

  if ((args.deliveryChannel === 'EMAIL' || args.sendBoth) && email && deps.sendEmail) {
    const rendered = await renderTemplate({
      db,
      firmId: args.firmId,
      kind: 'portal_invite',
      channel: 'EMAIL',
      fallback: {
        subject: `Client portal invitation — ${args.client.name}`,
        body: `${args.fullName}, you've been invited to the ${args.client.name} client portal.\n\nAccept: ${link}\n\nLink expires in 7 days.`,
      },
      // Full token surface: seeded/firm templates reference {{contact.name}}
      // and {{portal.invite_url}} (unresolved tokens render as ''), so every
      // plausible alias is provided.
      context: {
        firm,
        link: { url: link },
        portal: { invite_url: link, url: link },
        contact: { name: args.fullName },
        person: { name: args.fullName },
        client: { name: args.client.name },
      },
    });
    const subject = rendered.subject ?? `Client portal invitation — ${args.client.name}`;
    const message = rendered.body;
    await deps
      .sendEmail({ to: email, subject, body: message })
      .catch((err: unknown) => logger.error({ err }, 'portal invite email failed'));
    await recordOutbound({
      db,
      firmId: args.firmId,
      clientId: args.client.id,
      channel: 'EMAIL',
      subject,
      body: message,
      relatedEntityType: 'portal_invitation',
      relatedEntityId: invitation?.id,
    }).catch(() => undefined);
  }
  if ((args.deliveryChannel === 'SMS' || args.sendBoth) && normPhone && deps.sendSms) {
    const rendered = await renderTemplate({
      db,
      firmId: args.firmId,
      kind: 'portal_invite',
      channel: 'SMS',
      fallback: { body: `Portal invite from ${args.client.name}: ${link}` },
      context: {
        firm,
        link: { url: link },
        portal: { invite_url: link, url: link },
        contact: { name: args.fullName },
        person: { name: args.fullName },
        client: { name: args.client.name },
      },
    });
    const smsBody = rendered.body;
    await deps
      .sendSms({ to: normPhone, body: smsBody })
      .catch((err: unknown) => logger.error({ err }, 'portal invite sms failed'));
    await recordOutbound({
      db,
      firmId: args.firmId,
      clientId: args.client.id,
      channel: 'SMS',
      body: smsBody,
      relatedEntityType: 'portal_invitation',
      relatedEntityId: invitation?.id,
    }).catch(() => undefined);
  }

  await emitAudit(db, {
    action: 'CREATE',
    entityType: 'portal_invitation',
    entityId: invitation?.id,
    actorAppUserId: args.actorAppUserId,
    after: { clientId: args.client.id, deliveryChannel: args.deliveryChannel, role: args.role },
    ip: args.ip ?? null,
    userAgent: args.userAgent ?? null,
  }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

  return { ok: true, deduped: false, invitationId: invitation?.id, expiresAt };
}

async function notifyExisting(deps: GrantDeps, args: GrantArgs): Promise<void> {
  const firm = await firmScope(deps.db, args.firmId);
  const link = { url: deps.portalBaseUrl };
  if ((args.deliveryChannel === 'EMAIL' || args.sendBoth) && args.email && deps.sendEmail) {
    const rendered = await renderTemplate({
      db: deps.db,
      firmId: args.firmId,
      kind: 'portal_invite',
      channel: 'EMAIL',
      fallback: {
        subject: `You've been added to ${args.client.name} in your portal`,
        body: `You now have access to ${args.client.name}. Sign in to the portal to view and pay invoices.`,
      },
      context: {
        firm,
        link,
        portal: { invite_url: link.url, url: link.url },
        contact: { name: args.fullName },
        person: { name: args.fullName },
        client: { name: args.client.name },
      },
    });
    const subject = rendered.subject ?? `You've been added to ${args.client.name} in your portal`;
    await deps
      .sendEmail({ to: args.email, subject, body: rendered.body })
      .catch((err: unknown) =>
        logger.warn({ err, channel: 'EMAIL' }, 'portal grant notify failed'),
      );
  }
  if ((args.deliveryChannel === 'SMS' || args.sendBoth) && args.phone && deps.sendSms) {
    const normPhone = normalizePhone(args.phone);
    if (normPhone) {
      const rendered = await renderTemplate({
        db: deps.db,
        firmId: args.firmId,
        kind: 'portal_invite',
        channel: 'SMS',
        fallback: {
          body: `You now have access to ${args.client.name}. Sign in to the portal to view and pay invoices.`,
        },
        context: {
          firm,
          link,
          portal: { invite_url: link.url, url: link.url },
          contact: { name: args.fullName },
          person: { name: args.fullName },
          client: { name: args.client.name },
        },
      });
      await deps
        .sendSms({ to: normPhone, body: rendered.body })
        .catch((err: unknown) =>
          logger.warn({ err, channel: 'SMS' }, 'portal grant notify failed'),
        );
    }
  }
}
