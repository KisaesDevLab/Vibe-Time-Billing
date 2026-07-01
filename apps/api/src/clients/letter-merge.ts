// SPDX-License-Identifier: Elastic-2.0
//
// Mail-merge: render a firm letter template personalized for one or more
// clients. Phase 1 output is a single combined PDF (one page-run per
// client). Reuses the invoice/statement template engine (so letters get
// {{ }} / {{#if}} / {{#each}} + CSS) and the same firm/client token
// conventions as the rest of the app.
//
// A letter template is an `engagement_letter_template` row (firm library,
// edited in Admin → Templates → Letter). Its `bodyHtml` may be a full
// HTML document (with its own <style>/@page for letterhead + page size);
// tokens are substituted in that HTML per client.

import { and, eq, inArray } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clientContacts, clients, engagementLetterTemplates, persons } from '@vibe/db/schema';
import { composeInvoiceHtml, escapeHtml, type TemplateContext } from '@vibe/core/invoicing';

import { formatMailingAddress } from './mailing-print';

export interface LetterTemplateLite {
  id: string;
  name: string;
  engagementTypeId: string | null;
}

/** Active letter templates for the merge picker. */
export async function listLetterTemplates(
  db: Database,
  firmId: string,
): Promise<LetterTemplateLite[]> {
  const rows = await db
    .select({
      id: engagementLetterTemplates.id,
      name: engagementLetterTemplates.name,
      engagementTypeId: engagementLetterTemplates.engagementTypeId,
      status: engagementLetterTemplates.status,
    })
    .from(engagementLetterTemplates)
    .where(eq(engagementLetterTemplates.firmId, firmId));
  return rows
    .filter((r) => r.status === 'ACTIVE')
    .map((r) => ({ id: r.id, name: r.name, engagementTypeId: r.engagementTypeId }));
}

