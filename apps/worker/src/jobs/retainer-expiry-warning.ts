// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// R4-followup — delayed retainer expiry warning. Triggered by jobs the
// API enqueued at activation time (R3) and at manual activation (R7).
// Each stage (90/60/30/7 days before expiry) fires once. Defensive
// lookups skip when the retainer is no longer active/exhausted.

import { and, eq } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { Database } from '@vibe/db';
import { clientContacts, clients, retainers } from '@vibe/db/schema';

import type { MailDispatch } from '../dispatchers';

export interface ExpiryWarningJobPayload {
  retainerId: string;
  kind: '90d' | '60d' | '30d' | '7d';
}

export interface ExpiryWarningResult {
  sent: boolean;
  skipped?: 'retainer_missing' | 'retainer_terminal' | 'no_contact' | 'no_mail_provider';
}

export async function runRetainerExpiryWarning(
  db: Database,
  log: Logger,
  args: { sendEmail?: MailDispatch | undefined; portalBaseUrl?: string | undefined },
  payload: ExpiryWarningJobPayload,
): Promise<ExpiryWarningResult> {
  const [r] = await db
    .select({
      id: retainers.id,
      clientId: retainers.clientId,
      status: retainers.status,
      name: retainers.name,
      hoursPurchased: retainers.hoursPurchased,
      hoursConsumed: retainers.hoursConsumed,
      expiryDate: retainers.expiryDate,
      returnType: retainers.returnType,
      taxYear: retainers.taxYear,
    })
    .from(retainers)
    .where(eq(retainers.id, payload.retainerId))
    .limit(1);
  if (!r) {
    log.info({ retainerId: payload.retainerId, kind: payload.kind }, 'warning: missing — skip');
    return { sent: false, skipped: 'retainer_missing' };
  }
  if (r.status !== 'active' && r.status !== 'exhausted') {
    log.info(
      { retainerId: payload.retainerId, kind: payload.kind, status: r.status },
      'warning: terminal status — skip',
    );
    return { sent: false, skipped: 'retainer_terminal' };
  }
  const contactEmail = await resolveBillingEmail(db, r.clientId);
  if (!contactEmail) {
    log.info({ retainerId: payload.retainerId }, 'warning: no billing contact — skip');
    return { sent: false, skipped: 'no_contact' };
  }
  if (!args.sendEmail) {
    return { sent: false, skipped: 'no_mail_provider' };
  }
  const [client] = await db
    .select({ name: clients.name })
    .from(clients)
    .where(eq(clients.id, r.clientId))
    .limit(1);
  const base = args.portalBaseUrl ?? process.env['PORTAL_BASE_URL'] ?? 'https://portal.firm.com';
  const link = `${base.replace(/\/$/, '')}/portal/retainers`;
  const hoursRemaining = Number(r.hoursPurchased) - Number(r.hoursConsumed);
  const expiryIso = String(r.expiryDate).slice(0, 10);
  const subject = renderSubject(payload.kind, r.returnType, r.taxYear);
  const body = renderBody({
    kind: payload.kind,
    clientName: client?.name ?? 'Client',
    hoursRemaining,
    expiryDate: expiryIso,
    returnType: r.returnType,
    taxYear: r.taxYear,
    link,
  });
  await args.sendEmail({ to: contactEmail, subject, body });
  log.info(
    { retainerId: payload.retainerId, kind: payload.kind, to: contactEmail },
    'warning: sent',
  );
  return { sent: true };
}

async function resolveBillingEmail(db: Database, clientId: string): Promise<string | null> {
  const billing = await db
    .select({ email: clientContacts.email })
    .from(clientContacts)
    .where(and(eq(clientContacts.clientId, clientId), eq(clientContacts.isBilling, true)))
    .limit(1);
  if (billing[0]?.email) return billing[0].email;
  const primary = await db
    .select({ email: clientContacts.email })
    .from(clientContacts)
    .where(and(eq(clientContacts.clientId, clientId), eq(clientContacts.isPrimary, true)))
    .limit(1);
  return primary[0]?.email ?? null;
}

function renderSubject(
  kind: ExpiryWarningJobPayload['kind'],
  returnType: string,
  taxYear: number,
): string {
  const lead =
    kind === '7d'
      ? 'Final notice'
      : kind === '30d'
        ? '30-day reminder'
        : kind === '60d'
          ? '60-day reminder'
          : '90-day reminder';
  return `${lead} — TY${taxYear} ${returnType} retainer hours expire soon`;
}

function renderBody(args: {
  kind: ExpiryWarningJobPayload['kind'];
  clientName: string;
  hoursRemaining: number;
  expiryDate: string;
  returnType: string;
  taxYear: number;
  link: string;
}): string {
  const days = args.kind === '7d' ? 7 : args.kind === '30d' ? 30 : args.kind === '60d' ? 60 : 90;
  const lines = [
    `Hello ${args.clientName},`,
    '',
    `Your TY${args.taxYear} ${args.returnType} retainer expires on ${args.expiryDate} — about ${days} days away.`,
    `You have ${args.hoursRemaining.toFixed(2)} hours remaining on the retainer.`,
    '',
    'Unused hours forfeit on the expiry date. If you have any post-filing questions or follow-up work you have been putting off, now is a good time to bring them to us.',
    '',
    `View your retainer details: ${args.link}`,
  ];
  return lines.join('\n');
}
