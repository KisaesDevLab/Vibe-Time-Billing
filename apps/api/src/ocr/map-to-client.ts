// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Capture Client Info — the JSON contract we ask GLM-OCR to return for an
// UltraTax CS "General Information" screen, plus the mapping from that
// contract into the shape the clients router accepts (ClientSchema in
// clients/routes.ts).
//
// SSN/EIN are intentionally absent from the schema and the prompt: tax IDs
// are stored one-way (portal/tax-id.ts) and staff enter them manually, so
// they never travel over the OCR wire or land in custom_fields.

import { z } from 'zod';

import { normalizeFilingStatus } from '../lib/filing-status';

// Every field optional; the model emits '' when a field is absent. We keep
// the shape permissive (default '') so a partial screen still validates and
// the human review step fills the gaps.
const str = z.string().default('');

export const ExtractedSchema = z.object({
  // One of 1040 / 1065 / 1120 / 1120S / 1041, or '' when the model can't tell.
  entityForm: str,
  clientName: str,
  firstName: str,
  middleInitial: str,
  lastName: str,
  spouseFirstName: str,
  spouseLastName: str,
  filingStatus: str,
  address1: str,
  city: str,
  state: str,
  zip: str,
  foreignCountry: str,
  foreignProvince: str,
  foreignPostal: str,
  stateOfIncorporation: str,
  dateIncorporated: str,
  dateSElection: str,
  businessActivity: str,
  businessCode: str,
  daytimePhone: str,
  eveningPhone: str,
  email: str,
  taxYearBegin: str,
  taxYearEnd: str,
});

export type ExtractedFields = z.infer<typeof ExtractedSchema>;

// The JSON-schema prompt handed to GLM-OCR. Schema clarity drives accuracy,
// so the field list is explicit and the SSN/EIN omission is deliberate.
export const SCHEMA_PROMPT = `You are reading an UltraTax CS "General Information" screen. Extract the fields into EXACTLY this JSON object and return ONLY the JSON (no prose, no code fences). Use an empty string for any field not visible. Do NOT include Social Security numbers or EINs even if they appear on screen.
{
  "entityForm": "",
  "clientName": "",
  "firstName": "",
  "middleInitial": "",
  "lastName": "",
  "spouseFirstName": "",
  "spouseLastName": "",
  "filingStatus": "",
  "address1": "",
  "city": "",
  "state": "",
  "zip": "",
  "foreignCountry": "",
  "foreignProvince": "",
  "foreignPostal": "",
  "stateOfIncorporation": "",
  "dateIncorporated": "",
  "dateSElection": "",
  "businessActivity": "",
  "businessCode": "",
  "daytimePhone": "",
  "eveningPhone": "",
  "email": "",
  "taxYearBegin": "",
  "taxYearEnd": ""
}`;

export type ClientType = 'INDIVIDUAL' | 'BUSINESS';
export type FilingStatus = 'SINGLE' | 'MFJ' | 'MFS' | 'HOH' | 'QW';

export interface DraftContact {
  name: string;
  email?: string;
  phone?: string;
}

// Subset of ClientSchema (clients/routes.ts) that the review UI pre-fills.
export interface MappedClient {
  name: string;
  clientType: ClientType;
  filingStatus?: FilingStatus;
  mailingStreet1?: string;
  mailingCity?: string;
  mailingState?: string;
  mailingPostal?: string;
  mailingCountry?: string;
  // Entity-specific fields with no dedicated column land here (no migration).
  customFields?: Record<string, string>;
}

export interface MappedIntake {
  client: MappedClient;
  contact: DraftContact | null;
}

// Only 1040 is an individual return; 1041 (estates/trusts), 1065, 1120,
// 1120S are all businesses in this two-value model. When the form is blank
// we fall back to name shape: a person with a last name reads as INDIVIDUAL.
function resolveClientType(x: ExtractedFields): ClientType {
  const form = x.entityForm.replace(/[^0-9a-z]/gi, '').toUpperCase();
  if (form.startsWith('1040')) return 'INDIVIDUAL';
  if (form) return 'BUSINESS';
  if (x.lastName.trim() && !x.clientName.trim()) return 'INDIVIDUAL';
  return 'BUSINESS';
}

function individualName(x: ExtractedFields): string {
  const last = x.lastName.trim();
  const first = [x.firstName.trim(), x.middleInitial.trim()].filter(Boolean).join(' ').trim();
  if (last && first) return `${last}, ${first}`;
  return last || first || x.clientName.trim();
}

export function mapExtractedToClient(x: ExtractedFields): MappedIntake {
  const clientType = resolveClientType(x);
  const name = clientType === 'INDIVIDUAL' ? individualName(x) : x.clientName.trim();

  const client: MappedClient = { name, clientType };

  if (clientType === 'INDIVIDUAL') {
    const fs = normalizeFilingStatus(x.filingStatus);
    if (fs) client.filingStatus = fs;
  }

  if (x.address1.trim()) client.mailingStreet1 = x.address1.trim();
  if (x.city.trim()) client.mailingCity = x.city.trim();
  if (x.state.trim()) client.mailingState = x.state.trim();
  if (x.zip.trim()) client.mailingPostal = x.zip.trim();
  if (x.foreignCountry.trim()) client.mailingCountry = x.foreignCountry.trim();

  // Overflow: entity-specific fields with no dedicated client column.
  const extras: Record<string, string> = {};
  const carry: Array<[string, string]> = [
    ['entityForm', x.entityForm],
    ['stateOfIncorporation', x.stateOfIncorporation],
    ['dateIncorporated', x.dateIncorporated],
    ['dateSElection', x.dateSElection],
    ['businessActivity', x.businessActivity],
    ['businessCode', x.businessCode],
    ['taxYearBegin', x.taxYearBegin],
    ['taxYearEnd', x.taxYearEnd],
    ['foreignProvince', x.foreignProvince],
    ['foreignPostal', x.foreignPostal],
  ];
  for (const [k, v] of carry) {
    if (v.trim()) extras[k] = v.trim();
  }
  if (Object.keys(extras).length > 0) client.customFields = extras;

  // Draft primary contact — the wizard POSTs this to /clients/:id/contacts.
  const contactName =
    clientType === 'INDIVIDUAL'
      ? [x.firstName.trim(), x.lastName.trim()].filter(Boolean).join(' ').trim()
      : x.clientName.trim();
  const phone = x.daytimePhone.trim() || x.eveningPhone.trim();
  const email = x.email.trim();
  const contact: DraftContact | null =
    contactName || phone || email
      ? {
          name: contactName || name,
          ...(email ? { email } : {}),
          ...(phone ? { phone } : {}),
        }
      : null;

  return { client, contact };
}
