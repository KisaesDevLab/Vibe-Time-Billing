// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Envelope / mailing-label direct print for a client (client dashboard
// "Envelope" / "Label" buttons). Unlike the route-sheet/receipt prints
// — which render a PDF in-process and POST it as a file — the addressing
// here reuses the Vibe Print gateway's OWN pre-formatted templates
// ("#10 Envelope", "Mailing Label 4x3"). We resolve the template id by
// name and POST only the address `data` (return_* / to_*); the gateway
// renders to the correct page size (9.5x4.125in envelope, 4x3in label).
//
// Return address = the client's office address + firm display name; the
// gateway template omits any field we leave blank.

import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clients, firms, firmSettings, offices } from '@vibe/db/schema';

import { listTemplates } from '../print-gateway/client';
import { resolvePrintGateway } from '../print-gateway/config';
import { sendGatewayTemplate } from '../print-gateway/send';

export type MailingKind = 'envelope' | 'label';

// Names of the gateway-shipped defaults (app/defaults.yaml in
// KisaesDevLab/Vibe-Printer). Matched case-insensitively against the
// gateway's template list at print time.
const TEMPLATE_NAME_BY_KIND: Record<MailingKind, string> = {
  envelope: '#10 Envelope',
  label: 'Mailing Label 4x3',
};

export interface PrintClientMailingInput {
  db: Database;
  firmId: string;
  clientId: string;
  kind: MailingKind;
  printerId: number;
  copies?: number;
}

export type PrintClientMailingResult =
  | { ok: true; jobId: string | null }
  | { ok: false; status: number; error: string };

/** Compose the multi-line recipient block from the client's structured
 *  mailing fields. Mirrors ClientInfoCard.formatAddress. Returns '' when
 *  no mailing field is set. Newlines render via the template's
 *  `white-space: pre-line`. */
export function formatMailingAddress(client: {
  mailingStreet1: string | null;
  mailingStreet2: string | null;
  mailingCity: string | null;
  mailingState: string | null;
  mailingPostal: string | null;
  mailingCountry: string | null;
}): string {
  const cityState = [client.mailingCity, client.mailingState]
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .join(', ');
  const cityStateZip = [cityState, (client.mailingPostal ?? '').trim()].filter(Boolean).join(' ');
  const country = (client.mailingCountry ?? '').trim();
  const isDomestic =
    country === '' || country.toUpperCase() === 'US' || country.toUpperCase() === 'USA';
  return [
    (client.mailingStreet1 ?? '').trim(),
    (client.mailingStreet2 ?? '').trim(),
    cityStateZip,
    isDomestic ? '' : country,
  ]
    .filter(Boolean)
    .join('\n');
}

export async function printClientMailing(
  input: PrintClientMailingInput,
): Promise<PrintClientMailingResult> {
  const { db, firmId, clientId, kind } = input;

  const [client] = await db
    .select({
      name: clients.name,
      clientFacingName: clients.clientFacingName,
      officeId: clients.officeId,
      mailingStreet1: clients.mailingStreet1,
      mailingStreet2: clients.mailingStreet2,
      mailingCity: clients.mailingCity,
      mailingState: clients.mailingState,
      mailingPostal: clients.mailingPostal,
      mailingCountry: clients.mailingCountry,
    })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.firmId, firmId)))
    .limit(1);
  if (!client) return { ok: false, status: 404, error: 'not_found' };

  const toAddress = formatMailingAddress(client);
  if (!toAddress) return { ok: false, status: 400, error: 'no_mailing_address' };

  // Return address: the client's office address + the firm display name.
  const [office] = client.officeId
    ? await db
        .select({ address: offices.address })
        .from(offices)
        .where(eq(offices.id, client.officeId))
        .limit(1)
    : [];
  const [firm] = await db
    .select({ name: firms.name })
    .from(firms)
    .where(eq(firms.id, firmId))
    .limit(1);
  const [cfg] = await db
    .select({ brandDisplayName: firmSettings.brandDisplayName })
    .from(firmSettings)
    .where(eq(firmSettings.firmId, firmId))
    .limit(1);

  const data = {
    return_name: (cfg?.brandDisplayName ?? '').trim() || firm?.name || '',
    return_address: (office?.address ?? '').trim(),
    to_name: (client.clientFacingName ?? '').trim() || client.name,
    to_address: toAddress,
  };

  const gateway = await resolvePrintGateway(db, firmId);
  if (!gateway) return { ok: false, status: 502, error: 'gateway_not_configured' };
  if (!gateway.enabled) return { ok: false, status: 502, error: 'gateway_disabled' };

  // Resolve the gateway-side template id by name (ids are gateway-local
  // auto-increments, so we cannot hard-code them).
  const wanted = TEMPLATE_NAME_BY_KIND[kind].toLowerCase();
  let templates;
  try {
    templates = await listTemplates(gateway);
  } catch {
    return { ok: false, status: 502, error: 'gateway_unreachable' };
  }
  const template = templates.find((t) => t.name.trim().toLowerCase() === wanted);
  if (!template)
    return { ok: false, status: 502, error: `template_not_found:${TEMPLATE_NAME_BY_KIND[kind]}` };

  const result = await sendGatewayTemplate({
    db,
    firmId,
    printableType: kind === 'envelope' ? 'client_envelope' : 'client_label',
    printableId: clientId,
    printerId: input.printerId,
    templateId: template.id,
    data,
    copies: input.copies ?? 1,
    gateway,
  });
  if (!result.ok) return { ok: false, status: 502, error: result.error };
  return { ok: true, jobId: result.jobId };
}
