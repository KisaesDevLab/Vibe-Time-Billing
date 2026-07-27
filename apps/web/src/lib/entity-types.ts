// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Business entity classification (clients.entity_type, migration 0212).
// Business-side counterpart to filing status: which legal/tax entity a
// BUSINESS client is, keyed to the IRS return it files. Shared by the
// client info card and the create-client wizard so the lists can't drift.

export const ENTITY_TYPES = [
  'SOLE_PROPRIETOR',
  'JOINT_VENTURE',
  'PARTNERSHIP_1065',
  'S_CORP_1120S',
  'C_CORP_1120',
  'EXEMPT_ORG_990',
  'TRUST_1041',
  'ESTATE_706',
  'GIFT_709',
  'OTHER',
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export const ENTITY_TYPE_LABELS: Record<EntityType, string> = {
  SOLE_PROPRIETOR: 'Sole proprietor (Sch C)',
  JOINT_VENTURE: 'Joint venture',
  PARTNERSHIP_1065: 'Partnership (1065)',
  S_CORP_1120S: 'S corporation (1120-S)',
  C_CORP_1120: 'C corporation (1120)',
  EXEMPT_ORG_990: 'Exempt organization (990)',
  TRUST_1041: 'Trust / fiduciary (1041)',
  ESTATE_706: 'Estate (706)',
  GIFT_709: 'Gift (709)',
  OTHER: 'Other',
};

export const ENTITY_TYPE_OPTIONS = ENTITY_TYPES.map((value) => ({
  value,
  label: ENTITY_TYPE_LABELS[value],
}));