/** Load one template's body, firm-scoped. Null when not found. */
export async function loadLetterTemplateBody(
  db: Database,
  firmId: string,
  templateId: string,
): Promise<{ name: string; bodyHtml: string } | null> {
  const [row] = await db
    .select({ name: engagementLetterTemplates.name, bodyHtml: engagementLetterTemplates.bodyHtml })
    .from(engagementLetterTemplates)
    .where(
      and(
        eq(engagementLetterTemplates.id, templateId),
        eq(engagementLetterTemplates.firmId, firmId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export interface ClientLetterData {
  id: string;
  name: string;
  clientFacingName: string | null;
  mailingStreet1: string | null;
  mailingStreet2: string | null;
  mailingCity: string | null;
  mailingState: string | null;
  mailingPostal: string | null;
  mailingCountry: string | null;
  primaryContactName: string | null;
}

/** Load the per-client data a letter needs (mailing address + primary
 *  contact name), firm-scoped, preserving the caller's id order. */
export async function loadClientLetterData(
  db: Database,
  firmId: string,
  clientIds: string[],
): Promise<ClientLetterData[]> {
  const rows = await db
    .select({
      id: clients.id,
      name: clients.name,
      clientFacingName: clients.clientFacingName,
      mailingStreet1: clients.mailingStreet1,
      mailingStreet2: clients.mailingStreet2,
      mailingCity: clients.mailingCity,
      mailingState: clients.mailingState,
      mailingPostal: clients.mailingPostal,
      mailingCountry: clients.mailingCountry,
    })
    .from(clients)
    .where(and(eq(clients.firmId, firmId), inArray(clients.id, clientIds)));
  if (rows.length === 0) return [];

  const contactRows = await db
    .select({
      clientId: clientContacts.clientId,
      fullName: persons.fullName,
      isPrimary: clientContacts.isPrimary,
      isBilling: clientContacts.isBilling,
      status: clientContacts.status,
    })
    .from(clientContacts)
    .innerJoin(persons, eq(persons.id, clientContacts.personId))
    .where(
      inArray(
        clientContacts.clientId,
        rows.map((r) => r.id),
      ),
    );
  const byClient = new Map<string, typeof contactRows>();
  for (const c of contactRows) {
    if (c.status !== 'ACTIVE') continue;
    const arr = byClient.get(c.clientId) ?? [];
    arr.push(c);
    byClient.set(c.clientId, arr);
  }
  const pickName = (clientId: string): string | null => {
    const cs = byClient.get(clientId) ?? [];
    const pick = cs.find((c) => c.isPrimary) || cs.find((c) => c.isBilling) || cs[0];
    return pick?.fullName ?? null;
  };

  const byId = new Map(rows.map((r) => [r.id, r]));
  // Preserve caller order; drop ids that weren't found / not in firm.
  return clientIds
    .map((id) => byId.get(id))
    .filter((r): r is (typeof rows)[number] => Boolean(r))
    .map((r) => ({ ...r, primaryContactName: pickName(r.id) }));
}

/** MM/DD/YYYY for the `today` token, in the server's local time. */
function todayUS(now: Date): string {
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${now.getFullYear()}`;
}

/** Build the template context for one client. `firm` is the shared
 *  `firmScope` record (fetched once per merge run). */
export function buildLetterContext(
  client: ClientLetterData,
  firm: Record<string, string>,
  now: Date,
): TemplateContext {
  const addressLines = formatMailingAddress(client); // \n-joined, '' when empty
  const addressHtml = addressLines
    .split('\n')
    .map((l) => escapeHtml(l))
    .join('<br>');
  const cityState = [client.mailingCity, client.mailingState].filter(Boolean).join(', ');
  const cityStateZip = [cityState, client.mailingPostal].filter(Boolean).join(' ');
  return {
    firm,
    today: todayUS(now),
    client: {
      name: client.name,
      display_name: (client.clientFacingName ?? '').trim() || client.name,
      primary_contact: client.primaryContactName ?? '',
      // Plain multi-line block (use with CSS `white-space: pre-line`) and a
      // ready <br> HTML variant (use via `{{{ client.address_block_html }}}`).
      mailing_address: addressLines,
      address_block_html: addressHtml,
      street1: client.mailingStreet1 ?? '',
      street2: client.mailingStreet2 ?? '',
      city: client.mailingCity ?? '',
      state: client.mailingState ?? '',
      postal: client.mailingPostal ?? '',
      country: client.mailingCountry ?? '',
      city_state_zip: cityStateZip,
    },
  };
}

/** Render one client's letter to a full HTML document. */
export function renderLetterHtml(
  bodyHtml: string,
  client: ClientLetterData,
  firm: Record<string, string>,
  now: Date,
): string {
  return composeInvoiceHtml(bodyHtml, '', buildLetterContext(client, firm, now));
}

// Token catalog — drives the editor variable picker + docs.
export interface LetterTokenEntry {
  token: string;
  label: string;
  raw?: boolean;
}
export const LETTER_TEMPLATE_TOKENS: LetterTokenEntry[] = [
  { token: 'client.name', label: 'Client legal name' },
  { token: 'client.display_name', label: 'Client display name' },
  { token: 'client.primary_contact', label: 'Primary contact name' },
  { token: 'client.mailing_address', label: 'Mailing address (use pre-line CSS)' },
  { token: 'client.address_block_html', label: 'Mailing address as HTML', raw: true },
  { token: 'client.street1', label: 'Street line 1' },
  { token: 'client.street2', label: 'Street line 2' },
  { token: 'client.city', label: 'City' },
  { token: 'client.state', label: 'State' },
  { token: 'client.postal', label: 'ZIP / postal' },
  { token: 'client.city_state_zip', label: 'City, State ZIP' },
  { token: 'firm.name', label: 'Firm name' },
  { token: 'firm.displayName', label: 'Firm display name' },
  { token: 'firm.support_email', label: 'Firm email' },
  { token: 'firm.support_phone', label: 'Firm phone' },
  { token: 'firm.support_web', label: 'Firm website' },
  { token: 'today', label: "Today's date (MM/DD/YYYY)" },
];
